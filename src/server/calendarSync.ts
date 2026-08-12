import type { SalesMemberRecord } from "@/domain/member";
import type { NormalizedEvent } from "@/domain/schedule";
import {
  fetchAllGoogleEvents,
  GoogleCalendarError,
  refreshGoogleAccessToken,
  type GoogleCalendarErrorCode,
  type GoogleFetchParams,
} from "@/integrations/googleCalendar";
import {
  fetchAllMicrosoftCalendarView,
  getMicrosoftAppAccessToken,
  MicrosoftGraphError,
  type MicrosoftFetchParams,
  type MicrosoftGraphErrorCode,
} from "@/integrations/microsoftGraph";
import { decryptSecret } from "./tokenCrypto";
import {
  getMemberStore,
  type CalendarConnectionRecord,
  type MemberStore,
  SyncConnectionChangedError,
  type SyncLease,
  SyncLockLostError,
  type SyncProvider,
  type SyncStatusRecord,
  type SyncWriteGuard,
} from "./memberStore";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RANGE_BEFORE_MS = 30 * DAY_MS;
const RANGE_AFTER_MS = 180 * DAY_MS;
const MEMBER_CONCURRENCY = 3;
const HEARTBEAT_INTERVAL_MS = 60 * 1_000;

export interface SyncRange {
  start: string;
  end: string;
  syncedAt: string;
}

export type ProviderSyncResult = "success" | "error" | "skipped";

export interface MemberSyncSummary {
  memberId: string;
  google: ProviderSyncResult;
  microsoft: ProviderSyncResult;
}

export interface SyncSummary {
  status: "completed" | "locked";
  members: number;
  succeededProviders: number;
  failedProviders: number;
  skippedProviders: number;
}

export interface CalendarSyncDependencies {
  store: MemberStore;
  decryptRefreshToken(connection: CalendarConnectionRecord): string;
  refreshGoogleAccessToken(refreshToken: string): Promise<string>;
  fetchGoogleEvents(params: GoogleFetchParams): Promise<NormalizedEvent[]>;
  getMicrosoftAccessToken(): Promise<string>;
  fetchMicrosoftEvents(params: MicrosoftFetchParams): Promise<NormalizedEvent[]>;
  clock?: () => Date;
  scheduleInterval?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  cancelInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface CalendarSyncService {
  syncAllCalendars(options?: { now?: Date; memberId?: string }): Promise<SyncSummary>;
  syncMemberCalendars(member: SalesMemberRecord, range: SyncRange): Promise<MemberSyncSummary>;
}

type SafeSyncErrorCode =
  | GoogleCalendarErrorCode
  | MicrosoftGraphErrorCode
  | "lock_lost"
  | "connection_changed"
  | "sync_failed";

const SAFE_ERROR_MESSAGES: Record<SafeSyncErrorCode, string> = {
  server_config: "カレンダー連携のサーバー設定を確認してください。",
  invalid_request: "カレンダー同期の設定が正しくありません。",
  reconnect_required: "Google Calendarの再接続が必要です。",
  upstream_rejected: "予定サービスへのリクエストが拒否されました。",
  permission_denied: "Microsoftカレンダーの読み取り権限を確認してください。",
  rate_limited: "予定サービスが混み合っています。次回の同期で再試行します。",
  upstream_unavailable: "予定サービスへ接続できませんでした。次回の同期で再試行します。",
  invalid_response: "予定サービスから無効な応答を受信しました。",
  timeout: "予定サービスへの接続がタイムアウトしました。次回の同期で再試行します。",
  lock_lost: "同期ロックが失効したため、この同期結果は保存されませんでした。",
  connection_changed: "Googleカレンダー接続が更新されたため、この同期結果は保存されませんでした。",
  sync_failed: "カレンダーの同期に失敗しました。次回の同期で再試行します。",
};

interface SyncRunContext {
  lease: SyncLease;
  signal: AbortSignal;
  guard(): SyncWriteGuard;
  getMicrosoftAccessToken(): Promise<string>;
}

export function createCalendarSyncService(dependencies: CalendarSyncDependencies): CalendarSyncService {
  const dependenciesValue = validateDependencies(dependencies);

  async function syncMemberWithContext(
    member: SalesMemberRecord,
    range: SyncRange,
    context: SyncRunContext,
  ): Promise<MemberSyncSummary> {
    validateMember(member);
    validateRange(range);
    if (!member.active) return skippedMember(member.id);
    throwIfAborted(context.signal);

    const existingStatuses = await dependenciesValue.store.getSyncStatuses(member.id);
    const previous = new Map(existingStatuses.map((status) => [status.provider, status]));
    const tasks: Array<{ provider: SyncProvider; promise: Promise<ProviderSyncResult> }> = [];

    if (member.googleConnectionStatus === "connected") {
      tasks.push({
        provider: "google",
        promise: syncGoogle(member, range, previous.get("google"), context),
      });
    }
    if (member.microsoftSyncEnabled) {
      tasks.push({
        provider: "microsoft",
        promise: syncMicrosoft(member, range, previous.get("microsoft"), context),
      });
    }

    const settled = await Promise.allSettled(tasks.map((task) => task.promise));
    const result: MemberSyncSummary = skippedMember(member.id);
    settled.forEach((outcome, index) => {
      result[tasks[index].provider] = outcome.status === "fulfilled" ? outcome.value : "error";
    });
    return result;
  }

  async function syncGoogle(
    member: SalesMemberRecord,
    range: SyncRange,
    previous: SyncStatusRecord | undefined,
    context: SyncRunContext,
  ): Promise<ProviderSyncResult> {
    const provider = "google" as const;
    const connection = await dependenciesValue.store.getConnection(member.id);
    if (!connection) return "error";
    const revision = connection.revision;
    await saveRunningStatus(dependenciesValue.store, member.id, provider, range.syncedAt, previous, context.guard(), revision);
    try {
      throwIfAborted(context.signal);
      const refreshToken = dependenciesValue.decryptRefreshToken(connection);
      const accessToken = await dependenciesValue.refreshGoogleAccessToken(refreshToken);
      const events = await dependenciesValue.fetchGoogleEvents({
        accessToken,
        timeMin: range.start,
        timeMax: range.end,
        owner: {
          ownerUserId: member.id,
          ownerName: member.displayName,
          calendarId: connection.calendarId,
        },
      });
      throwIfAborted(context.signal);
      await dependenciesValue.store.replaceProviderEvents(member.id, provider, range, events, context.guard(), revision);
      await saveSuccessStatus(dependenciesValue.store, member.id, provider, range.syncedAt, context.guard(), revision);
      return "success";
    } catch (error) {
      if (isSupersededSync(error)) return "error";
      const safe = classifySyncError(error);
      if (safe.code === "reconnect_required") {
        await dependenciesValue.store.saveGoogleReconnectFailure(
          errorStatus(member.id, provider, range.syncedAt, previous, safe),
          context.guard(),
          revision,
        );
        return "error";
      }
      await saveErrorStatus(dependenciesValue.store, member.id, provider, range.syncedAt, previous, safe, context.guard(), revision);
      return "error";
    }
  }

  async function syncMicrosoft(
    member: SalesMemberRecord,
    range: SyncRange,
    previous: SyncStatusRecord | undefined,
    context: SyncRunContext,
  ): Promise<ProviderSyncResult> {
    const provider = "microsoft" as const;
    await saveRunningStatus(dependenciesValue.store, member.id, provider, range.syncedAt, previous, context.guard());
    try {
      throwIfAborted(context.signal);
      const accessToken = await context.getMicrosoftAccessToken();
      const events = await dependenciesValue.fetchMicrosoftEvents({
        accessToken,
        userPrincipalName: member.microsoftEmail,
        start: range.start,
        end: range.end,
        syncedAt: range.syncedAt,
        owner: {
          ownerUserId: member.id,
          ownerName: member.displayName,
          calendarId: "outlook",
        },
      });
      throwIfAborted(context.signal);
      await dependenciesValue.store.replaceProviderEvents(member.id, provider, range, events, context.guard());
      await saveSuccessStatus(dependenciesValue.store, member.id, provider, range.syncedAt, context.guard());
      return "success";
    } catch (error) {
      if (isSupersededSync(error)) return "error";
      const safe = classifySyncError(error);
      await saveErrorStatus(dependenciesValue.store, member.id, provider, range.syncedAt, previous, safe, context.guard());
      return "error";
    }
  }

  async function syncAllCalendars(
    options: { now?: Date; memberId?: string } = {},
  ): Promise<SyncSummary> {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("同期日時が正しくありません。");
    }
    const now = options.now === undefined
      ? new Date()
      : options.now instanceof Date
        ? new Date(options.now.getTime())
        : new Date(Number.NaN);
    validateNow(now);
    validateOptionalMemberId(options.memberId);
    const outcome = await withSyncLease(dependenciesValue, now, async (context) => {
      const range = createSyncRange(now);
      const members = (await dependenciesValue.store.listMembers()).filter((candidate) =>
        candidate.active && (options.memberId === undefined || candidate.id === options.memberId));
      const settled = await mapSettledWithConcurrency(
        members,
        MEMBER_CONCURRENCY,
        (candidate) => syncMemberWithContext(candidate, range, context),
      );
      const summary = emptySummary("completed");
      summary.members = members.length;
      settled.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          countMemberResult(summary, outcome.value);
          return;
        }
        const failedMember = members[index];
        summary.failedProviders += Number(failedMember.googleConnectionStatus === "connected")
          + Number(failedMember.microsoftSyncEnabled);
        summary.skippedProviders += Number(failedMember.googleConnectionStatus !== "connected")
          + Number(!failedMember.microsoftSyncEnabled);
      });
      return summary;
    });
    return outcome ?? emptySummary("locked");
  }

  async function syncMemberCalendars(
    member: SalesMemberRecord,
    range: SyncRange,
  ): Promise<MemberSyncSummary> {
    validateMember(member);
    validateRange(range);
    if (!member.active) return skippedMember(member.id);
    const leaseNow = validClockDate(dependenciesValue.clock?.() ?? new Date());
    const outcome = await withSyncLease(dependenciesValue, leaseNow, (context) =>
      syncMemberWithContext(member, range, context));
    if (outcome === null) throw new SyncLockLostError();
    return outcome;
  }

  return { syncAllCalendars, syncMemberCalendars };
}

function defaultDependencies(): CalendarSyncDependencies {
  return {
    store: getMemberStore(),
    decryptRefreshToken: (connection) => decryptSecret({
      ciphertext: connection.encryptedRefreshToken,
      iv: connection.tokenIv,
      authTag: connection.tokenAuthTag,
    }),
    refreshGoogleAccessToken,
    fetchGoogleEvents: fetchAllGoogleEvents,
    getMicrosoftAccessToken: getMicrosoftAppAccessToken,
    fetchMicrosoftEvents: fetchAllMicrosoftCalendarView,
    clock: () => new Date(),
    scheduleInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    cancelInterval: (timer) => clearInterval(timer),
  };
}

export async function syncAllCalendars(
  options?: { now?: Date; memberId?: string },
): Promise<SyncSummary> {
  return createCalendarSyncService(defaultDependencies()).syncAllCalendars(options);
}

export async function syncMemberCalendars(
  member: SalesMemberRecord,
  range: SyncRange,
): Promise<MemberSyncSummary> {
  return createCalendarSyncService(defaultDependencies()).syncMemberCalendars(member, range);
}

function createSyncRange(now: Date): SyncRange {
  return {
    start: new Date(now.getTime() - RANGE_BEFORE_MS).toISOString(),
    end: new Date(now.getTime() + RANGE_AFTER_MS).toISOString(),
    syncedAt: now.toISOString(),
  };
}

function skippedMember(memberId: string): MemberSyncSummary {
  return { memberId, google: "skipped", microsoft: "skipped" };
}

function emptySummary(status: SyncSummary["status"]): SyncSummary {
  return {
    status,
    members: 0,
    succeededProviders: 0,
    failedProviders: 0,
    skippedProviders: 0,
  };
}

function countMemberResult(summary: SyncSummary, member: MemberSyncSummary): void {
  for (const provider of ["google", "microsoft"] as const) {
    if (member[provider] === "success") summary.succeededProviders += 1;
    else if (member[provider] === "error") summary.failedProviders += 1;
    else summary.skippedProviders += 1;
  }
}

async function saveRunningStatus(
  store: MemberStore,
  memberId: string,
  provider: SyncProvider,
  now: string,
  previous: SyncStatusRecord | undefined,
  guard: SyncWriteGuard,
  expectedRevision?: string,
): Promise<void> {
  await store.saveSyncStatus({
    memberId,
    provider,
    status: "running",
    lastStartedAt: now,
    lastSucceededAt: previous?.lastSucceededAt ?? null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: now,
  }, guard, expectedRevision);
}

async function saveSuccessStatus(
  store: MemberStore,
  memberId: string,
  provider: SyncProvider,
  now: string,
  guard: SyncWriteGuard,
  expectedRevision?: string,
): Promise<void> {
  await store.saveSyncStatus({
    memberId,
    provider,
    status: "success",
    lastStartedAt: now,
    lastSucceededAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: now,
  }, guard, expectedRevision);
}

async function saveErrorStatus(
  store: MemberStore,
  memberId: string,
  provider: SyncProvider,
  now: string,
  previous: SyncStatusRecord | undefined,
  error: { code: SafeSyncErrorCode; message: string },
  guard: SyncWriteGuard,
  expectedRevision?: string,
): Promise<void> {
  await store.saveSyncStatus(errorStatus(memberId, provider, now, previous, error), guard, expectedRevision);
}

function errorStatus(
  memberId: string,
  provider: SyncProvider,
  now: string,
  previous: SyncStatusRecord | undefined,
  error: { code: SafeSyncErrorCode; message: string },
): SyncStatusRecord {
  return {
    memberId,
    provider,
    status: "error",
    lastStartedAt: now,
    lastSucceededAt: previous?.lastSucceededAt ?? null,
    lastErrorCode: error.code,
    lastErrorMessage: error.message,
    updatedAt: now,
  };
}

function classifySyncError(error: unknown): { code: SafeSyncErrorCode; message: string } {
  const code = error instanceof GoogleCalendarError || error instanceof MicrosoftGraphError
    ? error.code
    : error instanceof SyncLockLostError
      ? "lock_lost"
      : error instanceof SyncConnectionChangedError
        ? "connection_changed"
        : "sync_failed";
  return { code, message: SAFE_ERROR_MESSAGES[code] };
}

function isSupersededSync(error: unknown): boolean {
  return error instanceof SyncLockLostError || error instanceof SyncConnectionChangedError;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SyncLockLostError();
}

async function withSyncLease<T>(
  dependencies: CalendarSyncDependencies,
  initialNow: Date,
  operation: (context: SyncRunContext) => Promise<T>,
): Promise<T | null> {
  const lease = await dependencies.store.acquireSyncLock(initialNow);
  if (lease === null) return null;
  const clock = dependencies.clock ?? (() => new Date(initialNow.getTime()));
  const scheduleInterval = dependencies.scheduleInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const cancelInterval = dependencies.cancelInterval ?? ((timer) => clearInterval(timer));
  const controller = new AbortController();
  let renewal = Promise.resolve();
  let microsoftToken: Promise<string> | undefined;
  const timer = scheduleInterval(() => {
    renewal = renewal.then(async () => {
      if (controller.signal.aborted) return;
      await dependencies.store.renewSyncLock(lease, validClockDate(clock()));
    }).catch(() => {
      controller.abort();
    });
  }, HEARTBEAT_INTERVAL_MS);
  const context: SyncRunContext = {
    lease,
    signal: controller.signal,
    guard: () => ({ lease, now: () => validClockDate(clock()) }),
    getMicrosoftAccessToken: () => {
      microsoftToken ??= Promise.resolve().then(() => dependencies.getMicrosoftAccessToken());
      return microsoftToken;
    },
  };
  try {
    return await operation(context);
  } finally {
    controller.abort();
    cancelInterval(timer);
    await renewal;
    try {
      await dependencies.store.releaseSyncLock(lease);
    } catch {
      // A replaced/expired lease must never release the current run's lock.
    }
  }
}

async function mapSettledWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await mapper(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function validClockDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("同期日時が正しくありません。");
  }
  return new Date(value.getTime());
}

function validateDependencies(value: CalendarSyncDependencies): CalendarSyncDependencies {
  if (!value || typeof value !== "object") throw new Error("同期サービスの設定が正しくありません。");
  return value;
}

function validateNow(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("同期日時が正しくありません。");
  }
}

function validateRange(value: SyncRange): void {
  if (!value || typeof value !== "object"
    || !isIso(value.start)
    || !isIso(value.end)
    || !isIso(value.syncedAt)
    || Date.parse(value.start) >= Date.parse(value.end)
    || Date.parse(value.end) - Date.parse(value.start) > RANGE_BEFORE_MS + RANGE_AFTER_MS) {
    throw new Error("同期範囲が正しくありません。");
  }
}

function validateMember(value: SalesMemberRecord): void {
  if (!value || typeof value !== "object"
    || !boundedString(value.id, 256)
    || !boundedString(value.displayName, 256)
    || !boundedString(value.department, 256)
    || !boundedString(value.microsoftEmail, 320)
    || typeof value.active !== "boolean"
    || typeof value.microsoftSyncEnabled !== "boolean"
    || (value.googleConnectionStatus !== "not_connected"
      && value.googleConnectionStatus !== "connected"
      && value.googleConnectionStatus !== "reconnect_required")
    || !isIso(value.createdAt)
    || !isIso(value.updatedAt)) {
    throw new Error("同期対象メンバーが正しくありません。");
  }
}

function validateOptionalMemberId(value: string | undefined): void {
  if (value !== undefined && !boundedString(value, 256)) {
    throw new Error("同期対象メンバーが正しくありません。");
  }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\u0000")
    && !value.includes("\r")
    && !value.includes("\n");
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}
