import { normalizeMicrosoftEmail, toPublicMember, type PublicSalesMember, type SalesMemberRecord } from "@/domain/member";
import type { CreateMemberInput, SyncStatusRecord, UpdateMemberInput } from "./memberStore";

const CREATE_FIELDS = ["displayName", "department", "microsoftEmail"] as const;
const UPDATE_FIELDS = ["displayName", "department", "active", "microsoftSyncEnabled"] as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SYNC_ERROR_SUMMARIES = {
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
} as const;

export type AdminSyncErrorCode = keyof typeof SYNC_ERROR_SUMMARIES | "unknown";

export interface AdminSyncStatus {
  memberId: string;
  provider: SyncStatusRecord["provider"];
  status: SyncStatusRecord["status"];
  lastStartedAt: string;
  lastSucceededAt: string | null;
  lastErrorCode: AdminSyncErrorCode | null;
  lastErrorSummary: string | null;
  updatedAt: string;
}

export class MemberAdminInputError extends Error {}

export function parseCreateMemberInput(value: unknown): CreateMemberInput {
  const input = strictObject(value, CREATE_FIELDS);
  const microsoftEmail = normalizeMicrosoftEmail(requiredString(input.microsoftEmail, "Microsoftメールアドレス"));
  if (!EMAIL_PATTERN.test(microsoftEmail)) {
    throw new MemberAdminInputError("Microsoftメールアドレスの形式が正しくありません。");
  }
  return {
    displayName: requiredString(input.displayName, "氏名"),
    department: requiredString(input.department, "部署"),
    microsoftEmail,
  };
}

export function parseUpdateMemberInput(value: unknown): UpdateMemberInput {
  const input = strictObject(value, UPDATE_FIELDS);
  if (Object.keys(input).length === 0) {
    throw new MemberAdminInputError("更新する項目を指定してください。");
  }

  return {
    ...(input.displayName === undefined ? {} : { displayName: requiredString(input.displayName, "氏名") }),
    ...(input.department === undefined ? {} : { department: requiredString(input.department, "部署") }),
    ...(input.active === undefined ? {} : { active: requiredBoolean(input.active, "active") }),
    ...(input.microsoftSyncEnabled === undefined
      ? {}
      : { microsoftSyncEnabled: requiredBoolean(input.microsoftSyncEnabled, "microsoftSyncEnabled") }),
  };
}

export function toActivePublicMembers(members: SalesMemberRecord[]): PublicSalesMember[] {
  return members.filter((member) => member.active).map(toPublicMember);
}

export function toAdminSyncStatuses(statuses: SyncStatusRecord[]): AdminSyncStatus[] {
  return statuses.map((status) => {
    const hasError = status.status === "error" || Boolean(status.lastErrorCode || status.lastErrorMessage);
    const errorCode = hasError ? safeSyncErrorCode(status.lastErrorCode) : null;
    return {
      memberId: status.memberId,
      provider: status.provider,
      status: status.status,
      lastStartedAt: status.lastStartedAt,
      lastSucceededAt: status.lastSucceededAt ?? null,
      lastErrorCode: errorCode,
      lastErrorSummary: errorCode === null
        ? null
        : errorCode === "unknown"
          ? "同期に失敗しました。"
          : SYNC_ERROR_SUMMARIES[errorCode],
      updatedAt: status.updatedAt,
    };
  });
}

export function isDuplicateMemberError(error: unknown): boolean {
  return error instanceof Error && error.message === "同じMicrosoftメールアドレスのメンバーは既に登録されています。";
}

export function isMissingMemberError(error: unknown): boolean {
  return error instanceof Error && error.message === "指定されたメンバーが見つかりません。";
}

function safeSyncErrorCode(value: string | null | undefined): AdminSyncErrorCode {
  return value && Object.prototype.hasOwnProperty.call(SYNC_ERROR_SUMMARIES, value)
    ? value as keyof typeof SYNC_ERROR_SUMMARIES
    : "unknown";
}

function strictObject<const Fields extends readonly string[]>(
  value: unknown,
  allowedFields: Fields,
): Record<Fields[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemberAdminInputError("入力が正しくありません。");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((field) => !allowedFields.includes(field as Fields[number]))) {
    throw new MemberAdminInputError("許可されていない項目が含まれています。");
  }
  return input as Record<Fields[number], unknown>;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new MemberAdminInputError(`${fieldName}は文字列で入力してください。`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new MemberAdminInputError(`${fieldName}を入力してください。`);
  return trimmed;
}

function requiredBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new MemberAdminInputError(`${fieldName}はtrueまたはfalseで入力してください。`);
  }
  return value;
}
