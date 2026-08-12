import { describe, expect, it } from "vitest";

import type { SalesMemberRecord } from "@/domain/member";
import {
  parseCreateMemberInput,
  parseUpdateMemberInput,
  toAdminSyncStatuses,
  toActivePublicMembers,
} from "./memberAdmin";
import type { SyncStatusRecord } from "./memberStore";

const member: SalesMemberRecord = {
  id: "member-1",
  displayName: "佐藤 花子",
  department: "営業一課",
  microsoftEmail: "hanako@example.com",
  active: true,
  microsoftSyncEnabled: true,
  googleConnectionStatus: "connected",
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};

describe("member admin request parser", () => {
  it("作成入力の許可フィールドを受け取る", () => {
    expect(parseCreateMemberInput({
      displayName: " 佐藤 花子 ",
      department: " 営業一課 ",
      microsoftEmail: " HANAKO@EXAMPLE.COM ",
    })).toEqual({
      displayName: "佐藤 花子",
      department: "営業一課",
      microsoftEmail: "hanako@example.com",
    });
  });

  it.each([
    ["空の氏名", { displayName: " ", department: "営業", microsoftEmail: "a@example.com" }],
    ["空の部署", { displayName: "佐藤", department: " ", microsoftEmail: "a@example.com" }],
    ["不正なメール", { displayName: "佐藤", department: "営業", microsoftEmail: "invalid" }],
    ["文字列でない値", { displayName: 42, department: "営業", microsoftEmail: "a@example.com" }],
    ["未知フィールド", { displayName: "佐藤", department: "営業", microsoftEmail: "a@example.com", token: "secret" }],
  ])("%sを拒否する", (_label, input) => {
    expect(() => parseCreateMemberInput(input)).toThrow();
  });

  it("更新入力の許可フィールドを受け取る", () => {
    expect(parseUpdateMemberInput({ active: false, microsoftSyncEnabled: true })).toEqual({
      active: false,
      microsoftSyncEnabled: true,
    });
  });

  it.each([
    ["空オブジェクト", {}],
    ["未知フィールド", { microsoftEmail: "new@example.com" }],
    ["文字列の真偽値", { active: "false" }],
    ["null", null],
  ])("PATCHで%sを拒否する", (_label, input) => {
    expect(() => parseUpdateMemberInput(input)).toThrow();
  });
});

describe("toActivePublicMembers", () => {
  it("activeメンバーをid・displayName・departmentだけに限定する", () => {
    expect(toActivePublicMembers([
      member,
      { ...member, id: "member-2", microsoftEmail: "secret@example.com", active: false },
    ])).toEqual([{ id: "member-1", displayName: "佐藤 花子", department: "営業一課" }]);
  });
});

describe("toAdminSyncStatuses", () => {
  const baseStatus: SyncStatusRecord = {
    memberId: "member-1",
    provider: "google",
    status: "error",
    lastStartedAt: "2026-08-11T08:55:00.000Z",
    lastSucceededAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: "2026-08-11T09:00:00.000Z",
  };

  it.each([
    ["invalid_grant", "Googleカレンダーの再接続が必要です。"],
    ["reconnect_required", "Googleカレンダーの再接続が必要です。"],
    ["permission_denied", "Microsoftカレンダーの読み取り権限を確認してください。"],
    ["rate_limited", "予定サービスが混み合っています。次回の同期で再試行します。"],
    ["upstream_unavailable", "予定サービスへ接続できませんでした。次回の同期で再試行します。"],
    ["invalid_response", "予定サービスから無効な応答を受信しました。"],
    ["server_config", "カレンダー連携のサーバー設定を確認してください。"],
    ["invalid_request", "カレンダー同期の設定が正しくありません。"],
    ["upstream_rejected", "予定サービスへのリクエストが拒否されました。"],
    ["timeout", "予定サービスへの接続がタイムアウトしました。次回の同期で再試行します。"],
    ["lock_lost", "同期ロックが失効したため、この同期結果は保存されませんでした。"],
    ["connection_changed", "Googleカレンダー接続が更新されたため、この同期結果は保存されませんでした。"],
    ["sync_failed", "カレンダーの同期に失敗しました。次回の同期で再試行します。"],
  ])("既知の同期エラー %s を安全な案内へ変換する", (code, summary) => {
    expect(toAdminSyncStatuses([{ ...baseStatus, lastErrorCode: code }])).toEqual([
      expect.objectContaining({ lastErrorCode: code, lastErrorSummary: summary }),
    ]);
  });

  it("未知codeと生messageを固定文言に置き換え、秘密を出力しない", () => {
    const rawSecret = "Bearer secret-token user@example.com https://firestore.googleapis.com/internal";
    const result = toAdminSyncStatuses([{
      ...baseStatus,
      lastErrorCode: "firebase_permission_error",
      lastErrorMessage: rawSecret,
    }]);

    expect(result).toEqual([expect.objectContaining({
      lastErrorCode: "unknown",
      lastErrorSummary: "同期に失敗しました。",
    })]);
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(result)).not.toContain("lastErrorMessage");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("user@example.com");
    expect(JSON.stringify(result)).not.toContain("firestore.googleapis.com");
  });

  it("エラー情報がない成功状態ではエラー項目をnullにする", () => {
    expect(toAdminSyncStatuses([{
      ...baseStatus,
      status: "success",
      lastErrorCode: null,
      lastErrorMessage: null,
    }])).toEqual([expect.objectContaining({ lastErrorCode: null, lastErrorSummary: null })]);
  });
});
