"use client";

import { CheckCircle2, CircleAlert, RefreshCw, Settings } from "lucide-react";
import { onAuthStateChanged, signInWithPopup, type User } from "firebase/auth";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { LoginScreen } from "@/components/LoginScreen";
import type { GoogleConnectionStatus, SalesMemberRecord } from "@/domain/member";
import { getClientAuth, getMicrosoftProvider } from "@/lib/firebase/client";
import type { AdminSyncStatus } from "@/server/memberAdmin";

interface AdminMembersResponse {
  members: SalesMemberRecord[];
  syncStatuses: AdminSyncStatus[];
}

interface MemberResponse {
  member: SalesMemberRecord;
}

interface ManualSyncSummary {
  status: "completed" | "locked";
  members: number;
  succeededProviders: number;
  failedProviders: number;
  skippedProviders: number;
}

const EMPTY_FORM = { displayName: "", department: "", microsoftEmail: "" };
const MAX_API_RESPONSE_BYTES = 64 * 1024;
const MEMBER_FIELDS = [
  "id",
  "displayName",
  "department",
  "microsoftEmail",
  "active",
  "microsoftSyncEnabled",
  "googleConnectionStatus",
  "createdAt",
  "updatedAt",
] as const;
const SYNC_STATUS_FIELDS = [
  "memberId",
  "provider",
  "status",
  "lastStartedAt",
  "lastSucceededAt",
  "lastErrorCode",
  "lastErrorSummary",
  "updatedAt",
] as const;
const SYNC_SUMMARY_FIELDS = [
  "status",
  "members",
  "succeededProviders",
  "failedProviders",
  "skippedProviders",
] as const;
const ADMIN_MEMBERS_FIELDS = ["members", "syncStatuses"] as const;
const SAFE_SYNC_ERROR_SUMMARIES = {
  invalid_grant: "Googleカレンダーの再接続が必要です。",
  reconnect_required: "Googleカレンダーの再接続が必要です。",
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
  unknown: "同期に失敗しました。",
} as const;

export function AdminMembers() {
  const [authResolved, setAuthResolved] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [members, setMembers] = useState<SalesMemberRecord[]>([]);
  const [syncStatuses, setSyncStatuses] = useState<AdminSyncStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const authGeneration = useRef(0);
  const currentUser = useRef<User | null>(null);
  const signInPending = useRef(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = onAuthStateChanged(
        getClientAuth(),
        (nextUser) => {
          if (!active) return;
          authGeneration.current += 1;
          currentUser.current = nextUser;
          setUser(nextUser);
          setAuthResolved(true);
          setMembers([]);
          setSyncStatuses([]);
          setLoading(Boolean(nextUser));
          setAccessDenied(false);
          setError(null);
          setSuccess(null);
          setForm(EMPTY_FORM);
          setCreating(false);
          setUpdating(null);
          setSyncing(false);
          setSigningIn(false);
          signInPending.current = false;
        },
        () => {
          if (!active) return;
          authGeneration.current += 1;
          currentUser.current = null;
          setUser(null);
          setAuthResolved(true);
          setMembers([]);
          setSyncStatuses([]);
          setLoading(false);
          setAccessDenied(false);
          setSuccess(null);
          setForm(EMPTY_FORM);
          setCreating(false);
          setUpdating(null);
          setSyncing(false);
          setSigningIn(false);
          signInPending.current = false;
          setError("ログイン状態を確認できませんでした。");
        },
      );
    } catch {
      authGeneration.current += 1;
      currentUser.current = null;
      setAuthResolved(true);
      setError("ログイン状態を確認できませんでした。");
    }
    return () => {
      active = false;
      authGeneration.current += 1;
      currentUser.current = null;
      signInPending.current = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setLoading(true);
    setAccessDenied(false);
    setError(null);
    void user.getIdToken()
      .then((token) => fetch("/api/admin/members", {
        headers: { authorization: `Bearer ${token}` },
      }))
      .then(async (response) => {
        if (!active) return;
        if (response.status === 403) {
          setAccessDenied(true);
          throw new AdminApiError("管理者権限が必要です。");
        }
        const data = await readAdminMembersResponse(response, "メンバー一覧を取得できませんでした。");
        if (!active) return;
        setMembers(data.members);
        setSyncStatuses(data.syncStatuses);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof AdminApiError ? reason.message : "メンバー一覧を取得できませんでした。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  const statusesByMember = useMemo(() => {
    const result = new Map<string, AdminSyncStatus[]>();
    for (const status of syncStatuses) {
      const existing = result.get(status.memberId) ?? [];
      existing.push(status);
      result.set(status.memberId, existing);
    }
    return result;
  }, [syncStatuses]);

  async function handleSignIn() {
    if (signInPending.current) return;
    const generation = authGeneration.current;
    signInPending.current = true;
    setSigningIn(true);
    setError(null);
    try {
      await signInWithPopup(getClientAuth(), getMicrosoftProvider());
    } catch {
      if (authGeneration.current === generation) {
        setError("Microsoft 365ログインを開始できませんでした。");
      }
    } finally {
      if (authGeneration.current === generation) {
        signInPending.current = false;
        setSigningIn(false);
      }
    }
  }

  async function submitMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || creating) return;
    const generation = authGeneration.current;
    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const token = await user.getIdToken();
      if (authGeneration.current !== generation) return;
      const response = await fetch("/api/admin/members", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(form),
      });
      if (authGeneration.current !== generation) return;
      if (response.status === 403) throw new AdminApiError("管理者権限が必要です。");
      const data = await readMemberResponse(response, "営業メンバーを追加できませんでした。");
      if (authGeneration.current !== generation) return;
      setMembers((current) => [...current, data.member]);
      setForm(EMPTY_FORM);
      setSuccess("営業メンバーを追加しました。");
    } catch (reason) {
      if (authGeneration.current === generation) {
        setError(reason instanceof AdminApiError ? reason.message : "営業メンバーを追加できませんでした。");
      }
    } finally {
      if (authGeneration.current === generation) setCreating(false);
    }
  }

  async function updateMember(member: SalesMemberRecord, change: { active: boolean } | { microsoftSyncEnabled: boolean }) {
    if (!user || updating) return;
    const generation = authGeneration.current;
    const operation = `${member.id}:${Object.keys(change)[0]}`;
    setUpdating(operation);
    setError(null);
    setSuccess(null);
    try {
      const token = await user.getIdToken();
      if (authGeneration.current !== generation) return;
      const response = await fetch(`/api/admin/members/${encodeURIComponent(member.id)}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(change),
      });
      if (authGeneration.current !== generation) return;
      if (response.status === 403) throw new AdminApiError("管理者権限が必要です。");
      const data = await readMemberResponse(response, "メンバーを更新できませんでした。");
      if (authGeneration.current !== generation) return;
      setMembers((current) => current.map((item) => item.id === data.member.id ? data.member : item));
      setSuccess("メンバー設定を更新しました。");
    } catch (reason) {
      if (authGeneration.current === generation) {
        setError(reason instanceof AdminApiError ? reason.message : "メンバーを更新できませんでした。");
      }
    } finally {
      if (authGeneration.current === generation) setUpdating(null);
    }
  }

  async function runManualSync() {
    if (!user || syncing) return;
    const generation = authGeneration.current;
    setSyncing(true);
    setError(null);
    setSuccess(null);
    try {
      const token = await user.getIdToken();
      if (authGeneration.current !== generation) return;
      const response = await fetch("/api/admin/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (authGeneration.current !== generation) return;
      if (response.status === 401) throw new AdminApiError("ログインし直してください。");
      if (response.status === 403) throw new AdminApiError("管理者権限が必要です。");
      const summary = await readManualSyncSummary(response);
      if (authGeneration.current !== generation || currentUser.current !== user) return;

      let refreshToken: string;
      try {
        refreshToken = await user.getIdToken();
      } catch {
        throw new AdminApiError("同期状態を更新できませんでした。");
      }
      if (authGeneration.current !== generation || currentUser.current !== user) return;

      const refreshResponse = await fetch("/api/admin/members", {
        headers: { authorization: `Bearer ${refreshToken}` },
      });
      if (authGeneration.current !== generation || currentUser.current !== user) return;
      const refreshed = await readAdminMembersResponse(refreshResponse, "同期状態を更新できませんでした。");
      if (authGeneration.current !== generation || currentUser.current !== user) return;
      setMembers(refreshed.members);
      setSyncStatuses(refreshed.syncStatuses);
      setSuccess(manualSyncMessage(summary));
    } catch (reason) {
      if (authGeneration.current === generation) {
        setError(reason instanceof AdminApiError ? reason.message : "手動同期を開始できませんでした。");
      }
    } finally {
      if (authGeneration.current === generation) setSyncing(false);
    }
  }

  if (!authResolved) return <AdminMessage>ログイン状態を確認しています…</AdminMessage>;
  if (!user) {
    return (
      <div className="adminSurface">
        <LoginScreen
          embedded
          title="営業メンバー設定"
          description="管理画面を利用するにはログインしてください。"
          error={error}
          initializing={false}
          signingIn={signingIn}
          onSignIn={() => void handleSignIn()}
        />
      </div>
    );
  }
  if (loading) return <AdminMessage>営業メンバーを読み込んでいます…</AdminMessage>;
  if (accessDenied) return <AdminMessage error>管理者権限が必要です。</AdminMessage>;

  return (
    <section className="adminSurface">
      <div className="scheduleHeader adminHeader">
        <div>
          <p className="eyebrow">MVP</p>
          <h2>表示対象メンバー</h2>
        </div>
        <div className="adminHeaderActions">
          <button
            className="secondaryButton"
            type="button"
            disabled={syncing}
            onClick={() => void runManualSync()}
          >
            <RefreshCw aria-hidden="true" size={16} />
            {syncing ? "同期しています…" : "手動同期を実行"}
          </button>
          <Settings aria-hidden="true" size={20} />
        </div>
      </div>

      <form className="memberForm" onSubmit={submitMember}>
        <label>
          氏名
          <input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
        </label>
        <label>
          部署
          <input required value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} />
        </label>
        <label>
          Microsoftメールアドレス
          <input required type="email" value={form.microsoftEmail} onChange={(event) => setForm({ ...form, microsoftEmail: event.target.value })} />
        </label>
        <button className="primaryButton" type="submit" disabled={creating}>
          {creating ? "追加しています…" : "営業メンバーを追加"}
        </button>
      </form>

      {error ? <p className="errorText" role="alert">{error}</p> : null}
      {success ? <p className="successText" role="status">{success}</p> : null}

      <div className="memberTable" role="table" aria-label="営業メンバー一覧">
        <div role="rowgroup">
          <div className="memberRow header" role="row">
            <span role="columnheader">氏名 / メール</span>
            <span role="columnheader">部署</span>
            <span role="columnheader">利用状態</span>
            <span role="columnheader">Google</span>
            <span role="columnheader">Microsoft</span>
            <span role="columnheader">同期履歴</span>
          </div>
        </div>
        <div className="memberBody" role="rowgroup">
          {members.length === 0 ? (
            <div className="memberRow" role="row">
              <span className="emptyText memberEmpty" role="cell">登録済みメンバーはいません。</span>
            </div>
          ) : null}
          {members.map((member) => (
            <div className="memberRow" role="row" key={member.id}>
              <span role="cell"><strong>{member.displayName}</strong><small>{member.microsoftEmail}</small></span>
              <span role="cell">{member.department}</span>
              <span role="cell">
                <button
                  className="secondaryButton memberToggle"
                  type="button"
                  disabled={Boolean(updating)}
                  aria-label={`${member.displayName}を${member.active ? "無効" : "有効"}化`}
                  onClick={() => void updateMember(member, { active: !member.active })}
                >
                  {member.active ? "有効" : "無効"}
                </button>
              </span>
              <span role="cell"><ConnectionStatus status={member.googleConnectionStatus} /></span>
              <span role="cell">
                <button
                  className="secondaryButton memberToggle"
                  type="button"
                  disabled={Boolean(updating)}
                  aria-label={`${member.displayName}のMicrosoft同期を${member.microsoftSyncEnabled ? "無効" : "有効"}化`}
                  onClick={() => void updateMember(member, { microsoftSyncEnabled: !member.microsoftSyncEnabled })}
                >
                  {member.microsoftSyncEnabled ? "同期有効" : "同期停止"}
                </button>
              </span>
              <span role="cell"><SyncHistory statuses={statusesByMember.get(member.id) ?? []} /></span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AdminMessage({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <section className="adminSurface"><p className={error ? "errorText" : "plainText"}>{children}</p></section>;
}

function ConnectionStatus({ status }: { status: GoogleConnectionStatus }) {
  const labels = {
    connected: "接続済み",
    not_connected: "未接続",
    reconnect_required: "再接続が必要",
  } as const;
  const enabled = status === "connected";
  return (
    <span className={enabled ? "status ok" : "status warn"}>
      {enabled ? <CheckCircle2 aria-hidden="true" size={16} /> : <CircleAlert aria-hidden="true" size={16} />}
      {labels[status]}
    </span>
  );
}

function SyncHistory({ statuses }: { statuses: AdminSyncStatus[] }) {
  if (statuses.length === 0) return <span className="syncHistory">同期履歴なし</span>;
  return (
    <span className="syncHistory">
      {statuses.map((status) => (
        <small key={status.provider}>
          <strong>{status.provider === "google" ? "Google" : "Microsoft"}</strong>
          {status.lastSucceededAt ? `成功: ${formatTimestamp(status.lastSucceededAt)}` : "成功履歴なし"}
          {status.lastErrorSummary ? ` / エラー: ${status.lastErrorSummary}` : null}
        </small>
      ))}
    </span>
  );
}

async function readMemberResponse(response: Response, fallback: string): Promise<MemberResponse> {
  const data = await response.json().catch(() => null) as ({ error?: unknown } & Partial<MemberResponse>) | null;
  if (!response.ok || !data?.member) {
    const safeMessage = typeof data?.error === "string" ? data.error : fallback;
    throw new AdminApiError(safeMessage);
  }
  return { member: data.member };
}

async function readAdminMembersResponse(response: Response, fallback: string): Promise<AdminMembersResponse> {
  if (!response.ok) throw new AdminApiError(fallback);
  const data = await readLimitedJson(response, fallback);
  const record = exactObject(data, ADMIN_MEMBERS_FIELDS);
  if (!record || !Array.isArray(record.members) || !Array.isArray(record.syncStatuses)) {
    throw new AdminApiError(fallback);
  }
  const members = record.members.map(parseMemberRecord);
  const syncStatuses = record.syncStatuses.map(parseSyncStatus);
  if (members.some((item) => item === null) || syncStatuses.some((item) => item === null)) {
    throw new AdminApiError(fallback);
  }
  return {
    members: members as SalesMemberRecord[],
    syncStatuses: syncStatuses as AdminSyncStatus[],
  };
}

async function readManualSyncSummary(response: Response): Promise<ManualSyncSummary> {
  if (!response.ok) throw new AdminApiError("手動同期を開始できませんでした。");
  const data = exactObject(
    await readLimitedJson(response, "手動同期を開始できませんでした。"),
    SYNC_SUMMARY_FIELDS,
  );
  if (
    !data
    || (data.status !== "completed" && data.status !== "locked")
    || !isSafeCount(data.members)
    || !isSafeCount(data.succeededProviders)
    || !isSafeCount(data.failedProviders)
    || !isSafeCount(data.skippedProviders)
  ) {
    throw new AdminApiError("手動同期を開始できませんでした。");
  }
  return {
    status: data.status,
    members: data.members,
    succeededProviders: data.succeededProviders,
    failedProviders: data.failedProviders,
    skippedProviders: data.skippedProviders,
  };
}

async function readLimitedJson(response: Response, fallback: string): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_API_RESPONSE_BYTES) {
      throw new AdminApiError(fallback);
    }
  }
  if (!response.body) throw new AdminApiError(fallback);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await reader.read();
      if (done) {
        streamComplete = true;
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AdminApiError(fallback);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    throw new AdminApiError(fallback);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminApiError(fallback);
  }
}

function parseMemberRecord(value: unknown): SalesMemberRecord | null {
  // Element DTOs tolerate future fields, but rebuild only the validated allowlist below.
  const record = requiredObject(value, MEMBER_FIELDS);
  if (
    !record
    || !boundedString(record.id, 128)
    || !boundedString(record.displayName, 200)
    || !boundedString(record.department, 200)
    || !boundedString(record.microsoftEmail, 320)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.microsoftEmail)
    || typeof record.active !== "boolean"
    || typeof record.microsoftSyncEnabled !== "boolean"
    || !isGoogleConnectionStatus(record.googleConnectionStatus)
    || !isIsoTimestamp(record.createdAt)
    || !isIsoTimestamp(record.updatedAt)
  ) {
    return null;
  }
  return {
    id: record.id,
    displayName: record.displayName,
    department: record.department,
    microsoftEmail: record.microsoftEmail,
    active: record.active,
    microsoftSyncEnabled: record.microsoftSyncEnabled,
    googleConnectionStatus: record.googleConnectionStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseSyncStatus(value: unknown): AdminSyncStatus | null {
  const record = requiredObject(value, SYNC_STATUS_FIELDS);
  if (
    !record
    || !boundedString(record.memberId, 128)
    || (record.provider !== "google" && record.provider !== "microsoft")
    || (record.status !== "success" && record.status !== "error" && record.status !== "running")
    || !isIsoTimestamp(record.lastStartedAt)
    || !(record.lastSucceededAt === null || isIsoTimestamp(record.lastSucceededAt))
    || !isIsoTimestamp(record.updatedAt)
  ) {
    return null;
  }

  const errorCode = record.lastErrorCode;
  if (errorCode === null) {
    if (record.lastErrorSummary !== null) return null;
  } else {
    if (typeof errorCode !== "string" || !(errorCode in SAFE_SYNC_ERROR_SUMMARIES)) return null;
    const expected = SAFE_SYNC_ERROR_SUMMARIES[errorCode as keyof typeof SAFE_SYNC_ERROR_SUMMARIES];
    if (record.lastErrorSummary !== expected) return null;
  }

  return {
    memberId: record.memberId,
    provider: record.provider,
    status: record.status,
    lastStartedAt: record.lastStartedAt,
    lastSucceededAt: record.lastSucceededAt,
    lastErrorCode: errorCode as AdminSyncStatus["lastErrorCode"],
    lastErrorSummary: record.lastErrorSummary as string | null,
    updatedAt: record.updatedAt,
  };
}

function exactObject<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
): Record<Fields[number], unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key as Fields[number]))) {
    return null;
  }
  return record as Record<Fields[number], unknown>;
}

function requiredObject<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
): Record<Fields[number], unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))) return null;
  return record as Record<Fields[number], unknown>;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isGoogleConnectionStatus(value: unknown): value is GoogleConnectionStatus {
  return value === "not_connected" || value === "connected" || value === "reconnect_required";
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function manualSyncMessage(summary: ManualSyncSummary): string {
  if (summary.status === "locked") {
    return "別の同期が実行中です。しばらくしてから再度お試しください。";
  }
  if (summary.failedProviders > 0) {
    return "手動同期は完了しましたが、一部の予定元で同期に失敗しました。";
  }
  return "手動同期が完了しました。";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "不明" : date.toLocaleString("ja-JP");
}

class AdminApiError extends Error {}
