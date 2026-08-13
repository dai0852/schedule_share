import { createHash, randomUUID } from "node:crypto";
import type { DocumentData, DocumentReference, Firestore, Query } from "firebase-admin/firestore";

import { normalizeMicrosoftEmail, type GoogleConnectionStatus, type SalesMemberRecord } from "@/domain/member";
import {
  eventBoundaryToEpochMs,
  sanitizeEventLocation,
  sanitizeEventTitle,
  type NormalizedEvent,
} from "@/domain/schedule";
import { getAdminFirestore } from "@/lib/firebase/admin";

export interface CreateMemberInput {
  displayName: string;
  department: string;
  microsoftEmail: string;
}

export interface UpdateMemberInput {
  displayName?: string;
  department?: string;
  microsoftEmail?: string;
  active?: boolean;
  microsoftSyncEnabled?: boolean;
}

export interface CalendarConnectionRecord {
  memberId: string;
  revision: string;
  googleSubject: string;
  googleEmail: string;
  calendarId: string;
  encryptedRefreshToken: string;
  tokenIv: string;
  tokenAuthTag: string;
  connectedAt: string;
  updatedAt: string;
}

export type SyncProvider = "google" | "microsoft";

export interface SyncStatusRecord {
  memberId: string;
  provider: SyncProvider;
  status: "success" | "error" | "running";
  lastStartedAt: string;
  lastSucceededAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  updatedAt: string;
}

export interface EventSyncRange {
  start: string;
  end: string;
  syncedAt: string;
}

export interface SyncLease {
  ownerId: string;
  fence: number;
}

export interface SyncWriteGuard {
  lease: SyncLease;
  now(): Date;
}

export class SyncLockLostError extends Error {
  readonly code = "lock_lost" as const;

  constructor() {
    super("同期ロックが失効しました。");
    this.name = "SyncLockLostError";
  }
}

export class SyncConnectionChangedError extends Error {
  readonly code = "connection_changed" as const;

  constructor() {
    super("Googleカレンダー接続が更新されました。");
    this.name = "SyncConnectionChangedError";
  }
}

export interface OAuthStateRecord {
  memberId: string;
  browserNonceHash: string;
  startedByUid: string;
  microsoftEmail: string;
  createdAt: string;
  expiresAt: string;
}

export type GoogleConnectionAuthorization = Pick<
  OAuthStateRecord,
  "memberId" | "startedByUid" | "microsoftEmail"
>;

export interface MemberStore {
  listMembers(): Promise<SalesMemberRecord[]>;
  getActiveMemberById(memberId: string): Promise<SalesMemberRecord | null>;
  createMember(input: CreateMemberInput): Promise<SalesMemberRecord>;
  updateMember(memberId: string, input: UpdateMemberInput): Promise<SalesMemberRecord>;
  deleteMember(memberId: string, guard: SyncWriteGuard): Promise<void>;
  findActiveMemberByMicrosoftEmail(email: string): Promise<SalesMemberRecord | null>;
  createOAuthState(hash: string, record: OAuthStateRecord): Promise<void>;
  consumeOAuthState(hash: string, browserNonceHash: string, now: string): Promise<OAuthStateRecord | null>;
  getConnection(memberId: string): Promise<CalendarConnectionRecord | null>;
  saveConnection(record: CalendarConnectionRecord, authorization: GoogleConnectionAuthorization): Promise<void>;
  deleteConnection(memberId: string): Promise<void>;
  saveGoogleReconnectFailure(
    status: SyncStatusRecord,
    guard: SyncWriteGuard,
    expectedRevision: string,
  ): Promise<void>;
  saveSyncStatus(status: SyncStatusRecord, guard: SyncWriteGuard, expectedRevision?: string): Promise<void>;
  getSyncStatuses(memberId?: string): Promise<SyncStatusRecord[]>;
  replaceProviderEvents(
    memberId: string,
    provider: SyncProvider,
    range: EventSyncRange,
    events: NormalizedEvent[],
    guard: SyncWriteGuard,
    expectedRevision?: string,
  ): Promise<void>;
  acquireSyncLock(now: Date): Promise<SyncLease | null>;
  renewSyncLock(lease: SyncLease, now: Date): Promise<void>;
  releaseSyncLock(lease: SyncLease): Promise<void>;
}

export interface FirestoreDocumentSnapshot {
  exists: boolean;
  data(): unknown;
}

export interface FirestoreDocumentReference {
  readonly id: string;
  get(): Promise<FirestoreDocumentSnapshot>;
  set(data: unknown): unknown;
  delete(): unknown;
}

export type FirestoreWhereOperator = "==" | "in" | "<" | ">" | ">=";

export interface FirestoreQuery {
  where(field: string, operator: FirestoreWhereOperator, value: unknown): FirestoreQuery;
  get(): Promise<{ docs: Array<{ id: string; data(): unknown }> }>;
}

export interface FirestoreWriteBatch {
  set(reference: FirestoreDocumentReference, data: unknown): unknown;
  delete(reference: FirestoreDocumentReference): unknown;
  commit(): Promise<unknown>;
}

export interface FirestoreBoundary {
  collection(name: string): FirestoreQuery & {
    doc(id: string): FirestoreDocumentReference;
  };
  runTransaction<T>(
    operation: (transaction: {
      get(reference: FirestoreDocumentReference): Promise<FirestoreDocumentSnapshot>;
      set(reference: FirestoreDocumentReference, data: unknown): unknown;
      delete(reference: FirestoreDocumentReference): unknown;
    }) => Promise<T>,
  ): Promise<T>;
  batch(): FirestoreWriteBatch;
}

const MEMBERS_COLLECTION = "salesMembers";
const MEMBER_EMAIL_INDEX_COLLECTION = "memberEmailIndex";
const CONNECTIONS_COLLECTION = "calendarConnections";
const SYNC_STATUS_COLLECTION = "syncStatus";
const OAUTH_STATES_COLLECTION = "oauthStates";
const EVENTS_COLLECTION = "events";
const SYNC_LOCKS_COLLECTION = "syncLocks";
const SYNC_LOCK_ID = "calendar-sync";
const SYNC_LOCK_TTL_MS = 10 * 60 * 1_000;
const EVENT_BATCH_SIZE = 400;
// Firestore's transaction limit is 10 MiB including document names and index entries.
// Keep a 3 MiB margin and conservatively double JSON/path bytes for protobuf/index growth.
const FIRESTORE_TRANSACTION_SAFE_BYTES = 7 * 1024 * 1024;
const FIRESTORE_SERIALIZED_SAFETY_MULTIPLIER = 2;
const FIRESTORE_OPERATION_OVERHEAD_BYTES = 1_024;
const MAX_SYNC_EVENTS = 50_000;
const MAX_SYNC_RANGE_MS = 210 * 24 * 60 * 60 * 1_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORED_SYNC_ERROR_MESSAGES = {
  invalid_grant: "Googleカレンダーの再接続が必要です。",
  reconnect_required: "Google Calendarの再接続が必要です。",
  permission_denied: "Microsoftカレンダーの読み取り権限を確認してください。",
  rate_limited: "予定サービスが混み合っています。次回の同期で再試行します。",
  upstream_unavailable: "予定サービスへ接続できませんでした。次回の同期で再試行します。",
  invalid_response: "予定サービスから無効な応答を受信しました。",
  server_config: "カレンダー連携のサーバー設定を確認してください。",
  invalid_request: "カレンダー同期の設定が正しくありません。",
  upstream_rejected: "予定サービスへのリクエストが拒否されました。",
  timeout: "予定サービスへの接続がタイムアウトしました。次回の同期で再試行します。",
  lock_lost: "同期ロックが失効したため、この同期結果は保存されませんでした。",
  connection_changed: "Googleカレンダー接続が更新されたため、この同期結果は保存されませんでした。",
  sync_failed: "カレンダーの同期に失敗しました。次回の同期で再試行します。",
} as const;
type StoredSyncErrorCode = keyof typeof STORED_SYNC_ERROR_MESSAGES;

interface MemberEmailIndexRecord {
  memberId: string;
  microsoftEmail: string;
}

interface AdminDocumentReference extends FirestoreDocumentReference {
  native: DocumentReference<DocumentData>;
}

interface AdminQuery extends FirestoreQuery {
  native: Query<DocumentData>;
}

interface SyncLockRecord {
  ownerId: string | null;
  fence: number;
  expiresAt: string;
  updatedAt: string;
}

export function createMemberStore(
  firestore: FirestoreBoundary,
  now: () => string = () => new Date().toISOString(),
  generateId: () => string = randomUUID,
  generateLockOwner: () => string = randomUUID,
  hashEventId: (eventId: string) => string = calendarEventDocumentId,
): MemberStore {
  return {
    async listMembers() {
      const snapshot = await firestore.collection(MEMBERS_COLLECTION).get();
      return snapshot.docs
        .map((document) => decodeMember(document.data(), document.id))
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "ja") || left.id.localeCompare(right.id));
    },

    async getActiveMemberById(memberId) {
      const safeMemberId = publicMemberId(memberId);
      const snapshot = await firestore.collection(MEMBERS_COLLECTION).doc(safeMemberId).get();
      if (!snapshot.exists) return null;
      const member = decodeMember(snapshot.data(), safeMemberId);
      return member.active ? member : null;
    },

    async createMember(input) {
      const candidate = objectInput(input);
      const displayName = requiredTrimmed(candidate.displayName, "表示名");
      const department = requiredTrimmed(candidate.department, "部署名");
      const microsoftEmail = validatedMicrosoftEmail(candidate.microsoftEmail);
      const indexDocument = firestore.collection(MEMBER_EMAIL_INDEX_COLLECTION).doc(memberEmailIndexId(microsoftEmail));

      return firestore.runTransaction(async (transaction) => {
        if ((await transaction.get(indexDocument)).exists) {
          throw new Error("同じMicrosoftメールアドレスのメンバーは既に登録されています。");
        }

        const id = generatedMemberId(generateId());
        const timestamp = now();
        const member: SalesMemberRecord = {
          id,
          displayName,
          department,
          microsoftEmail,
          active: true,
          microsoftSyncEnabled: true,
          googleConnectionStatus: "not_connected",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        transaction.set(firestore.collection(MEMBERS_COLLECTION).doc(id), member);
        transaction.set(indexDocument, { memberId: id, microsoftEmail } satisfies MemberEmailIndexRecord);
        return member;
      });
    },

    async updateMember(memberId, input) {
      const candidate = objectInput(input);
      const safeMemberId = publicMemberId(memberId);
      const document = firestore.collection(MEMBERS_COLLECTION).doc(safeMemberId);
      return firestore.runTransaction(async (transaction) => {
        const existing = await requiredMember(transaction, document, safeMemberId);
        const microsoftEmail = candidate.microsoftEmail === undefined
          ? existing.microsoftEmail
          : validatedMicrosoftEmail(candidate.microsoftEmail);
        const emailChanged = microsoftEmail !== existing.microsoftEmail;
        const oldIndexDocument = firestore.collection(MEMBER_EMAIL_INDEX_COLLECTION)
          .doc(memberEmailIndexId(existing.microsoftEmail));
        const newIndexDocument = firestore.collection(MEMBER_EMAIL_INDEX_COLLECTION)
          .doc(memberEmailIndexId(microsoftEmail));
        if (emailChanged) {
          const [oldIndexSnapshot, newIndexSnapshot] = await Promise.all([
            transaction.get(oldIndexDocument),
            transaction.get(newIndexDocument),
          ]);
          if (!oldIndexSnapshot.exists) invalidFirestoreData("memberEmailIndex");
          const oldIndex = decodeMemberEmailIndex(
            oldIndexSnapshot.data(),
            oldIndexDocument.id,
            existing.microsoftEmail,
          );
          if (oldIndex.memberId !== safeMemberId) invalidFirestoreData("memberEmailIndex.memberId");
          if (newIndexSnapshot.exists) {
            throw new Error("同じMicrosoftメールアドレスのメンバーは既に登録されています。");
          }
        }
        const updated: SalesMemberRecord = {
          ...existing,
          ...(candidate.displayName === undefined ? {} : { displayName: requiredTrimmed(candidate.displayName, "表示名") }),
          ...(candidate.department === undefined ? {} : { department: requiredTrimmed(candidate.department, "部署名") }),
          microsoftEmail,
          ...(candidate.active === undefined ? {} : { active: requiredBoolean(candidate.active, "active") }),
          ...(candidate.microsoftSyncEnabled === undefined
            ? {}
            : { microsoftSyncEnabled: requiredBoolean(candidate.microsoftSyncEnabled, "microsoftSyncEnabled") }),
          updatedAt: now(),
        };
        transaction.set(document, updated);
        if (emailChanged) {
          transaction.delete(oldIndexDocument);
          transaction.set(newIndexDocument, {
            memberId: safeMemberId,
            microsoftEmail,
          } satisfies MemberEmailIndexRecord);
        }
        return updated;
      });
    },

    async deleteMember(memberId, guard) {
      const safeMemberId = publicMemberId(memberId);
      const safeGuard = syncWriteGuard(guard);
      const memberDocument = firestore.collection(MEMBERS_COLLECTION).doc(safeMemberId);
      const memberSnapshot = await memberDocument.get();
      if (!memberSnapshot.exists) throw new Error("指定されたメンバーが見つかりません。");
      const member = decodeMember(memberSnapshot.data(), safeMemberId);

      const [eventSnapshot, oauthStateSnapshot] = await Promise.all([
        firestore.collection(EVENTS_COLLECTION).where("ownerUserId", "==", safeMemberId).get(),
        firestore.collection(OAUTH_STATES_COLLECTION).where("memberId", "==", safeMemberId).get(),
      ]);
      const relatedDocuments = [
        ...eventSnapshot.docs.map((document) => deletionDocument(
          EVENTS_COLLECTION,
          document,
          "ownerUserId",
          safeMemberId,
          firestore,
        )),
        ...oauthStateSnapshot.docs.map((document) => deletionDocument(
          OAUTH_STATES_COLLECTION,
          document,
          "memberId",
          safeMemberId,
          firestore,
        )),
      ];
      await commitFencedDeletes(firestore, safeGuard, relatedDocuments);

      const indexDocument = firestore.collection(MEMBER_EMAIL_INDEX_COLLECTION)
        .doc(memberEmailIndexId(member.microsoftEmail));
      const connectionDocument = firestore.collection(CONNECTIONS_COLLECTION).doc(safeMemberId);
      const googleStatusDocument = firestore.collection(SYNC_STATUS_COLLECTION).doc(`${safeMemberId}_google`);
      const microsoftStatusDocument = firestore.collection(SYNC_STATUS_COLLECTION).doc(`${safeMemberId}_microsoft`);
      await firestore.runTransaction(async (transaction) => {
        const [currentMemberSnapshot, indexSnapshot] = await Promise.all([
          transaction.get(memberDocument),
          transaction.get(indexDocument),
        ]);
        await assertSyncWriteGuard(firestore, transaction, safeGuard);
        if (!currentMemberSnapshot.exists) throw new Error("指定されたメンバーが見つかりません。");
        const currentMember = decodeMember(currentMemberSnapshot.data(), safeMemberId);
        if (currentMember.microsoftEmail !== member.microsoftEmail || !indexSnapshot.exists) {
          throw new Error("メンバー情報が更新されました。もう一度お試しください。");
        }
        const index = decodeMemberEmailIndex(indexSnapshot.data(), indexDocument.id, member.microsoftEmail);
        if (index.memberId !== safeMemberId) invalidFirestoreData("memberEmailIndex.memberId");
        transaction.delete(connectionDocument);
        transaction.delete(googleStatusDocument);
        transaction.delete(microsoftStatusDocument);
        transaction.delete(indexDocument);
        transaction.delete(memberDocument);
      });
    },

    async findActiveMemberByMicrosoftEmail(email) {
      if (typeof email !== "string") return null;
      const normalizedEmail = normalizeMicrosoftEmail(email);
      if (!normalizedEmail) return null;

      const indexId = memberEmailIndexId(normalizedEmail);
      const indexSnapshot = await firestore.collection(MEMBER_EMAIL_INDEX_COLLECTION).doc(indexId).get();
      if (!indexSnapshot.exists) return null;
      const index = decodeMemberEmailIndex(indexSnapshot.data(), indexId, normalizedEmail);
      const memberSnapshot = await firestore.collection(MEMBERS_COLLECTION).doc(index.memberId).get();
      if (!memberSnapshot.exists) return null;
      const member = decodeMember(memberSnapshot.data(), index.memberId);
      if (member.microsoftEmail !== normalizedEmail) invalidFirestoreData("member.microsoftEmail");
      return member.active ? member : null;
    },

    async createOAuthState(hash, record) {
      const normalized = decodeOAuthState(record);
      await Promise.resolve(firestore.collection(OAUTH_STATES_COLLECTION).doc(hash).set({
        ...normalized,
        createdAt: new Date(normalized.createdAt),
        expiresAt: new Date(normalized.expiresAt),
      }));
    },

    async consumeOAuthState(hash, browserNonceHash, currentTime) {
      const document = firestore.collection(OAUTH_STATES_COLLECTION).doc(hash);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(document);
        if (!snapshot.exists) return null;
        let record: OAuthStateRecord;
        try {
          record = decodeOAuthState(snapshot.data());
        } catch {
          transaction.delete(document);
          return null;
        }
        if (
          record.browserNonceHash !== browserNonceHash
          || !isIsoTimestamp(currentTime)
          || Date.parse(record.expiresAt) <= Date.parse(currentTime)
        ) {
          transaction.delete(document);
          return null;
        }
        const memberSnapshot = await transaction.get(firestore.collection(MEMBERS_COLLECTION).doc(record.memberId));
        transaction.delete(document);
        if (!memberSnapshot.exists) return null;
        try {
          const member = decodeMember(memberSnapshot.data(), record.memberId);
          return member.active && member.microsoftEmail === record.microsoftEmail ? record : null;
        } catch {
          return null;
        }
      });
    },

    async getConnection(memberId) {
      const snapshot = await firestore.collection(CONNECTIONS_COLLECTION).doc(memberId).get();
      return snapshot.exists ? decodeCalendarConnection(snapshot.data(), memberId) : null;
    },

    async saveConnection(record, authorization) {
      const safeRecord = decodeCalendarConnection(record, record.memberId);
      const safeAuthorization = decodeConnectionAuthorization(authorization);
      const memberDocument = firestore.collection(MEMBERS_COLLECTION).doc(safeRecord.memberId);
      const connectionDocument = firestore.collection(CONNECTIONS_COLLECTION).doc(safeRecord.memberId);
      await firestore.runTransaction(async (transaction) => {
        const member = await requiredMember(transaction, memberDocument, safeRecord.memberId);
        if (
          !member.active
          || safeAuthorization.memberId !== safeRecord.memberId
          || safeAuthorization.microsoftEmail !== member.microsoftEmail
        ) throw new Error("Google OAuth authorization is invalid.");
        transaction.set(connectionDocument, safeRecord);
        transaction.set(memberDocument, { ...member, googleConnectionStatus: "connected", updatedAt: now() });
      });
    },

    async deleteConnection(memberId) {
      const memberDocument = firestore.collection(MEMBERS_COLLECTION).doc(memberId);
      const connectionDocument = firestore.collection(CONNECTIONS_COLLECTION).doc(memberId);
      await firestore.runTransaction(async (transaction) => {
        const member = await requiredMember(transaction, memberDocument, memberId);
        transaction.delete(connectionDocument);
        transaction.set(memberDocument, { ...member, googleConnectionStatus: "not_connected", updatedAt: now() });
      });
    },

    async saveGoogleReconnectFailure(status, guard, expectedRevision) {
      const normalized = normalizeSyncStatus(status);
      if (normalized.provider !== "google"
        || normalized.status !== "error"
        || normalized.lastErrorCode !== "reconnect_required") {
        throw new Error("Google再接続エラー状態が正しくありません。");
      }
      const safeMemberId = normalized.memberId;
      const safeGuard = syncWriteGuard(guard);
      const safeRevision = connectionRevision(expectedRevision);
      const memberDocument = firestore.collection(MEMBERS_COLLECTION).doc(safeMemberId);
      const connectionDocument = firestore.collection(CONNECTIONS_COLLECTION).doc(safeMemberId);
      const statusDocument = firestore.collection(SYNC_STATUS_COLLECTION).doc(`${safeMemberId}_google`);
      await firestore.runTransaction(async (transaction) => {
        const [memberSnapshot, connectionSnapshot] = await Promise.all([
          transaction.get(memberDocument),
          transaction.get(connectionDocument),
        ]);
        await assertSyncWriteGuard(firestore, transaction, safeGuard);
        if (!memberSnapshot.exists) throw new Error("指定されたメンバーが見つかりません。");
        const member = decodeMember(memberSnapshot.data(), safeMemberId);
        assertConnectionRevision(connectionSnapshot, safeMemberId, safeRevision);
        transaction.set(memberDocument, { ...member, googleConnectionStatus: "reconnect_required", updatedAt: now() });
        transaction.set(statusDocument, normalized);
      });
    },

    async saveSyncStatus(status, guard, expectedRevision) {
      const normalized = normalizeSyncStatus(status);
      const safeGuard = syncWriteGuard(guard);
      const safeRevision = expectedRevision === undefined ? undefined : connectionRevision(expectedRevision);
      const statusDocument = firestore.collection(SYNC_STATUS_COLLECTION).doc(`${normalized.memberId}_${normalized.provider}`);
      await firestore.runTransaction(async (transaction) => {
        const connectionSnapshot = safeRevision === undefined
          ? undefined
          : await transaction.get(firestore.collection(CONNECTIONS_COLLECTION).doc(normalized.memberId));
        await assertSyncWriteGuard(firestore, transaction, safeGuard);
        if (safeRevision !== undefined) {
          assertConnectionRevision(connectionSnapshot, normalized.memberId, safeRevision);
        }
        transaction.set(statusDocument, normalized);
      });
    },

    async getSyncStatuses(memberId) {
      const query = memberId === undefined
        ? firestore.collection(SYNC_STATUS_COLLECTION)
        : firestore.collection(SYNC_STATUS_COLLECTION).where("memberId", "==", syncMemberId(memberId));
      const snapshot = await query.get();
      return snapshot.docs
        .map((document) => decodeSyncStatus(document.data(), document.id))
        .sort((left, right) => left.memberId.localeCompare(right.memberId) || left.provider.localeCompare(right.provider));
    },

    async replaceProviderEvents(memberId, provider, range, events, guard, expectedRevision) {
      const safeMemberId = syncMemberId(memberId);
      const safeProvider = syncProvider(provider);
      const safeRange = syncRange(range);
      const safeGuard = syncWriteGuard(guard);
      const safeRevision = expectedRevision === undefined ? undefined : connectionRevision(expectedRevision);
      if (!Array.isArray(events) || events.length > MAX_SYNC_EVENTS) invalidSyncEvents();

      const safeEvents: StoredNormalizedEvent[] = [];
      const documentIds = new Set<string>();
      const eventIds = new Set<string>();
      for (const event of events) {
        const safeEvent = decodeNormalizedEvent(event, safeMemberId, safeProvider);
        if (!eventsOverlapRange(safeEvent, safeRange)) invalidSyncEvents();
        const documentId = validatedEventHash(hashEventId(safeEvent.eventId));
        if (eventIds.has(safeEvent.eventId) || documentIds.has(documentId)) invalidSyncEvents();
        eventIds.add(safeEvent.eventId);
        documentIds.add(documentId);
        safeEvents.push({
          ...safeEvent,
          startEpochMs: eventBoundaryToEpochMs(safeEvent.start),
          endEpochMs: eventBoundaryToEpochMs(safeEvent.end),
        });
      }

      const sources = safeProvider === "google" ? ["google"] : ["microsoft", "teams"];
      const query = firestore.collection(EVENTS_COLLECTION)
        .where("ownerUserId", "==", safeMemberId)
        .where("source", "in", sources)
        .where("startEpochMs", "<", Date.parse(safeRange.end))
        .where("endEpochMs", ">", Date.parse(safeRange.start));
      const existingSnapshot = await query.get();
      const existingInRange = existingSnapshot.docs
        .map((document) => ({
          id: document.id,
          storedEvent: decodeStoredNormalizedEvent(document.data(), safeMemberId, safeProvider, document.id),
        }))
        .filter(({ storedEvent }) => eventsOverlapRange(storedEvent, safeRange));

      await commitFencedTransactions(firestore, safeGuard, safeMemberId, safeRevision, safeEvents.map((event) => ({
        kind: "set" as const,
        reference: firestore.collection(EVENTS_COLLECTION).doc(validatedEventHash(hashEventId(event.eventId))),
        data: event,
      })));

      const stale = existingInRange
        .filter(({ id }) => !documentIds.has(id))
        .map(({ id, storedEvent }) => ({
          kind: "delete" as const,
          reference: firestore.collection(EVENTS_COLLECTION).doc(id),
          data: storedEvent,
        }));
      await commitFencedTransactions(firestore, safeGuard, safeMemberId, safeRevision, stale);
    },

    async acquireSyncLock(currentDate) {
      const current = validDate(currentDate, "同期日時が正しくありません。");
      const ownerId = boundedInputString(generateLockOwner(), "同期ロックを取得できません。", 128);
      const document = firestore.collection(SYNC_LOCKS_COLLECTION).doc(SYNC_LOCK_ID);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(document);
        let fence = 0;
        if (snapshot.exists) {
          const existing = decodeSyncLock(snapshot.data());
          fence = existing.fence;
          if (existing.ownerId !== null && Date.parse(existing.expiresAt) > current.getTime()) return null;
        }
        const lease = { ownerId, fence: fence + 1 } satisfies SyncLease;
        transaction.set(document, {
          ...lease,
          expiresAt: new Date(current.getTime() + SYNC_LOCK_TTL_MS),
          updatedAt: current,
        });
        return lease;
      });
    },

    async renewSyncLock(lease, currentDate) {
      const safeLease = syncLease(lease);
      const current = validDate(currentDate, "同期日時が正しくありません。");
      const document = firestore.collection(SYNC_LOCKS_COLLECTION).doc(SYNC_LOCK_ID);
      await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(document);
        if (!snapshot.exists) throw new SyncLockLostError();
        const existing = decodeSyncLock(snapshot.data());
        if (!sameLease(existing, safeLease) || Date.parse(existing.expiresAt) <= current.getTime()) {
          throw new SyncLockLostError();
        }
        transaction.set(document, {
          ...existing,
          expiresAt: new Date(current.getTime() + SYNC_LOCK_TTL_MS),
          updatedAt: current,
        });
      });
    },

    async releaseSyncLock(lease) {
      const safeLease = syncLease(lease);
      const document = firestore.collection(SYNC_LOCKS_COLLECTION).doc(SYNC_LOCK_ID);
      await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(document);
        if (!snapshot.exists) return;
        const existing = decodeSyncLock(snapshot.data());
        if (!sameLease(existing, safeLease)) return;
        transaction.set(document, {
          ...existing,
          ownerId: null,
          expiresAt: new Date(0),
          updatedAt: new Date(existing.updatedAt),
        });
      });
    },
  };
}

export function getMemberStore(): MemberStore {
  return createMemberStore(createAdminFirestoreBoundary(getAdminFirestore()));
}

export function memberEmailIndexId(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail).digest("hex");
}

export function calendarEventDocumentId(eventId: string): string {
  if (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 2_048) invalidSyncEvents();
  return createHash("sha256").update(eventId).digest("hex");
}

function createAdminFirestoreBoundary(firestore: Firestore): FirestoreBoundary {
  return {
    collection(name) {
      const collection = firestore.collection(name);
      return {
        doc: (id) => wrapAdminReference(collection.doc(id)),
        ...wrapAdminQuery(collection),
      };
    },
    runTransaction: (operation) =>
      firestore.runTransaction(async (transaction) =>
        operation({
          get: async (reference) => {
            const snapshot = await transaction.get(unwrapAdminReference(reference));
            return { exists: snapshot.exists, data: () => snapshot.data() };
          },
          set: (reference, data) => transaction.set(unwrapAdminReference(reference), data as DocumentData),
          delete: (reference) => transaction.delete(unwrapAdminReference(reference)),
        }),
      ),
    batch: () => {
      const batch = firestore.batch();
      return {
        set: (reference, data) => batch.set(unwrapAdminReference(reference), data as DocumentData),
        delete: (reference) => batch.delete(unwrapAdminReference(reference)),
        commit: () => batch.commit(),
      };
    },
  };
}

function wrapAdminQuery(query: Query<DocumentData>): AdminQuery {
  return {
    native: query,
    where: (field, operator, value) => wrapAdminQuery(query.where(field, operator, value)),
    get: async () => {
      const snapshot = await query.get();
      return { docs: snapshot.docs.map((document) => ({ id: document.id, data: () => document.data() })) };
    },
  };
}

function wrapAdminReference(reference: DocumentReference<DocumentData>): AdminDocumentReference {
  return {
    id: reference.id,
    native: reference,
    get: async () => {
      const snapshot = await reference.get();
      return { exists: snapshot.exists, data: () => snapshot.data() };
    },
    set: (data) => reference.set(data as DocumentData),
    delete: () => reference.delete(),
  };
}

function unwrapAdminReference(reference: FirestoreDocumentReference): DocumentReference<DocumentData> {
  return (reference as AdminDocumentReference).native;
}

async function requiredMember(
  transaction: { get(reference: FirestoreDocumentReference): Promise<FirestoreDocumentSnapshot> },
  document: FirestoreDocumentReference,
  memberId: string,
): Promise<SalesMemberRecord> {
  const snapshot = await transaction.get(document);
  if (!snapshot.exists) throw new Error("指定されたメンバーが見つかりません。");
  return decodeMember(snapshot.data(), memberId);
}

function decodeMember(value: unknown, documentId: string): SalesMemberRecord {
  const record = firestoreRecord(value, "member");
  const id = requiredFirestoreString(record, "id", "member");
  if (id !== documentId) invalidFirestoreData("member.id");
  const googleConnectionStatus = requiredFirestoreString(record, "googleConnectionStatus", "member");
  if (!isGoogleConnectionStatus(googleConnectionStatus)) invalidFirestoreData("member.googleConnectionStatus");
  return {
    id,
    displayName: requiredFirestoreString(record, "displayName", "member"),
    department: requiredFirestoreString(record, "department", "member"),
    microsoftEmail: requiredFirestoreString(record, "microsoftEmail", "member"),
    active: requiredFirestoreBoolean(record, "active", "member"),
    microsoftSyncEnabled: requiredFirestoreBoolean(record, "microsoftSyncEnabled", "member"),
    googleConnectionStatus,
    createdAt: requiredFirestoreTimestamp(record, "createdAt", "member"),
    updatedAt: requiredFirestoreTimestamp(record, "updatedAt", "member"),
  };
}

function decodeMemberEmailIndex(value: unknown, documentId: string, expectedEmail: string): MemberEmailIndexRecord {
  const record = firestoreRecord(value, "memberEmailIndex");
  const microsoftEmail = requiredFirestoreString(record, "microsoftEmail", "memberEmailIndex");
  if (microsoftEmail !== expectedEmail || memberEmailIndexId(microsoftEmail) !== documentId) invalidFirestoreData("memberEmailIndex.microsoftEmail");
  return { memberId: requiredFirestoreString(record, "memberId", "memberEmailIndex"), microsoftEmail };
}

function decodeCalendarConnection(value: unknown, documentId: string): CalendarConnectionRecord {
  const record = firestoreRecord(value, "calendarConnection");
  const memberId = requiredFirestoreString(record, "memberId", "calendarConnection");
  if (memberId !== documentId) invalidFirestoreData("calendarConnection.memberId");
  return {
    memberId,
    revision: connectionRevision(record.revision),
    googleSubject: requiredFirestoreString(record, "googleSubject", "calendarConnection"),
    googleEmail: requiredFirestoreString(record, "googleEmail", "calendarConnection"),
    calendarId: requiredFirestoreString(record, "calendarId", "calendarConnection"),
    encryptedRefreshToken: requiredFirestoreString(record, "encryptedRefreshToken", "calendarConnection"),
    tokenIv: requiredFirestoreString(record, "tokenIv", "calendarConnection"),
    tokenAuthTag: requiredFirestoreString(record, "tokenAuthTag", "calendarConnection"),
    connectedAt: requiredFirestoreTimestamp(record, "connectedAt", "calendarConnection"),
    updatedAt: requiredFirestoreTimestamp(record, "updatedAt", "calendarConnection"),
  };
}

function decodeOAuthState(value: unknown): OAuthStateRecord {
  const record = firestoreRecord(value, "oauthState");
  return {
    memberId: requiredFirestoreString(record, "memberId", "oauthState"),
    browserNonceHash: requiredFirestoreString(record, "browserNonceHash", "oauthState"),
    startedByUid: requiredFirestoreString(record, "startedByUid", "oauthState"),
    microsoftEmail: requiredFirestoreString(record, "microsoftEmail", "oauthState"),
    createdAt: normalizedFirestoreTimestamp(record, "createdAt", "oauthState"),
    expiresAt: normalizedFirestoreTimestamp(record, "expiresAt", "oauthState"),
  };
}

function decodeConnectionAuthorization(value: unknown): GoogleConnectionAuthorization {
  const record = firestoreRecord(value, "googleConnectionAuthorization");
  return {
    memberId: requiredFirestoreString(record, "memberId", "googleConnectionAuthorization"),
    startedByUid: requiredFirestoreString(record, "startedByUid", "googleConnectionAuthorization"),
    microsoftEmail: requiredFirestoreString(record, "microsoftEmail", "googleConnectionAuthorization"),
  };
}

function decodeSyncStatus(value: unknown, documentId: string): Required<SyncStatusRecord> {
  const record = firestoreRecord(value, "syncStatus");
  const provider = requiredFirestoreString(record, "provider", "syncStatus");
  if (provider !== "google" && provider !== "microsoft") invalidFirestoreData("syncStatus.provider");
  const status = requiredFirestoreString(record, "status", "syncStatus");
  if (status !== "success" && status !== "error" && status !== "running") invalidFirestoreData("syncStatus.status");
  const memberId = requiredFirestoreString(record, "memberId", "syncStatus");
  if (documentId !== `${memberId}_${provider}`) invalidFirestoreData("syncStatus.id");
  const lastErrorCode = nullableFirestoreString(record, "lastErrorCode", "syncStatus");
  const lastErrorMessage = nullableFirestoreString(record, "lastErrorMessage", "syncStatus");
  if (status === "error") {
    if (!isStoredSyncErrorCode(lastErrorCode)
      || lastErrorMessage !== STORED_SYNC_ERROR_MESSAGES[lastErrorCode]) {
      invalidFirestoreData("syncStatus.lastErrorCode");
    }
  } else if (lastErrorCode !== null || lastErrorMessage !== null) {
    invalidFirestoreData("syncStatus.lastErrorCode");
  }
  return {
    memberId,
    provider,
    status,
    lastStartedAt: requiredFirestoreTimestamp(record, "lastStartedAt", "syncStatus"),
    lastSucceededAt: nullableFirestoreTimestamp(record, "lastSucceededAt", "syncStatus"),
    lastErrorCode,
    lastErrorMessage,
    updatedAt: requiredFirestoreTimestamp(record, "updatedAt", "syncStatus"),
  };
}

function normalizeSyncStatus(status: SyncStatusRecord): Required<SyncStatusRecord> {
  const record = objectInput(status);
  const statusValue = requiredInputString(record.status, "status");
  const safeErrorCode = statusValue === "error" ? storedSyncErrorCode(record.lastErrorCode) : null;
  const normalized = {
    memberId: syncMemberId(record.memberId),
    provider: requiredInputString(record.provider, "provider"),
    status: statusValue,
    lastStartedAt: requiredInputString(record.lastStartedAt, "lastStartedAt"),
    lastSucceededAt: record.lastSucceededAt ?? null,
    lastErrorCode: safeErrorCode,
    lastErrorMessage: safeErrorCode === null ? null : STORED_SYNC_ERROR_MESSAGES[safeErrorCode],
    updatedAt: requiredInputString(record.updatedAt, "updatedAt"),
  };
  return decodeSyncStatus(normalized, `${normalized.memberId}_${normalized.provider}`);
}

function storedSyncErrorCode(value: unknown): StoredSyncErrorCode {
  return isStoredSyncErrorCode(value) ? value : "sync_failed";
}

function isStoredSyncErrorCode(value: unknown): value is StoredSyncErrorCode {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(STORED_SYNC_ERROR_MESSAGES, value);
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("入力が正しくありません。");
  return value as Record<string, unknown>;
}

function requiredTrimmed(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new Error(`${fieldName}は文字列で入力してください。`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName}を入力してください。`);
  return trimmed;
}

function requiredInputString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${fieldName}は文字列で入力してください。`);
  return value;
}

function requiredBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${fieldName}はtrueまたはfalseで入力してください。`);
  return value;
}

function validatedMicrosoftEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("Microsoftメールアドレスは文字列で入力してください。");
  const normalized = normalizeMicrosoftEmail(value);
  if (!EMAIL_PATTERN.test(normalized)) throw new Error("Microsoftメールアドレスの形式が正しくありません。");
  return normalized;
}

function generatedMemberId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("メンバーIDの生成に失敗しました。");
  return value;
}

function publicMemberId(value: unknown): string {
  const id = boundedInputString(value, "メンバーIDが正しくありません。", 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error("メンバーIDが正しくありません。");
  return id;
}

function firestoreRecord(value: unknown, type: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidFirestoreData(type);
  return value as Record<string, unknown>;
}

function requiredFirestoreString(record: Record<string, unknown>, field: string, type: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value) invalidFirestoreData(`${type}.${field}`);
  return value;
}

function nullableFirestoreString(record: Record<string, unknown>, field: string, type: string): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") invalidFirestoreData(`${type}.${field}`);
  return value;
}

function nullableFirestoreTimestamp(record: Record<string, unknown>, field: string, type: string): string | null {
  const value = nullableFirestoreString(record, field, type);
  if (value !== null && !isValidRfc3339(value)) invalidFirestoreData(`${type}.${field}`);
  return value;
}

function requiredFirestoreBoolean(record: Record<string, unknown>, field: string, type: string): boolean {
  if (typeof record[field] !== "boolean") invalidFirestoreData(`${type}.${field}`);
  return record[field];
}

function requiredFirestoreTimestamp(record: Record<string, unknown>, field: string, type: string): string {
  const value = requiredFirestoreString(record, field, type);
  if (!isIsoTimestamp(value)) invalidFirestoreData(`${type}.${field}`);
  return value;
}

function normalizedFirestoreTimestamp(record: Record<string, unknown>, field: string, type: string): string {
  const value = record[field];
  if (typeof value === "string") {
    if (!isIsoTimestamp(value)) invalidFirestoreData(`${type}.${field}`);
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) invalidFirestoreData(`${type}.${field}`);
    return value.toISOString();
  }
  if (value && typeof value === "object") {
    const timestamp = value as Record<string, unknown> & { toDate?: () => Date };
    try {
      if (typeof timestamp.toDate === "function") {
        const date = timestamp.toDate();
        if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString();
      }
    } catch {
      invalidFirestoreData(`${type}.${field}`);
    }
    const seconds = timestamp.seconds ?? timestamp._seconds;
    const nanoseconds = timestamp.nanoseconds ?? timestamp._nanoseconds ?? 0;
    if (typeof seconds === "number" && Number.isInteger(seconds)
      && typeof nanoseconds === "number" && Number.isInteger(nanoseconds)
      && nanoseconds >= 0 && nanoseconds < 1_000_000_000) {
      const date = new Date(seconds * 1000 + Math.floor(nanoseconds / 1_000_000));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  invalidFirestoreData(`${type}.${field}`);
}

type StoredNormalizedEvent = NormalizedEvent & {
  startEpochMs: number;
  endEpochMs: number;
};

type FencedEventOperation =
  | { kind: "set"; reference: FirestoreDocumentReference; data: StoredNormalizedEvent }
  | { kind: "delete"; reference: FirestoreDocumentReference; data: StoredNormalizedEvent };

type FencedDeleteOperation = {
  reference: FirestoreDocumentReference;
  collectionName: string;
  data: Record<string, unknown>;
};

type FirestoreTransactionBoundary = {
  get(reference: FirestoreDocumentReference): Promise<FirestoreDocumentSnapshot>;
  set(reference: FirestoreDocumentReference, data: unknown): unknown;
  delete(reference: FirestoreDocumentReference): unknown;
};

async function commitFencedTransactions(
  firestore: FirestoreBoundary,
  guard: SyncWriteGuard,
  memberId: string,
  expectedRevision: string | undefined,
  operations: FencedEventOperation[],
): Promise<void> {
  for (const chunk of splitFencedOperations(operations)) {
    await firestore.runTransaction(async (transaction) => {
      const connectionSnapshot = expectedRevision === undefined
        ? undefined
        : await transaction.get(firestore.collection(CONNECTIONS_COLLECTION).doc(memberId));
      await assertSyncWriteGuard(firestore, transaction, guard);
      if (expectedRevision !== undefined) {
        assertConnectionRevision(connectionSnapshot, memberId, expectedRevision);
      }
      for (const operation of chunk) {
        if (operation.kind === "set") transaction.set(operation.reference, operation.data);
        else transaction.delete(operation.reference);
      }
    });
  }
}

function deletionDocument(
  collectionName: string,
  document: { id: string; data(): unknown },
  ownerField: string,
  memberId: string,
  firestore: FirestoreBoundary,
): FencedDeleteOperation {
  const data = firestoreRecord(document.data(), collectionName);
  if (data[ownerField] !== memberId) invalidFirestoreData(`${collectionName}.${ownerField}`);
  return {
    reference: firestore.collection(collectionName).doc(document.id),
    collectionName,
    data,
  };
}

async function commitFencedDeletes(
  firestore: FirestoreBoundary,
  guard: SyncWriteGuard,
  operations: FencedDeleteOperation[],
): Promise<void> {
  for (const chunk of splitFencedDeletes(operations)) {
    await firestore.runTransaction(async (transaction) => {
      await assertSyncWriteGuard(firestore, transaction, guard);
      for (const operation of chunk) transaction.delete(operation.reference);
    });
  }
}

function splitFencedDeletes(operations: FencedDeleteOperation[]): FencedDeleteOperation[][] {
  const chunks: FencedDeleteOperation[][] = [];
  let chunk: FencedDeleteOperation[] = [];
  let chunkBytes = 0;
  for (const operation of operations) {
    const pathBytes = Buffer.byteLength(`${operation.collectionName}/${operation.reference.id}`, "utf8");
    const dataBytes = Buffer.byteLength(JSON.stringify(operation.data), "utf8");
    const operationBytes = FIRESTORE_OPERATION_OVERHEAD_BYTES
      + FIRESTORE_SERIALIZED_SAFETY_MULTIPLIER * (pathBytes + dataBytes);
    if (operationBytes > FIRESTORE_TRANSACTION_SAFE_BYTES) invalidFirestoreData("memberDelete.documentSize");
    if (chunk.length > 0
      && (chunk.length >= EVENT_BATCH_SIZE
        || chunkBytes + operationBytes > FIRESTORE_TRANSACTION_SAFE_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(operation);
    chunkBytes += operationBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function splitFencedOperations(
  operations: FencedEventOperation[],
): Array<typeof operations> {
  const chunks: Array<typeof operations> = [];
  let chunk: typeof operations = [];
  let chunkBytes = 0;
  for (const operation of operations) {
    const operationBytes = estimatedFirestoreOperationBytes(operation);
    if (operationBytes > FIRESTORE_TRANSACTION_SAFE_BYTES) invalidSyncEvents();
    if (chunk.length > 0
      && (chunk.length >= EVENT_BATCH_SIZE
        || chunkBytes + operationBytes > FIRESTORE_TRANSACTION_SAFE_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(operation);
    chunkBytes += operationBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function estimatedFirestoreOperationBytes(
  operation: FencedEventOperation,
): number {
  const pathBytes = Buffer.byteLength(`${EVENTS_COLLECTION}/${operation.reference.id}`, "utf8");
  // Firestore charges transaction size for deleted documents and their index entries too.
  const dataBytes = Buffer.byteLength(JSON.stringify(operation.data), "utf8");
  return FIRESTORE_OPERATION_OVERHEAD_BYTES
    + FIRESTORE_SERIALIZED_SAFETY_MULTIPLIER * (pathBytes + dataBytes);
}

function decodeStoredNormalizedEvent(
  value: unknown,
  memberId: string,
  provider: SyncProvider,
  documentId: string,
): StoredNormalizedEvent {
  const record = firestoreRecord(value, "event");
  const event = decodeNormalizedEvent(record, memberId, provider, true);
  const startEpochMs = requiredFirestoreEpoch(record, "startEpochMs");
  const endEpochMs = requiredFirestoreEpoch(record, "endEpochMs");
  if (startEpochMs !== eventBoundaryToEpochMs(event.start)
    || endEpochMs !== eventBoundaryToEpochMs(event.end)) invalidSyncEvents();
  if (calendarEventDocumentId(event.eventId) !== documentId) invalidSyncEvents();
  return { ...event, startEpochMs, endEpochMs };
}

function decodeNormalizedEvent(
  value: unknown,
  memberId: string,
  provider: SyncProvider,
  stored = false,
): NormalizedEvent {
  const record = firestoreRecord(value, "event");
  const allowedFields = new Set([
    "eventId", "source", "sourceEventId", "ownerUserId", "ownerName", "calendarId",
    "title", "location", "start", "end", "isOnlineMeeting", "visibility", "updatedAt",
    ...(stored ? ["startEpochMs", "endEpochMs"] : []),
  ]);
  if (Object.keys(record).some((field) => !allowedFields.has(field))) invalidSyncEvents();
  const source = boundedEventString(record.source, 16);
  const sourceEventId = boundedEventString(record.sourceEventId, 1_024);
  const ownerUserId = boundedEventString(record.ownerUserId, 256);
  const eventId = boundedEventString(record.eventId, 2_048);
  const start = eventTimestamp(record.start);
  const end = eventTimestamp(record.end);
  const title = boundedEventText(record.title);
  const location = boundedEventText(record.location);
  const calendarId = boundedEventString(record.calendarId, 256);
  const allowedSources = provider === "google" ? ["google"] : ["microsoft", "teams"];
  if (!allowedSources.includes(source)
    || ownerUserId !== memberId
    || eventId !== `${source}:${memberId}:${sourceEventId}`
    || isDateOnlyEventBoundary(start) !== isDateOnlyEventBoundary(end)
    || eventBoundaryToEpochMs(start) >= eventBoundaryToEpochMs(end)
    || calendarId !== (provider === "google" ? "primary" : "outlook")
    || sanitizeEventTitle(title) !== title
    || sanitizeEventLocation(location) !== location
    || (record.visibility === "private" && (title !== "予定あり" || location !== ""))
    || typeof record.isOnlineMeeting !== "boolean"
    || (record.visibility !== "team" && record.visibility !== "private")) {
    invalidSyncEvents();
  }
  return {
    eventId,
    source: source as NormalizedEvent["source"],
    sourceEventId,
    ownerUserId,
    ownerName: boundedEventString(record.ownerName, 256),
    calendarId,
    title,
    location,
    start,
    end,
    isOnlineMeeting: record.isOnlineMeeting,
    visibility: record.visibility,
    updatedAt: eventIsoTimestamp(record.updatedAt),
  };
}

function syncRange(value: unknown): EventSyncRange {
  const record = firestoreRecord(value, "syncRange");
  const start = eventIsoTimestamp(record.start);
  const end = eventIsoTimestamp(record.end);
  const syncedAt = eventIsoTimestamp(record.syncedAt);
  if (Date.parse(start) >= Date.parse(end)
    || Date.parse(end) - Date.parse(start) > MAX_SYNC_RANGE_MS) invalidSyncEvents();
  return { start, end, syncedAt };
}

function eventsOverlapRange(event: NormalizedEvent, range: EventSyncRange): boolean {
  return eventBoundaryToEpochMs(event.start) < Date.parse(range.end)
    && eventBoundaryToEpochMs(event.end) > Date.parse(range.start);
}

function eventTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) invalidSyncEvents();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (dateMatch) {
    if (!isValidDateParts(dateMatch[1], dateMatch[2], dateMatch[3])) invalidSyncEvents();
    return value;
  }
  return eventIsoTimestamp(value);
}

function eventIsoTimestamp(value: unknown): string {
  if (!isValidRfc3339(value)) invalidSyncEvents();
  return value;
}

function isValidRfc3339(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(value);
  return Boolean(match
    && isValidDateParts(match[1], match[2], match[3])
    && Number.isFinite(Date.parse(value)));
}

function isValidDateParts(yearValue: string, monthValue: string, dayValue: string): boolean {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function boundedEventString(value: unknown, maximum: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || hasForbiddenControl(value)) invalidSyncEvents();
  return value;
}

function boundedEventText(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096 || hasForbiddenControl(value)) invalidSyncEvents();
  return value;
}

function validatedEventHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalidSyncEvents();
  return value;
}

function syncMemberId(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.includes("/")
    || hasForbiddenControl(value)) invalidSyncEvents();
  return value;
}

function syncProvider(value: unknown): SyncProvider {
  if (value !== "google" && value !== "microsoft") invalidSyncEvents();
  return value;
}

function connectionRevision(value: unknown): string {
  const revision = boundedInputString(value, "Google接続revisionが正しくありません。", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(revision)) {
    throw new Error("Google接続revisionが正しくありません。");
  }
  return revision;
}

function syncLease(value: unknown): SyncLease {
  const record = objectInput(value);
  const ownerId = boundedInputString(record.ownerId, "同期ロックが正しくありません。", 128);
  if (typeof record.fence !== "number" || !Number.isSafeInteger(record.fence) || record.fence < 1) {
    throw new Error("同期ロックが正しくありません。");
  }
  return { ownerId, fence: record.fence };
}

function syncWriteGuard(value: unknown): SyncWriteGuard {
  const record = objectInput(value);
  if (typeof record.now !== "function") throw new Error("同期日時が正しくありません。");
  const readNow = record.now as () => unknown;
  return {
    lease: syncLease(record.lease),
    now: () => validDate(readNow(), "同期日時が正しくありません。"),
  };
}

async function assertSyncWriteGuard(
  firestore: FirestoreBoundary,
  transaction: FirestoreTransactionBoundary,
  guard: SyncWriteGuard,
): Promise<void> {
  const snapshot = await transaction.get(firestore.collection(SYNC_LOCKS_COLLECTION).doc(SYNC_LOCK_ID));
  if (!snapshot.exists) throw new SyncLockLostError();
  const lock = decodeSyncLock(snapshot.data());
  if (!sameLease(lock, guard.lease) || Date.parse(lock.expiresAt) <= guard.now().getTime()) {
    throw new SyncLockLostError();
  }
}

function assertConnectionRevision(
  snapshot: FirestoreDocumentSnapshot | undefined,
  memberId: string,
  expectedRevision: string,
): void {
  if (!snapshot?.exists) throw new SyncConnectionChangedError();
  const connection = decodeCalendarConnection(snapshot.data(), memberId);
  if (connection.revision !== expectedRevision) throw new SyncConnectionChangedError();
}

function sameLease(lock: SyncLockRecord, lease: SyncLease): boolean {
  return lock.ownerId === lease.ownerId && lock.fence === lease.fence;
}

function isDateOnlyEventBoundary(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function requiredFirestoreEpoch(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidSyncEvents();
  return value;
}

function decodeSyncLock(value: unknown): SyncLockRecord {
  const record = firestoreRecord(value, "syncLock");
  const ownerId = record.ownerId === null ? null : requiredFirestoreString(record, "ownerId", "syncLock");
  if (ownerId !== null && (ownerId.length > 128 || hasForbiddenControl(ownerId))) invalidFirestoreData("syncLock.ownerId");
  const fence = record.fence;
  if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) invalidFirestoreData("syncLock.fence");
  return {
    ownerId,
    fence,
    expiresAt: normalizedFirestoreTimestamp(record, "expiresAt", "syncLock"),
    updatedAt: normalizedFirestoreTimestamp(record, "updatedAt", "syncLock"),
  };
}

function validDate(value: unknown, message: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(message);
  return new Date(value.getTime());
}

function boundedInputString(value: unknown, message: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || hasForbiddenControl(value)) {
    throw new Error(message);
  }
  return value;
}

function hasForbiddenControl(value: string): boolean {
  return value.includes("\u0000") || value.includes("\r") || value.includes("\n");
}

function invalidSyncEvents(): never {
  throw new Error("同期予定データが正しくありません。");
}

function invalidFirestoreData(field: string): never {
  throw new Error(`Firestore data is invalid: ${field}`);
}

function isGoogleConnectionStatus(value: string): value is GoogleConnectionStatus {
  return value === "not_connected" || value === "connected" || value === "reconnect_required";
}

function isIsoTimestamp(value: string): boolean {
  return isValidRfc3339(value);
}
