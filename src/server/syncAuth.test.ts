import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/domain/access";
import { isConfiguredSyncSecret, isValidSyncSecret, requireAdminSyncRequest } from "./syncAuth";

const mocks = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
}));

vi.mock("./auth", () => ({ requireAppUser: mocks.requireAppUser }));

const admin: AppUser = { uid: "admin-1", email: "admin@example.com", role: "admin" };
const viewer: AppUser = { uid: "viewer-1", email: "viewer@example.com", role: "viewer" };
const configuredSecret = "0123456789abcdef0123456789abcdef";

function request(headers: HeadersInit = {}): Request {
  return new Request("http://localhost/api/admin/sync", { method: "POST", headers });
}

describe("isValidSyncSecret", () => {
  it.each([32, 64, 256])("%i文字のASCII server secretを設定可能と判定する", (length) => {
    expect(isConfiguredSyncSecret("a".repeat(length))).toBe(true);
  });

  it.each([undefined, "", "short", "a".repeat(257), `${configuredSecret.slice(0, -1)}あ`, `${configuredSecret.slice(0, -1)} `])(
    "不正なserver secret設定を拒否する: %s",
    (configured) => {
      expect(isConfiguredSyncSecret(configured)).toBe(false);
    },
  );

  it.each([
    ["未設定の受信secret", undefined, configuredSecret],
    ["未設定のserver secret", configuredSecret, undefined],
    ["空の受信secret", "", configuredSecret],
    ["空のserver secret", configuredSecret, ""],
    ["短すぎるserver secret", "short", "short"],
    ["異なるsecret", "fedcba9876543210fedcba9876543210", configuredSecret],
    ["長さが異なるsecret", `${configuredSecret}x`, configuredSecret],
    ["Unicodeを含むsecret", `${configuredSecret.slice(0, -1)}あ`, configuredSecret],
    ["空白を含むsecret", `${configuredSecret.slice(0, -1)} `, configuredSecret],
    ["カンマを含むsecret", `${configuredSecret.slice(0, -1)},`, configuredSecret],
    ["上限を超えるsecret", "a".repeat(257), "a".repeat(257)],
  ])("%sを拒否する", (_name, provided, configured) => {
    expect(isValidSyncSecret(provided, configured)).toBe(false);
  });

  it("同じ十分な長さのASCII secretだけを受理する", () => {
    expect(isValidSyncSecret(configuredSecret, configuredSecret)).toBe(true);
  });

  it.each([
    ["valid 32", configuredSecret, configuredSecret, true],
    ["valid 64", "a".repeat(64), "a".repeat(64), true],
    ["valid 256", "a".repeat(256), "a".repeat(256), true],
    ["wrong same length", "fedcba9876543210fedcba9876543210", configuredSecret, false],
    ["wrong length", `${configuredSecret}x`, configuredSecret, false],
    ["missing", undefined, configuredSecret, false],
    ["Unicode", `${configuredSecret.slice(0, -1)}あ`, configuredSecret, false],
    ["oversize", "a".repeat(257), configuredSecret, false],
    ["invalid config", configuredSecret, "short", false],
  ])("%sでもtimingSafeEqualへ常に32-byte digestを渡す", (_name, provided, configured, expected) => {
    const compare = vi.fn<(left: Uint8Array, right: Uint8Array) => boolean>((left, right) =>
      Buffer.from(left).equals(Buffer.from(right)));

    expect(isValidSyncSecret(provided, configured, compare)).toBe(expected);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][0]).toHaveLength(32);
    expect(compare.mock.calls[0][1]).toHaveLength(32);
  });
});

describe("requireAdminSyncRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAppUser.mockResolvedValue(admin);
  });

  it("requireAppUserの未認証Responseをそのまま返す", async () => {
    const unauthorized = new Response("認証が必要です。", { status: 401 });
    mocks.requireAppUser.mockRejectedValue(unauthorized);

    await expect(requireAdminSyncRequest(request())).rejects.toBe(unauthorized);
  });

  it("非adminを固定403で拒否する", async () => {
    mocks.requireAppUser.mockResolvedValue(viewer);

    const error = await requireAdminSyncRequest(request({ authorization: "Bearer viewer-token" })).catch((reason) => reason);

    expect(error).toBeInstanceOf(Response);
    expect(error.status).toBe(403);
    await expect(error.json()).resolves.toEqual({ error: "管理者権限が必要です。" });
  });

  it("adminを返す", async () => {
    await expect(requireAdminSyncRequest(request({ authorization: "Bearer token" }))).resolves.toEqual(admin);
    expect(mocks.requireAppUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Cookieだけ", { cookie: "session=secret" }],
    ["空Bearer", { authorization: "Bearer " }],
    ["複数credential", { authorization: "Bearer token, Bearer second" }],
    ["巨大token", { authorization: `Bearer ${"a".repeat(8193)}` }],
  ])("adminでも%sのrequestは固定401で拒否する", async (_name, headers) => {
    const error = await requireAdminSyncRequest(request(headers)).catch((reason) => reason);

    expect(error).toBeInstanceOf(Response);
    expect(error.status).toBe(401);
    await expect(error.json()).resolves.toEqual({ error: "認証が必要です。" });
  });
});
