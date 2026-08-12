import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { NormalizedEvent } from "@/domain/schedule";
import {
  calendarEventDocumentId,
  createMemberStore,
  type CalendarConnectionRecord,
  type FirestoreBoundary,
  type FirestoreDocumentReference,
  type FirestoreDocumentSnapshot,
  type MemberStore,
  type SyncWriteGuard,
  type SyncStatusRecord,
  type UpdateMemberInput,
} from "./memberStore";

type StoredValue = Record<string, unknown>;
const NOW = "2026-08-11T09:00:00.000Z";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rejectUndefined(value: unknown): void {
  if (value === undefined) throw new Error("Fake Firestore does not accept undefined.");
  if (Array.isArray(value)) {
    value.forEach(rejectUndefined);
    return;
  }
  if (value && typeof value === "object") Object.values(value).forEach(rejectUndefined);
}

class FakeDocument implements FirestoreDocumentReference {
  constructor(
    readonly id: string,
    readonly collectionName: string,
    private readonly firestore: FakeFirestore,
  ) {}

  get(): Promise<FirestoreDocumentSnapshot> {
    return Promise.resolve(this.firestore.read(this.collectionName, this.id));
  }

  set(data: unknown): void {
    this.firestore.write(this.collectionName, this.id, data);
  }

  delete(): void {
    this.firestore.remove(this.collectionName, this.id);
  }
}

/**
 * Firestore同等のundefined拒否と、失敗時に書き込みを反映しないtransactionを担うテスト用Fake。
 * 実Firestoreへの接続やSDKモックを必要としない最小境界として使う。
 */
class FakeFirestore implements FirestoreBoundary {
  private collections = new Map<string, Map<string, StoredValue>>();
  private unavailableQueryDocuments = new Set<string>();
  private transactionTail: Promise<void> = Promise.resolve();
  private failingCollection: string | null = null;
  private failingBatchNumber: number | null = null;
  private committedBatches = 0;
  readonly batchSizes: number[] = [];
  readonly transactionByteSizes: number[] = [];
  readonly operationLog: string[] = [];

  collection(name: string) {
    const query = (filters: Array<{ field: string; operator: string; value: unknown }> = []) => ({
      where: (field: string, operator: string, value: unknown) => query([...filters, { field, operator, value }]),
      get: async () => ({
        docs: [...this.documents(name).entries()]
          .filter(([, value]) => filters.every((filter) => matchesFilter(value, filter)))
          .map(([id, value]) => ({
            id,
            data: () => this.unavailableQueryDocuments.has(`${name}/${id}`) ? undefined : clone(value),
          })),
      }),
    });
    return {
      doc: (id: string) => new FakeDocument(id, name, this),
      ...query(),
    };
  }

  batch() {
    const operations: Array<{ kind: "set" | "delete"; reference: FakeDocument; data?: unknown }> = [];
    return {
      set: (reference: FirestoreDocumentReference, data: unknown) => {
        operations.push({ kind: "set", reference: this.fakeDocument(reference), data });
      },
      delete: (reference: FirestoreDocumentReference) => {
        operations.push({ kind: "delete", reference: this.fakeDocument(reference) });
      },
      commit: async () => {
        this.committedBatches += 1;
        this.batchSizes.push(operations.length);
        if (this.failingBatchNumber === this.committedBatches) throw new Error("fake batch failure");
        const staged = cloneCollections(this.collections);
        for (const operation of operations) {
          const documents = staged.get(operation.reference.collectionName) ?? new Map<string, StoredValue>();
          staged.set(operation.reference.collectionName, documents);
          if (operation.kind === "set") {
            rejectUndefined(operation.data);
            documents.set(operation.reference.id, clone(operation.data as StoredValue));
            this.operationLog.push(`set:${operation.reference.collectionName}/${operation.reference.id}`);
          } else {
            documents.delete(operation.reference.id);
            this.operationLog.push(`delete:${operation.reference.collectionName}/${operation.reference.id}`);
          }
        }
        this.collections = staged;
      },
    };
  }

  async runTransaction<T>(operation: (transaction: {
    get(reference: FirestoreDocumentReference): Promise<FirestoreDocumentSnapshot>;
    set(reference: FirestoreDocumentReference, data: unknown): unknown;
    delete(reference: FirestoreDocumentReference): unknown;
  }) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release: () => void = () => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const staged = cloneCollections(this.collections);
    let hasWritten = false;
    const eventOperations: Array<{ log: string; reference: FakeDocument; data?: unknown }> = [];
    const read = (reference: FirestoreDocumentReference): FirestoreDocumentSnapshot => {
      if (hasWritten) throw new Error("Firestore transactions require all reads before writes.");
      const document = this.fakeDocument(reference);
      const value = (staged.get(document.collectionName) ?? new Map()).get(document.id);
      return { exists: value !== undefined, data: () => clone(value) };
    };
    const write = (reference: FirestoreDocumentReference, data: unknown): void => {
      hasWritten = true;
      const document = this.fakeDocument(reference);
      rejectUndefined(data);
      this.throwIfWriteFails(document.collectionName);
      const documents = staged.get(document.collectionName) ?? new Map<string, StoredValue>();
      staged.set(document.collectionName, documents);
      documents.set(document.id, clone(data as StoredValue));
      if (document.collectionName === "events") {
        eventOperations.push({ log: `set:${document.collectionName}/${document.id}`, reference: document, data });
      }
    };
    const remove = (reference: FirestoreDocumentReference): void => {
      hasWritten = true;
      const document = this.fakeDocument(reference);
      this.throwIfWriteFails(document.collectionName);
      const deletedData = staged.get(document.collectionName)?.get(document.id);
      staged.get(document.collectionName)?.delete(document.id);
      if (document.collectionName === "events") {
        eventOperations.push({
          log: `delete:${document.collectionName}/${document.id}`,
          reference: document,
          data: deletedData,
        });
      }
    };

    try {
      const result = await operation({ get: async (reference) => read(reference), set: write, delete: remove });
      if (eventOperations.length > 0) {
        this.committedBatches += 1;
        this.batchSizes.push(eventOperations.length);
        this.transactionByteSizes.push(eventOperations.reduce((total, item) => {
          const pathBytes = Buffer.byteLength(`${item.reference.collectionName}/${item.reference.id}`, "utf8");
          const dataBytes = item.data === undefined ? 0 : Buffer.byteLength(JSON.stringify(item.data), "utf8");
          return total + 1_024 + 2 * (pathBytes + dataBytes);
        }, 0));
        if (this.failingBatchNumber === this.committedBatches) throw new Error("fake batch failure");
        this.operationLog.push(...eventOperations.map((item) => item.log));
      }
      this.collections = staged;
      return result;
    } finally {
      release();
    }
  }

  seed(collectionName: string, id: string, value: StoredValue): void {
    this.documents(collectionName).set(id, clone(value));
  }

  documentIds(collectionName: string): string[] {
    return [...this.documents(collectionName).keys()];
  }

  failNextWrite(collectionName: string): void {
    this.failingCollection = collectionName;
  }

  failBatch(number: number): void {
    this.failingBatchNumber = number;
  }

  makeQueryDocumentDataUnavailable(collectionName: string, id: string): void {
    this.unavailableQueryDocuments.add(`${collectionName}/${id}`);
  }

  read(collectionName: string, id: string): FirestoreDocumentSnapshot {
    const value = this.documents(collectionName).get(id);
    return { exists: value !== undefined, data: () => clone(value) };
  }

  write(collectionName: string, id: string, value: unknown): void {
    rejectUndefined(value);
    this.throwIfWriteFails(collectionName);
    this.documents(collectionName).set(id, clone(value as StoredValue));
  }

  remove(collectionName: string, id: string): void {
    this.throwIfWriteFails(collectionName);
    this.documents(collectionName).delete(id);
  }

  private documents(collectionName: string): Map<string, StoredValue> {
    const existing = this.collections.get(collectionName);
    if (existing) return existing;
    const documents = new Map<string, StoredValue>();
    this.collections.set(collectionName, documents);
    return documents;
  }

  private fakeDocument(reference: FirestoreDocumentReference): FakeDocument {
    if (!(reference instanceof FakeDocument)) throw new Error("Unexpected document reference");
    return reference;
  }

  private throwIfWriteFails(collectionName: string): void {
    if (this.failingCollection !== collectionName) return;
    this.failingCollection = null;
    throw new Error("fake write failure");
  }
}

function matchesFilter(
  record: StoredValue,
  filter: { field: string; operator: string; value: unknown },
): boolean {
  const candidate = record[filter.field];
  if (filter.operator === "==") return candidate === filter.value;
  if (filter.operator === "in") return Array.isArray(filter.value) && filter.value.includes(candidate);
  if (filter.operator === "<") return typeof candidate === typeof filter.value && (candidate as number) < (filter.value as number);
  if (filter.operator === ">") return typeof candidate === typeof filter.value && (candidate as number) > (filter.value as number);
  if (filter.operator === ">=") return typeof candidate === "string" && typeof filter.value === "string" && candidate >= filter.value;
  throw new Error(`Unsupported fake query operator: ${filter.operator}`);
}

function cloneCollections(source: Map<string, Map<string, StoredValue>>): Map<string, Map<string, StoredValue>> {
  return new Map([...source.entries()].map(([name, values]) => [name, clone(values)]));
}

function createStore(ids = ["4d0da488-4a06-4f0f-8d1d-9ca2c55ccd8a"]) {
  const db = new FakeFirestore();
  let position = 0;
  return {
    db,
    store: createMemberStore(db, () => NOW, () => ids[position++] ?? `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`),
  };
}

async function createMember(store: ReturnType<typeof createStore>["store"], microsoftEmail = "Hanako.Sato@Example.COM") {
  return store.createMember({
    displayName: "  佐藤 花子  ",
    department: "  営業一課 ",
    microsoftEmail: `  ${microsoftEmail} `,
  });
}

function connection(memberId: string): CalendarConnectionRecord {
  return {
    memberId,
    revision: "11111111-1111-4111-8111-111111111111",
    googleSubject: "google-subject",
    googleEmail: "hanako@gmail.com",
    calendarId: "primary",
    encryptedRefreshToken: "encrypted-token",
    tokenIv: "iv",
    tokenAuthTag: "tag",
    connectedAt: NOW,
    updatedAt: NOW,
  };
}

async function syncGuard(store: MemberStore, current = NOW): Promise<SyncWriteGuard> {
  const lease = await store.acquireSyncLock(new Date(current));
  if (!lease) throw new Error("test lock unavailable");
  return { lease, now: () => new Date(current) };
}

function storedEvent(value: ReturnType<typeof normalizedEvent>) {
  const start = value.start.length === 10 ? `${value.start}T00:00:00.000+09:00` : value.start;
  const end = value.end.length === 10 ? `${value.end}T00:00:00.000+09:00` : value.end;
  return { ...value, startEpochMs: Date.parse(start), endEpochMs: Date.parse(end) };
}

function reconnectStatus(memberId: string): SyncStatusRecord {
  return {
    memberId,
    provider: "google",
    status: "error",
    lastStartedAt: NOW,
    lastSucceededAt: null,
    lastErrorCode: "reconnect_required",
    lastErrorMessage: "raw value is ignored",
    updatedAt: NOW,
  };
}

function normalizedEvent(
  memberId: string,
  source: "google" | "microsoft" | "teams",
  sourceEventId: string,
  start = "2026-08-12T01:00:00.000Z",
  end = "2026-08-12T02:00:00.000Z",
) {
  return {
    eventId: `${source}:${memberId}:${sourceEventId}`,
    source,
    sourceEventId,
    ownerUserId: memberId,
    ownerName: "佐藤",
    calendarId: source === "google" ? "primary" : "outlook",
    title: "訪問",
    location: "名古屋",
    start,
    end,
    isOnlineMeeting: source === "teams",
    visibility: "team" as const,
    updatedAt: NOW,
  };
}

describe("memberStore", () => {
  afterEach(() => vi.restoreAllMocks());

  it("OAuth stateを一度だけ消費し、期限切れも削除する", async () => {
    const { db, store } = createStore();
    const oauthMember = await createMember(store, "sato@example.com");
    const record = {
      memberId: oauthMember.id,
      browserNonceHash: "nonce-hash",
      startedByUid: "firebase-uid",
      microsoftEmail: "sato@example.com",
      createdAt: "2026-08-11T08:59:00.000Z",
      expiresAt: "2026-08-11T09:10:00.000Z",
    };
    await store.createOAuthState("state-hash", record);

    const persisted = db.read("oauthStates", "state-hash").data() as Record<string, unknown>;
    expect(persisted.createdAt).toBeInstanceOf(Date);
    expect(persisted.expiresAt).toBeInstanceOf(Date);

    await expect(store.consumeOAuthState("state-hash", "nonce-hash", NOW)).resolves.toEqual(record);
    await expect(store.consumeOAuthState("state-hash", "nonce-hash", NOW)).resolves.toBeNull();

    await store.createOAuthState("expired-hash", { ...record, expiresAt: "2026-08-11T08:59:59.000Z" });
    await expect(store.consumeOAuthState("expired-hash", "nonce-hash", NOW)).resolves.toBeNull();
    expect(db.documentIds("oauthStates")).toEqual([]);
  });

  it("nonce・開始identity不一致と壊れたOAuth stateを同一transactionでfail-closed削除する", async () => {
    const { db, store } = createStore();
    const oauthMember = await createMember(store, "sato@example.com");
    const valid = {
      memberId: oauthMember.id, browserNonceHash: "nonce-hash", startedByUid: "firebase-uid",
      microsoftEmail: "sato@example.com", createdAt: NOW, expiresAt: "2026-08-11T09:10:00.000Z",
    };
    db.seed("oauthStates", "wrong-nonce", { ...valid, createdAt: new Date(valid.createdAt), expiresAt: new Date(valid.expiresAt) });
    await expect(store.consumeOAuthState("wrong-nonce", "other-nonce", NOW)).resolves.toBeNull();

    db.seed("oauthStates", "wrong-email", { ...valid, microsoftEmail: "other@example.com", createdAt: new Date(valid.createdAt), expiresAt: new Date(valid.expiresAt) });
    await expect(store.consumeOAuthState("wrong-email", "nonce-hash", NOW)).resolves.toBeNull();

    db.seed("oauthStates", "bad-hash", { ...valid, createdAt: new Date(NOW), expiresAt: "not-date" });
    await expect(store.consumeOAuthState("bad-hash", "nonce-hash", NOW)).resolves.toBeNull();
    expect(db.documentIds("oauthStates")).toEqual([]);
  });

  it("Firestore Timestamp形状をISOへ正規化し、inactive化との競合を拒否する", async () => {
    const { db, store } = createStore();
    const oauthMember = await createMember(store, "sato@example.com");
    const timestampShape = (iso: string) => Timestamp.fromDate(new Date(iso));
    const state = {
      memberId: oauthMember.id, browserNonceHash: "nonce-hash", startedByUid: "firebase-uid",
      microsoftEmail: oauthMember.microsoftEmail, createdAt: timestampShape(NOW),
      expiresAt: timestampShape("2026-08-11T09:10:00.000Z"),
    };
    db.seed("oauthStates", "native-timestamp", state);

    await expect(store.consumeOAuthState("native-timestamp", "nonce-hash", NOW)).resolves.toEqual({
      ...state, createdAt: NOW, expiresAt: "2026-08-11T09:10:00.000Z",
    });

    db.seed("oauthStates", "inactive-state", state);
    await store.updateMember(oauthMember.id, { active: false });
    await expect(store.consumeOAuthState("inactive-state", "nonce-hash", NOW)).resolves.toBeNull();
    expect(db.documentIds("oauthStates")).toEqual([]);
  });

  it("作成時に入力を正規化し、公開IDへメール由来の値を使わない", async () => {
    const { db, store } = createStore();
    const member = await createMember(store);
    const emailHash = createHash("sha256").update("hanako.sato@example.com").digest("hex");

    expect(member).toMatchObject({
      id: "4d0da488-4a06-4f0f-8d1d-9ca2c55ccd8a",
      displayName: "佐藤 花子",
      department: "営業一課",
      microsoftEmail: "hanako.sato@example.com",
      active: true,
      microsoftSyncEnabled: true,
      googleConnectionStatus: "not_connected",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(member.id).not.toContain("@");
    expect(member.id).not.toContain("hanako.sato@example.com");
    expect(member.id).not.toContain(emailHash);
    expect(db.documentIds("memberEmailIndex")).toEqual([emailHash]);
  });

  it("同じ正規化済みMicrosoftメールアドレスの同時登録を一件だけにする", async () => {
    const { store } = createStore(["4d0da488-4a06-4f0f-8d1d-9ca2c55ccd8a", "82c119af-f8d2-4ca9-8dc3-2d2276215f6e"]);
    const input = { displayName: "佐藤", department: "営業", microsoftEmail: "sato@example.com" };
    const results = await Promise.allSettled([
      store.createMember(input),
      store.createMember({ ...input, microsoftEmail: " SATO@EXAMPLE.COM " }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: "同じMicrosoftメールアドレスのメンバーは既に登録されています。" }),
    });
  });

  it("空文字・不正メール・型偽装入力を日本語で拒否する", async () => {
    const { store } = createStore();
    await expect(store.createMember({ displayName: " ", department: "営業", microsoftEmail: "sato@example.com" })).rejects.toThrow("表示名を入力してください。");
    await expect(store.createMember({ displayName: "佐藤", department: " ", microsoftEmail: "sato@example.com" })).rejects.toThrow("部署名を入力してください。");
    await expect(store.createMember({ displayName: "佐藤", department: "営業", microsoftEmail: "invalid" })).rejects.toThrow("Microsoftメールアドレスの形式が正しくありません。");
    await expect(store.createMember({ displayName: 42, department: "営業", microsoftEmail: "sato@example.com" } as never)).rejects.toThrow("表示名は文字列で入力してください。");
  });

  it("一覧を安定して並べ替え、壊れたメンバー文書を拒否する", async () => {
    const { db, store } = createStore(["1", "2", "3"]);
    const suzuki = await store.createMember({ displayName: "鈴木", department: "営業", microsoftEmail: "suzuki@example.com" });
    const abe = await store.createMember({ displayName: "阿部", department: "営業", microsoftEmail: "abe@example.com" });
    const ito = await store.createMember({ displayName: "伊藤", department: "営業", microsoftEmail: "ito@example.com" });
    expect((await store.listMembers()).map((member) => member.displayName)).toEqual(["阿部", "伊藤", "鈴木"]);

    db.seed("salesMembers", suzuki.id, { ...suzuki, displayName: undefined } as never);
    await expect(store.listMembers()).rejects.toThrow("Firestore data is invalid: member.displayName");
    db.seed("salesMembers", suzuki.id, { ...suzuki, id: "other-id" });
    await expect(store.listMembers()).rejects.toThrow("Firestore data is invalid: member.id");
    void abe;
    void ito;
  });

  it("email index経由で有効メンバーを取得し、inactiveと壊れたindexを扱う", async () => {
    const { db, store } = createStore(["4d0da488-4a06-4f0f-8d1d-9ca2c55ccd8a", "82c119af-f8d2-4ca9-8dc3-2d2276215f6e"]);
    const member = await createMember(store, "takahashi@example.com");
    await expect(store.findActiveMemberByMicrosoftEmail(" TAKAHASHI@example.com ")).resolves.toEqual(member);
    await store.updateMember(member.id, { active: false });
    await expect(store.findActiveMemberByMicrosoftEmail("takahashi@example.com")).resolves.toBeNull();
    await store.updateMember(member.id, { active: true });

    db.seed("salesMembers", member.id, { ...member, active: "false" });
    await expect(store.findActiveMemberByMicrosoftEmail("takahashi@example.com")).rejects.toThrow("Firestore data is invalid: member.active");
    db.seed("salesMembers", member.id, { ...member });
    const other = await createMember(store, "other@example.com");
    db.seed("memberEmailIndex", createHash("sha256").update("takahashi@example.com").digest("hex"), { memberId: other.id, microsoftEmail: "takahashi@example.com" });
    await expect(store.findActiveMemberByMicrosoftEmail("takahashi@example.com")).rejects.toThrow("Firestore data is invalid: member.microsoftEmail");
    db.seed("memberEmailIndex", createHash("sha256").update("takahashi@example.com").digest("hex"), { microsoftEmail: "takahashi@example.com" });
    await expect(store.findActiveMemberByMicrosoftEmail("takahashi@example.com")).rejects.toThrow("Firestore data is invalid: memberEmailIndex.memberId");
  });

  it("許可されたメンバー項目だけを更新し、型偽装値を拒否する", async () => {
    const { store } = createStore();
    const member = await createMember(store, "takahashi@example.com");
    const updated = await store.updateMember(member.id, {
      displayName: "  高橋 太郎 ", department: " 法人営業 ", active: false, microsoftSyncEnabled: false,
      unknown: "ignored",
    } as unknown as UpdateMemberInput);
    expect(updated).toMatchObject({ displayName: "高橋 太郎", department: "法人営業", active: false, microsoftSyncEnabled: false, microsoftEmail: "takahashi@example.com" });
    expect(updated).not.toHaveProperty("unknown");
    await expect(store.updateMember(member.id, { active: "false" } as never)).rejects.toThrow("activeはtrueまたはfalseで入力してください。");
    await expect(store.updateMember(member.id, { microsoftSyncEnabled: null } as never)).rejects.toThrow("microsoftSyncEnabledはtrueまたはfalseで入力してください。");
    await expect(store.updateMember("missing", { active: false })).rejects.toThrow("指定されたメンバーが見つかりません。");
  });

  it("更新入力型には不変項目を含めない", () => {
    expectTypeOf<keyof UpdateMemberInput>().toEqualTypeOf<"displayName" | "department" | "active" | "microsoftSyncEnabled">();
  });

  it("接続の保存・削除をメンバー接続状態と原子的に反映する", async () => {
    const { db, store } = createStore();
    const member = await createMember(store);
    const record = connection(member.id);
    db.failNextWrite("calendarConnections");
    const authorization = { memberId: member.id, microsoftEmail: member.microsoftEmail, startedByUid: "firebase-uid" };
    await expect(store.saveConnection(record, authorization)).rejects.toThrow("fake write failure");
    await expect(store.getConnection(member.id)).resolves.toBeNull();
    expect((await store.listMembers())[0].googleConnectionStatus).toBe("not_connected");

    await store.saveConnection(record, authorization);
    await expect(store.getConnection(member.id)).resolves.toEqual(record);
    expect((await store.listMembers())[0].googleConnectionStatus).toBe("connected");
    await store.deleteConnection(member.id);
    await expect(store.getConnection(member.id)).resolves.toBeNull();
    expect((await store.listMembers())[0].googleConnectionStatus).toBe("not_connected");
  });

  it("接続保存時にmember active・state member/email整合を再確認する", async () => {
    const { store } = createStore();
    const member = await createMember(store, "sato@example.com");
    const record = connection(member.id);
    const authorization = { memberId: member.id, microsoftEmail: member.microsoftEmail, startedByUid: "firebase-uid" };

    await expect(store.saveConnection(record, { ...authorization, microsoftEmail: "other@example.com" })).rejects.toThrow("Google OAuth authorization is invalid.");
    await store.updateMember(member.id, { active: false });
    await expect(store.saveConnection(record, authorization)).rejects.toThrow("Google OAuth authorization is invalid.");
  });

  it("connection文書の欠落フィールドを明示エラーにする", async () => {
    const { db, store } = createStore();
    db.seed("calendarConnections", "member_abc", { ...connection("member_abc"), tokenAuthTag: undefined } as never);
    await expect(store.getConnection("member_abc")).rejects.toThrow("Firestore data is invalid: calendarConnection.tokenAuthTag");
  });

  it("再接続要求だけを明示的に設定でき、接続状態を汎用的に外部変更できない", async () => {
    const { store } = createStore();
    const member = await createMember(store);
    await store.saveConnection(connection(member.id), {
      memberId: member.id,
      microsoftEmail: member.microsoftEmail,
      startedByUid: "firebase-uid",
    });
    const guard = await syncGuard(store);
    await store.saveGoogleReconnectFailure(reconnectStatus(member.id), guard, connection(member.id).revision);
    expect((await store.listMembers())[0].googleConnectionStatus).toBe("reconnect_required");
    expect(await store.getSyncStatuses(member.id)).toEqual([
      expect.objectContaining({
        status: "error",
        lastErrorCode: "reconnect_required",
        lastErrorMessage: "Google Calendarの再接続が必要です。",
      }),
    ]);
    expect(store).not.toHaveProperty("setGoogleConnectionStatus");
    expectTypeOf<MemberStore>().not.toHaveProperty("setGoogleConnectionStatus");
    expectTypeOf<MemberStore>().toHaveProperty("saveGoogleReconnectFailure");
  });

  it("Google再接続状態とsafe syncStatusを同一transactionでrollbackする", async () => {
    const { db, store } = createStore();
    const member = await createMember(store);
    await store.saveConnection(connection(member.id), {
      memberId: member.id,
      microsoftEmail: member.microsoftEmail,
      startedByUid: "firebase-uid",
    });
    const guard = await syncGuard(store);
    db.failNextWrite("syncStatus");

    await expect(store.saveGoogleReconnectFailure(
      reconnectStatus(member.id),
      guard,
      connection(member.id).revision,
    )).rejects.toThrow("fake write failure");

    expect((await store.listMembers())[0].googleConnectionStatus).toBe("connected");
    expect(await store.getSyncStatuses(member.id)).toEqual([]);
  });

  it("接続解除との競合後はreconnect_requiredへ戻さずnot_connectedを維持する", async () => {
    const { store } = createStore();
    const member = await createMember(store);
    const authorization = { memberId: member.id, microsoftEmail: member.microsoftEmail, startedByUid: "firebase-uid" };
    await store.saveConnection(connection(member.id), authorization);
    await store.deleteConnection(member.id);

    const guard = await syncGuard(store);
    await expect(store.saveGoogleReconnectFailure(reconnectStatus(member.id), guard, connection(member.id).revision))
      .rejects.toThrow("Googleカレンダー接続が更新されました。");

    expect((await store.listMembers())[0].googleConnectionStatus).toBe("not_connected");
    await expect(store.getConnection(member.id)).resolves.toBeNull();
    expect(await store.getSyncStatuses(member.id)).toEqual([]);
  });

  it("同期状態のundefinedをnull化し、未知codeと生エラー文を固定sync_failedへ置換する", async () => {
    const { db, store } = createStore();
    const raw = `Bearer secret-token person@gmail.com https://provider.invalid/${"a".repeat(600)}`;
    const status: SyncStatusRecord = {
      memberId: "member_abc", provider: "google", status: "error", lastStartedAt: NOW,
      lastSucceededAt: undefined, lastErrorCode: "raw_provider_code", lastErrorMessage: raw, updatedAt: NOW,
    };
    await store.saveSyncStatus(status, await syncGuard(store));
    const saved = (await store.getSyncStatuses())[0];
    expect(saved).toMatchObject({
      lastSucceededAt: null,
      lastErrorCode: "sync_failed",
      lastErrorMessage: "カレンダーの同期に失敗しました。次回の同期で再試行します。",
    });
    expect(JSON.stringify(saved)).not.toContain(raw);
    expect(JSON.stringify(saved)).not.toContain("secret-token");
    expect((await db.collection("syncStatus").doc("member_abc_google").get()).data()).not.toHaveProperty("undefined");

    db.seed("syncStatus", "bad", { memberId: "member_abc", status: "success", lastStartedAt: NOW, lastSucceededAt: null, lastErrorCode: null, lastErrorMessage: null, updatedAt: NOW });
    await expect(store.getSyncStatuses()).rejects.toThrow("Firestore data is invalid: syncStatus.provider");
  });

  it("既知codeも呼び出し元messageを信用せず、allowlist固定文だけを保存する", async () => {
    const { store } = createStore();
    await store.saveSyncStatus({
      memberId: "member_abc",
      provider: "microsoft",
      status: "error",
      lastStartedAt: NOW,
      lastSucceededAt: null,
      lastErrorCode: "permission_denied",
      lastErrorMessage: "Bearer raw-token user@example.com",
      updatedAt: NOW,
    }, await syncGuard(store));
    await expect(store.getSyncStatuses()).resolves.toEqual([
      expect.objectContaining({
        lastErrorCode: "permission_denied",
        lastErrorMessage: "Microsoftカレンダーの読み取り権限を確認してください。",
      }),
    ]);
  });

  it("memberId指定の同期状態queryは無関係な壊れた文書を読まない", async () => {
    const { db, store } = createStore();
    db.seed("syncStatus", "member-1_google", {
      memberId: "member-1", provider: "google", status: "success", lastStartedAt: NOW,
      lastSucceededAt: NOW, lastErrorCode: null, lastErrorMessage: null, updatedAt: NOW,
    });
    db.seed("syncStatus", "other_google", {
      memberId: "other", provider: "raw-provider", status: "success", lastStartedAt: NOW,
      lastSucceededAt: NOW, lastErrorCode: null, lastErrorMessage: null, updatedAt: NOW,
    });

    await expect(store.getSyncStatuses("member-1")).resolves.toEqual([
      expect.objectContaining({ memberId: "member-1", provider: "google" }),
    ]);
  });

  it("同期状態のmemberIdと日時をruntime検証して不正な文書path・日時を拒否する", async () => {
    const { store } = createStore();
    const base: SyncStatusRecord = {
      memberId: "member_abc",
      provider: "google",
      status: "success",
      lastStartedAt: NOW,
      lastSucceededAt: NOW,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: NOW,
    };
    const guard = await syncGuard(store);
    await expect(store.saveSyncStatus({ ...base, memberId: "member/escape" }, guard))
      .rejects.toThrow("同期予定データが正しくありません。");
    await expect(store.saveSyncStatus({ ...base, lastSucceededAt: "not-a-date" }, guard))
      .rejects.toThrow("Firestore data is invalid: syncStatus.lastSucceededAt");
  });

  it("モジュールのimport時にFirestore初期化関数を呼ばない", async () => {
    vi.resetModules();
    const getAdminFirestore = vi.fn();
    vi.doMock("@/lib/firebase/admin", () => ({ getAdminFirestore }));
    await import("./memberStore");
    expect(getAdminFirestore).not.toHaveBeenCalled();
  });

  it("期限付きglobal lockをtransactionで取得し、旧ownerは新ownerのlockを解放しない", async () => {
    const db = new FakeFirestore();
    const first = createMemberStore(db, () => NOW, () => "member-1", () => "lease-first");
    const second = createMemberStore(db, () => NOW, () => "member-2", () => "lease-second");

    await expect(first.acquireSyncLock(new Date(NOW))).resolves.toEqual({ ownerId: "lease-first", fence: 1 });
    await expect(second.acquireSyncLock(new Date("2026-08-11T09:09:59.999Z"))).resolves.toBeNull();
    await expect(second.acquireSyncLock(new Date("2026-08-11T09:10:00.000Z"))).resolves.toEqual({ ownerId: "lease-second", fence: 2 });

    await first.releaseSyncLock({ ownerId: "lease-first", fence: 1 });
    const afterOldRelease = db.read("syncLocks", "calendar-sync");
    expect(afterOldRelease.exists).toBe(true);
    expect(afterOldRelease.data()).toMatchObject({ ownerId: "lease-second" });

    await second.releaseSyncLock({ ownerId: "lease-second", fence: 2 });
    expect(db.read("syncLocks", "calendar-sync").data()).toMatchObject({ ownerId: null, fence: 2 });
  });

  it("同じstore instanceでも期限切れlockを奪った新runを旧leaseが解放しない", async () => {
    const db = new FakeFirestore();
    const leaseIds = ["lease-first", "lease-second"];
    const store = createMemberStore(db, () => NOW, () => "member", () => leaseIds.shift() ?? "lease-next");
    const firstLease = await store.acquireSyncLock(new Date(NOW));
    const secondLease = await store.acquireSyncLock(new Date("2026-08-11T09:10:00.000Z"));
    expect(firstLease).toEqual({ ownerId: "lease-first", fence: 1 });
    expect(secondLease).toEqual({ ownerId: "lease-second", fence: 2 });

    await store.releaseSyncLock(firstLease!);
    expect(db.read("syncLocks", "calendar-sync").data()).toMatchObject({ ownerId: "lease-second" });
    await store.releaseSyncLock(secondLease!);
    expect(db.read("syncLocks", "calendar-sync").data()).toMatchObject({ ownerId: null, fence: 2 });
  });

  it("期限切れlockを新runが奪った後は旧runのstatus・予定・再接続書込みを全て拒否する", async () => {
    const db = new FakeFirestore();
    const leaseIds = ["lease-old", "lease-new"];
    const store = createMemberStore(db, () => NOW, () => "member-1", () => leaseIds.shift() ?? "lease-next");
    const member = await createMember(store);
    await store.saveConnection(connection(member.id), {
      memberId: member.id, microsoftEmail: member.microsoftEmail, startedByUid: "uid",
    });
    const oldLease = await store.acquireSyncLock(new Date(NOW));
    const newLease = await store.acquireSyncLock(new Date("2026-08-11T09:10:00.000Z"));
    expect(oldLease).toEqual({ ownerId: "lease-old", fence: 1 });
    expect(newLease).toEqual({ ownerId: "lease-new", fence: 2 });
    const oldGuard = { lease: oldLease!, now: () => new Date("2026-08-11T09:10:00.001Z") };
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };

    await expect(store.saveSyncStatus({
      memberId: member.id, provider: "google", status: "success", lastStartedAt: NOW,
      lastSucceededAt: NOW, lastErrorCode: null, lastErrorMessage: null, updatedAt: NOW,
    }, oldGuard, connection(member.id).revision)).rejects.toBeInstanceOf(Error);
    await expect(store.replaceProviderEvents(member.id, "google", range, [
      normalizedEvent(member.id, "google", "old-result"),
    ], oldGuard, connection(member.id).revision)).rejects.toThrow("同期ロックが失効しました。");
    await expect(store.saveGoogleReconnectFailure(reconnectStatus(member.id), oldGuard, connection(member.id).revision))
      .rejects.toThrow("同期ロックが失効しました。");
    expect(db.documentIds("events")).toEqual([]);
    expect(db.documentIds("syncStatus")).toEqual([]);

    await store.releaseSyncLock(oldLease!);
    expect(db.read("syncLocks", "calendar-sync").data()).toMatchObject({ ownerId: "lease-new", fence: 2 });
  });

  it("heartbeatは同じleaseだけを延長し、期限切れ・別fenceを拒否する", async () => {
    const db = new FakeFirestore();
    const store = createMemberStore(db, () => NOW, () => "member", () => "lease");
    const lease = await store.acquireSyncLock(new Date(NOW));
    await store.renewSyncLock(lease!, new Date("2026-08-11T09:09:00.000Z"));
    expect(db.read("syncLocks", "calendar-sync").data()).toMatchObject({
      ownerId: "lease", fence: 1, expiresAt: new Date("2026-08-11T09:19:00.000Z"),
    });
    await expect(store.renewSyncLock({ ownerId: "lease", fence: 2 }, new Date("2026-08-11T09:10:00.000Z")))
      .rejects.toThrow("同期ロックが失効しました。");
    await expect(store.renewSyncLock(lease!, new Date("2026-08-11T09:19:00.000Z")))
      .rejects.toThrow("同期ロックが失効しました。");
  });

  it("Google切断・別接続・token rotation後は旧revisionの結果を保存しない", async () => {
    const { db, store } = createStore();
    const member = await createMember(store);
    const authorization = { memberId: member.id, microsoftEmail: member.microsoftEmail, startedByUid: "uid" };
    await store.saveConnection(connection(member.id), authorization);
    const guard = await syncGuard(store);
    await store.deleteConnection(member.id);
    await store.saveConnection({
      ...connection(member.id),
      revision: "22222222-2222-4222-8222-222222222222",
      googleSubject: "new-subject",
    }, authorization);
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };

    await expect(store.replaceProviderEvents(member.id, "google", range, [
      normalizedEvent(member.id, "google", "old-account-event"),
    ], guard, connection(member.id).revision)).rejects.toThrow("Googleカレンダー接続が更新されました。");
    await expect(store.saveGoogleReconnectFailure(reconnectStatus(member.id), guard, connection(member.id).revision))
      .rejects.toThrow("Googleカレンダー接続が更新されました。");
    await expect(store.saveSyncStatus({
      memberId: member.id, provider: "google", status: "error", lastStartedAt: NOW,
      lastSucceededAt: null, lastErrorCode: "reconnect_required", lastErrorMessage: "raw",
      updatedAt: NOW,
    }, guard, connection(member.id).revision)).rejects.toThrow("Googleカレンダー接続が更新されました。");
    expect(db.documentIds("events")).toEqual([]);
    expect((await store.listMembers())[0].googleConnectionStatus).toBe("connected");
    expect(await store.getSyncStatuses(member.id)).toEqual([]);
  });

  it("provider予定をSHA-256文書IDでupsert後にstale削除し、範囲外・別member/providerを保持する", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const incoming = normalizedEvent("member-1", "google", `path/with/slash?and=long-${"x".repeat(900)}`);
    const stale = normalizedEvent("member-1", "google", "stale");
    const overlappingStale = normalizedEvent(
      "member-1",
      "google",
      "overlap-stale",
      "2026-07-12T08:00:00.000Z",
      "2026-07-12T10:00:00.000Z",
    );
    const offsetBoundaryStale = normalizedEvent(
      "member-1",
      "google",
      "offset-boundary-stale",
      "2027-02-07T17:30:00+09:00",
      "2027-02-07T18:30:00+09:00",
    );
    const outside = normalizedEvent("member-1", "google", "outside", "2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z");
    const microsoft = normalizedEvent("member-1", "microsoft", "microsoft-stays");
    const other = normalizedEvent("member-2", "google", "other-stays");
    for (const existing of [stale, overlappingStale, offsetBoundaryStale, outside, microsoft, other]) {
      db.seed("events", calendarEventDocumentId(existing.eventId), storedEvent(existing));
    }

    await store.replaceProviderEvents("member-1", "google", range, [incoming], await syncGuard(store));

    const expectedId = createHash("sha256").update(incoming.eventId).digest("hex");
    expect(expectedId).toMatch(/^[a-f0-9]{64}$/);
    expect(expectedId).not.toContain("/");
    expect(db.documentIds("events")).toEqual(expect.arrayContaining([
      expectedId,
      calendarEventDocumentId(outside.eventId),
      calendarEventDocumentId(microsoft.eventId),
      calendarEventDocumentId(other.eventId),
    ]));
    expect(db.documentIds("events")).not.toContain(calendarEventDocumentId(stale.eventId));
    expect(db.documentIds("events")).not.toContain(calendarEventDocumentId(overlappingStale.eventId));
    expect(db.documentIds("events")).not.toContain(calendarEventDocumentId(offsetBoundaryStale.eventId));
    expect(db.batchSizes.every((size) => size <= 400)).toBe(true);
    expect(db.operationLog.findIndex((item) => item.startsWith("set:")))
      .toBeLessThan(db.operationLog.findIndex((item) => item.startsWith("delete:")));
    expect(db.read("events", expectedId).data()).toMatchObject({
      startEpochMs: Date.parse(incoming.start),
      endEpochMs: Date.parse(incoming.end),
    });
  });

  it("overlap epoch queryで範囲外の大量履歴や壊れた文書を読み込まず削除しない", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const overlap = normalizedEvent("member-1", "teams", "overlap", "2026-07-12T08:00:00.000Z", "2026-07-12T10:00:00.000Z");
    const allDayBeforeRange = normalizedEvent("member-1", "microsoft", "all-day-before", "2026-07-12", "2026-07-13");
    const allDayOverlap = normalizedEvent("member-1", "microsoft", "all-day-overlap", "2026-07-13", "2026-07-14");
    const atStartEnds = normalizedEvent("member-1", "microsoft", "end-boundary", "2026-07-12T08:00:00.000Z", range.start);
    const atEndStarts = normalizedEvent("member-1", "microsoft", "start-boundary", range.end, "2027-02-07T10:00:00.000Z");
    db.seed("events", calendarEventDocumentId(overlap.eventId), storedEvent(overlap));
    db.seed("events", calendarEventDocumentId(allDayBeforeRange.eventId), storedEvent(allDayBeforeRange));
    db.seed("events", calendarEventDocumentId(allDayOverlap.eventId), storedEvent(allDayOverlap));
    db.seed("events", calendarEventDocumentId(atStartEnds.eventId), storedEvent(atStartEnds));
    db.seed("events", calendarEventDocumentId(atEndStarts.eventId), storedEvent(atEndStarts));
    db.seed("events", "corrupt-outside-history", {
      ownerUserId: "member-1", source: "microsoft", startEpochMs: 0, endEpochMs: 1,
    });

    await store.replaceProviderEvents("member-1", "microsoft", range, [], await syncGuard(store));

    expect(db.read("events", calendarEventDocumentId(overlap.eventId)).exists).toBe(false);
    expect(db.read("events", calendarEventDocumentId(allDayOverlap.eventId)).exists).toBe(false);
    expect(db.read("events", calendarEventDocumentId(allDayBeforeRange.eventId)).exists).toBe(false);
    expect(db.read("events", calendarEventDocumentId(atStartEnds.eventId)).exists).toBe(true);
    expect(db.read("events", calendarEventDocumentId(atEndStarts.eventId)).exists).toBe(true);
    expect(db.read("events", "corrupt-outside-history").exists).toBe(true);
  });

  it("終日予定をJST midnight/end-exclusiveでepoch化し、範囲境界と一致する予定を正しく扱う", async () => {
    const { db, store } = createStore();
    const range = {
      start: "2026-07-12T15:00:00.000Z",
      end: "2026-07-14T15:00:00.000Z",
      syncedAt: NOW,
    };
    const endsAtStart = normalizedEvent("member-1", "google", "ends-at-start", "2026-07-12", "2026-07-13");
    const startsAtStart = normalizedEvent("member-1", "google", "starts-at-start", "2026-07-13", "2026-07-14");
    const startsAtEnd = normalizedEvent("member-1", "google", "starts-at-end", "2026-07-15", "2026-07-16");
    for (const existing of [endsAtStart, startsAtStart, startsAtEnd]) {
      db.seed("events", calendarEventDocumentId(existing.eventId), storedEvent(existing));
    }
    const incoming = normalizedEvent("member-1", "google", "incoming-all-day", "2026-07-14", "2026-07-15");

    await store.replaceProviderEvents("member-1", "google", range, [incoming], await syncGuard(store));

    expect(db.read("events", calendarEventDocumentId(endsAtStart.eventId)).exists).toBe(true);
    expect(db.read("events", calendarEventDocumentId(startsAtStart.eventId)).exists).toBe(false);
    expect(db.read("events", calendarEventDocumentId(startsAtEnd.eventId)).exists).toBe(true);
    expect(db.read("events", calendarEventDocumentId(incoming.eventId)).data()).toMatchObject({
      startEpochMs: Date.parse("2026-07-14T00:00:00.000+09:00"),
      endEpochMs: Date.parse("2026-07-15T00:00:00.000+09:00"),
    });
  });

  it.each([
    ["date-only start / timed end", "2026-08-12", "2026-08-12T00:30:00.000Z"],
    ["timed start / date-only end", "2026-08-11T20:00:00.000Z", "2026-08-12"],
  ])("%sの混在境界をJST比較に委ねずfail-closedで拒否する", async (_label, start, end) => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const mixed = normalizedEvent("member-1", "google", "mixed-boundary", start, end);

    await expect(store.replaceProviderEvents("member-1", "google", range, [mixed], await syncGuard(store)))
      .rejects.toThrow("同期予定データが正しくありません。");
    expect(db.batchSizes).toEqual([]);
    expect(db.documentIds("events")).toEqual([]);
  });

  it.each([
    ["all-day same", "2026-08-12", "2026-08-12"],
    ["all-day reverse", "2026-08-13", "2026-08-12"],
    ["timed same", "2026-08-12T01:00:00.000Z", "2026-08-12T01:00:00.000Z"],
    ["timed reverse", "2026-08-12T02:00:00.000Z", "2026-08-12T01:00:00.000Z"],
  ])("%sの同値・逆転境界を保存前に拒否する", async (_label, start, end) => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const invalidOrder = normalizedEvent("member-1", "google", "invalid-order", start, end);

    await expect(store.replaceProviderEvents("member-1", "google", range, [invalidOrder], await syncGuard(store)))
      .rejects.toThrow("同期予定データが正しくありません。");
    expect(db.batchSizes).toEqual([]);
    expect(db.documentIds("events")).toEqual([]);
  });

  it("400件単位でbatchし、全upsert成功前はstale削除を始めない", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const stale = normalizedEvent("member-1", "google", "stale");
    db.seed("events", calendarEventDocumentId(stale.eventId), storedEvent(stale));
    const incoming = Array.from({ length: 401 }, (_, index) =>
      normalizedEvent("member-1", "google", `event-${index}`));
    db.failBatch(2);

    await expect(store.replaceProviderEvents("member-1", "google", range, incoming, await syncGuard(store)))
      .rejects.toThrow("fake batch failure");

    expect(db.batchSizes).toEqual([400, 1]);
    expect(db.read("events", calendarEventDocumentId(stale.eventId)).exists).toBe(true);
    expect(db.operationLog.some((item) => item.startsWith("delete:"))).toBe(false);
  });

  it("400件以内でも推定7MiBでtransactionを分割し、全chunkを件数・byte上限内に保つ", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const largeText = "予".repeat(4_096);
    const incoming = Array.from({ length: 400 }, (_, index) => ({
      ...normalizedEvent("member-1", "google", `large-event-${index}`),
      title: largeText,
      location: largeText,
    }));

    await store.replaceProviderEvents("member-1", "google", range, incoming, await syncGuard(store));

    expect(db.batchSizes.length).toBeGreaterThan(1);
    expect(db.batchSizes.reduce((total, size) => total + size, 0)).toBe(400);
    expect(db.batchSizes.every((size) => size <= 400)).toBe(true);
    expect(db.transactionByteSizes.every((size) => size <= 7 * 1024 * 1024)).toBe(true);
  });

  it("stale deleteも保存文書とindex削除byteを見積もり、大きな400件を7MiB以下へ分割する", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const largeText = "予".repeat(4_096);
    for (let index = 0; index < 400; index += 1) {
      const stale = {
        ...normalizedEvent("member-1", "google", `large-stale-${index}`),
        title: largeText,
        location: largeText,
      };
      db.seed("events", calendarEventDocumentId(stale.eventId), storedEvent(stale));
    }

    await store.replaceProviderEvents("member-1", "google", range, [], await syncGuard(store));

    expect(db.batchSizes.length).toBeGreaterThan(1);
    expect(db.batchSizes.reduce((total, size) => total + size, 0)).toBe(400);
    expect(db.batchSizes.every((size) => size <= 400)).toBe(true);
    expect(db.transactionByteSizes.every((size) => size <= 7 * 1024 * 1024)).toBe(true);
    expect(db.documentIds("events")).toEqual([]);
  });

  it("小さなstale deleteも件数・byte上限内に分割する", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    for (let index = 0; index < 801; index += 1) {
      const stale = normalizedEvent("member-1", "google", `stale-${index}`);
      db.seed("events", calendarEventDocumentId(stale.eventId), storedEvent(stale));
    }

    await store.replaceProviderEvents("member-1", "google", range, [], await syncGuard(store));

    expect(db.batchSizes.reduce((total, size) => total + size, 0)).toBe(801);
    expect(db.batchSizes.every((size) => size <= 400)).toBe(true);
    expect(db.transactionByteSizes.every((size) => size <= 7 * 1024 * 1024)).toBe(true);
    expect(db.documentIds("events")).toEqual([]);
  });

  it("in-range stale文書の内部fieldが壊れていればfail-closedで削除しない", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const stale = normalizedEvent("member-1", "google", "corrupt-stale");
    const documentId = calendarEventDocumentId(stale.eventId);
    db.seed("events", documentId, { ...storedEvent(stale), leakedInternal: "secret-corrupt-value" });

    await expect(store.replaceProviderEvents("member-1", "google", range, [], await syncGuard(store)))
      .rejects.toThrow("同期予定データが正しくありません。");
    expect(db.read("events", documentId).exists).toBe(true);
    expect(db.batchSizes).toEqual([]);
  });

  it("Firestore query文書のdataが取得不能ならfail-closedで削除しない", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const stale = normalizedEvent("member-1", "google", "unavailable-stale");
    const documentId = calendarEventDocumentId(stale.eventId);
    db.seed("events", documentId, storedEvent(stale));
    db.makeQueryDocumentDataUnavailable("events", documentId);

    await expect(store.replaceProviderEvents("member-1", "google", range, [], await syncGuard(store)))
      .rejects.toThrow("Firestore data is invalid");
    expect(db.read("events", documentId).exists).toBe(true);
    expect(db.batchSizes).toEqual([]);
  });

  it("単一documentの安全上限を超える入力をtransaction開始前に拒否する", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const oversized = {
      ...normalizedEvent("member-1", "google", "oversized"),
      title: "予".repeat(8 * 1024 * 1024),
    };

    await expect(store.replaceProviderEvents("member-1", "google", range, [oversized], await syncGuard(store)))
      .rejects.toThrow("同期予定データが正しくありません。");
    expect(db.batchSizes).toEqual([]);
    expect(db.documentIds("events")).toEqual([]);
  });

  it("複数upsert transactionごとに時刻を取り直し、途中でlease期限を越えた旧runを止める", async () => {
    const { db, store } = createStore();
    const lease = await store.acquireSyncLock(new Date(NOW));
    const times = ["2026-08-11T09:09:59.999Z", "2026-08-11T09:10:00.000Z"];
    const guard: SyncWriteGuard = {
      lease: lease!,
      now: () => new Date(times.shift() ?? "2026-08-11T09:10:00.001Z"),
    };
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const incoming = Array.from({ length: 401 }, (_, index) =>
      normalizedEvent("member-1", "google", `event-${index}`));

    await expect(store.replaceProviderEvents("member-1", "google", range, incoming, guard))
      .rejects.toThrow("同期ロックが失効しました。");

    expect(db.documentIds("events")).toHaveLength(400);
    expect(db.batchSizes).toEqual([400]);
  });

  it("delete batch失敗時もfresh予定を保持し、staleが余分に残るだけにする", async () => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const stale = normalizedEvent("member-1", "google", "stale");
    const incoming = normalizedEvent("member-1", "google", "fresh");
    db.seed("events", calendarEventDocumentId(stale.eventId), storedEvent(stale));
    db.failBatch(2);

    await expect(store.replaceProviderEvents("member-1", "google", range, [incoming], await syncGuard(store)))
      .rejects.toThrow("fake batch failure");

    expect(db.read("events", calendarEventDocumentId(incoming.eventId)).exists).toBe(true);
    expect(db.read("events", calendarEventDocumentId(stale.eventId)).exists).toBe(true);
  });

  it("event入力を全件検証してから書き込み、重複・hash衝突・provider不整合をfail-closedにする", async () => {
    const db = new FakeFirestore();
    const collisionStore = createMemberStore(db, () => NOW, () => "member", () => "lease", () => "a".repeat(64));
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const one = normalizedEvent("member-1", "google", "one");
    const two = normalizedEvent("member-1", "google", "two");

    const guard = await syncGuard(collisionStore);
    await expect(collisionStore.replaceProviderEvents("member-1", "google", range, [one, two], guard))
      .rejects.toThrow("同期予定データが正しくありません。");
    await expect(collisionStore.replaceProviderEvents("member-1", "google", range, [
      { ...one, ownerUserId: "other" },
    ], guard)).rejects.toThrow("同期予定データが正しくありません。");
    await expect(collisionStore.replaceProviderEvents("member-1", "google", range, [
      { ...one, source: "teams", eventId: `teams:member-1:${one.sourceEventId}` },
    ], guard)).rejects.toThrow("同期予定データが正しくありません。");
    await expect(collisionStore.replaceProviderEvents("member-1", "google", range, [
      { ...one, start: "2026-11-31T00:00:00.000Z", end: "2026-12-03T00:00:00.000Z" },
    ], guard)).rejects.toThrow("同期予定データが正しくありません。");
    expect(db.documentIds("events")).toEqual([]);
    expect(db.batchSizes).toEqual([]);
  });

  it.each([
    ["meeting URL", { location: "https://teams.microsoft.com/l/meetup-join/secret" }],
    ["unmasked private", { visibility: "private", title: "秘密会議", location: "会議室" }],
    ["unexpected calendar id", { calendarId: "person@gmail.com" }],
  ] satisfies Array<[string, Partial<NormalizedEvent>]>)("正規化境界で%sを保存前に拒否する", async (_label, override) => {
    const { db, store } = createStore();
    const range = { start: "2026-07-12T09:00:00.000Z", end: "2027-02-07T09:00:00.000Z", syncedAt: NOW };
    const candidate = { ...normalizedEvent("member-1", "google", "event"), ...override };
    await expect(store.replaceProviderEvents("member-1", "google", range, [candidate], await syncGuard(store)))
      .rejects.toThrow("同期予定データが正しくありません。");
    expect(db.documentIds("events")).toEqual([]);
  });
});
