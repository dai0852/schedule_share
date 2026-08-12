import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as callbackGet } from "../../app/api/google/oauth/callback/route";
import { POST as startPost } from "../../app/api/google/oauth/start/route";
import { DELETE as connectionDelete } from "../../app/api/google/connection/route";
import { GET as meGet } from "../../app/api/me/calendar-connection/route";

const mocks = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
  startGoogleOAuth: vi.fn(),
  completeGoogleOAuth: vi.fn(),
  findActiveMemberByMicrosoftEmail: vi.fn(),
  getConnection: vi.fn(),
  getSyncStatuses: vi.fn(),
  deleteConnection: vi.fn(),
  syncAllCalendars: vi.fn(),
  after: vi.fn(),
  afterJobs: [] as Array<() => Promise<void>>,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});
vi.mock("@/server/auth", () => ({ requireAppUser: mocks.requireAppUser }));
vi.mock("@/server/googleConnection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./googleConnection")>();
  return { ...actual, startGoogleOAuth: mocks.startGoogleOAuth, completeGoogleOAuth: mocks.completeGoogleOAuth };
});
vi.mock("@/server/memberStore", () => ({
  getMemberStore: () => ({
    findActiveMemberByMicrosoftEmail: mocks.findActiveMemberByMicrosoftEmail,
    getConnection: mocks.getConnection,
    getSyncStatuses: mocks.getSyncStatuses,
    deleteConnection: mocks.deleteConnection,
  }),
}));
vi.mock("@/server/calendarSync", () => ({ syncAllCalendars: mocks.syncAllCalendars }));

const user = { uid: "user-1", email: "sato@example.com", role: "admin" as const };
const member = {
  id: "member-1", displayName: "佐藤", department: "営業", microsoftEmail: user.email, active: true,
  microsoftSyncEnabled: true, googleConnectionStatus: "connected" as const,
  createdAt: "2026-08-11T09:00:00.000Z", updatedAt: "2026-08-11T09:00:00.000Z",
};

function request(path: string, init?: RequestInit) {
  return new Request(`https://app.example.com${path}`, init);
}

describe("Google route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.afterJobs.length = 0;
    mocks.after.mockImplementation((callback: () => Promise<void>) => { mocks.afterJobs.push(callback); });
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://app.example.com/api/google/oauth/callback";
    mocks.requireAppUser.mockResolvedValue(user);
    mocks.startGoogleOAuth.mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=raw-secret",
      browserNonce: "n".repeat(43),
      cookieSecure: true,
    });
    mocks.completeGoogleOAuth.mockResolvedValue({ memberId: member.id });
    mocks.findActiveMemberByMicrosoftEmail.mockResolvedValue(member);
    mocks.getConnection.mockResolvedValue({
      googleEmail: "person@gmail.com",
      encryptedRefreshToken: "secret-cipher",
      revision: "11111111-1111-4111-8111-111111111111",
    });
    mocks.getSyncStatuses.mockResolvedValue([]);
    mocks.syncAllCalendars.mockResolvedValue({
      status: "completed", members: 1, succeededProviders: 2, failedProviders: 0, skippedProviders: 0,
    });
  });

  it.each([
    ["start", () => startPost(request("/api/google/oauth/start", { method: "POST" }))],
    ["me", () => meGet(request("/api/me/calendar-connection"))],
    ["delete", () => connectionDelete(request("/api/google/connection", { method: "DELETE" }))],
  ])("%sは認証Responseをpassthroughし、store/serviceを呼ばない", async (_name, invoke) => {
    const unauthorized = new Response("認証が必要です。", { status: 401 });
    mocks.requireAppUser.mockRejectedValue(unauthorized);
    const result = await invoke();
    expect(result).toBe(unauthorized);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(mocks.startGoogleOAuth).not.toHaveBeenCalled();
    expect(mocks.findActiveMemberByMicrosoftEmail).not.toHaveBeenCalled();
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });

  it("start成功はauthorizationUrlだけ返し、短期HttpOnly nonce cookieを設定する", async () => {
    const response = await startPost(request("/api/google/oauth/start", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=raw-secret" });
    expect(mocks.startGoogleOAuth).toHaveBeenCalledWith({ uid: user.uid, email: user.email });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`google_oauth_nonce=${"n".repeat(43)}`);
    expect(cookie).toMatch(/Path=\/api\/google\/oauth\/callback/i);
    expect(cookie).toMatch(/Max-Age=600/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(JSON.stringify(await startPost(request("/api/google/oauth/start", { method: "POST" })).then((item) => item.json()))).not.toContain("nnnnnn");
  });

  it("明示的なlocalhost HTTP redirectではSecureなしcookieで開発可能にする", async () => {
    mocks.startGoogleOAuth.mockResolvedValueOnce({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=raw-secret",
      browserNonce: "n".repeat(43),
      cookieSecure: false,
    });
    const response = await startPost(request("/api/google/oauth/start", { method: "POST" }));
    expect(response.headers.get("set-cookie")).not.toMatch(/; Secure/i);
  });

  it("start未登録はroleがadminでも403固定文言、unknownはsecretなし500", async () => {
    const { GoogleConnectionError } = await import("./googleConnection");
    mocks.startGoogleOAuth.mockRejectedValueOnce(new GoogleConnectionError("not_registered", "営業メンバーとして登録されていません。"));
    const forbidden = await startPost(request("/api/google/oauth/start", { method: "POST" }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "営業メンバーとして登録されていません。" });

    mocks.startGoogleOAuth.mockRejectedValueOnce(new Error("client-secret person@gmail.com"));
    const failed = await startPost(request("/api/google/oauth/start", { method: "POST" }));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).toBe('{"error":"Google連携を開始できませんでした。"}');
  });

  it("callback成功と失敗はallowlist済みqueryへno-store redirectする", async () => {
    const success = await callbackGet(request("/api/google/oauth/callback?code=authorization-secret&state=raw-secret", {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));
    expect(success.headers.get("location")).toBe("https://app.example.com/connect?google=connected&sync=pending");
    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(success.headers.get("referrer-policy")).toBe("no-referrer");
    expect(success.headers.get("set-cookie")).toMatch(/google_oauth_nonce=;.*Max-Age=0/i);
    expect(mocks.completeGoogleOAuth).toHaveBeenCalledWith({
      code: "authorization-secret", state: "raw-secret", error: undefined, browserNonce: "n".repeat(43),
    });
    expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
    await mocks.afterJobs.shift()?.();
    expect(mocks.syncAllCalendars).toHaveBeenCalledWith({ memberId: member.id });

    const { GoogleConnectionError } = await import("./googleConnection");
    mocks.completeGoogleOAuth.mockRejectedValueOnce(new GoogleConnectionError("account_mismatch", "person@gmail.com token-secret"));
    const failure = await callbackGet(request("/api/google/oauth/callback?code=secret-code&state=secret-state", {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));
    const location = failure.headers.get("location") ?? "";
    expect(location).toBe("https://app.example.com/connect?google=error&reason=account_mismatch");
    expect(location).not.toContain("person@gmail.com");
    expect(location).not.toContain("secret-code");
    expect(location).not.toContain("secret-state");
    expect(failure.headers.get("set-cookie")).toMatch(/google_oauth_nonce=;.*Max-Age=0/i);
  });

  it("callback初回同期失敗でもGoogle接続を維持し、安全なpendingだけをredirectする", async () => {
    mocks.syncAllCalendars.mockRejectedValueOnce(new Error("refresh-secret person@gmail.com https://provider.invalid"));
    const rejected = await callbackGet(request("/api/google/oauth/callback?code=authorization-secret&state=raw-secret", {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));
    expect(rejected.headers.get("location")).toBe("https://app.example.com/connect?google=connected&sync=pending");
    expect(rejected.headers.get("location")).not.toContain("secret");
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
    await mocks.afterJobs.shift()?.();

    mocks.syncAllCalendars.mockResolvedValueOnce({
      status: "completed", members: 1, succeededProviders: 1, failedProviders: 1, skippedProviders: 0,
    });
    const partial = await callbackGet(request("/api/google/oauth/callback?code=authorization-secret&state=raw-secret", {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));
    expect(partial.headers.get("location")).toBe("https://app.example.com/connect?google=connected&sync=pending");
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
    await mocks.afterJobs.shift()?.();

    mocks.syncAllCalendars.mockResolvedValueOnce({
      status: "completed", members: 0, succeededProviders: 0, failedProviders: 0, skippedProviders: 0,
    });
    const skipped = await callbackGet(request("/api/google/oauth/callback?code=authorization-secret&state=raw-secret", {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));
    expect(skipped.headers.get("location")).toBe("https://app.example.com/connect?google=connected&sync=pending");
    await mocks.afterJobs.shift()?.();
  });

  it("callbackは未完了の初回同期を待たず即redirectし、response-after jobへmemberIdを渡す", async () => {
    let resolveSync: (() => void) | undefined;
    mocks.syncAllCalendars.mockReturnValueOnce(new Promise((resolve) => {
      resolveSync = () => resolve({
        status: "completed", members: 1, succeededProviders: 2, failedProviders: 0, skippedProviders: 0,
      });
    }));

    const response = await callbackGet(request("/api/google/oauth/callback?code=authorization-secret&state=raw-secret", {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));

    expect(response.headers.get("location")).toBe("https://app.example.com/connect?google=connected&sync=pending");
    expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
    const job = mocks.afterJobs.shift();
    const pending = job?.();
    expect(mocks.syncAllCalendars).toHaveBeenCalledWith({ memberId: member.id });
    resolveSync?.();
    await pending;
    expect(response.headers.get("set-cookie")).toMatch(/google_oauth_nonce=;.*Max-Age=0/i);
  });

  it("response-after hookを登録できない環境でも接続を維持し安全なpendingへ戻す", async () => {
    mocks.after.mockImplementationOnce(() => { throw new Error("runtime raw-secret unavailable"); });

    const response = await callbackGet(request("/api/google/oauth/callback?code=authorization-secret&state=raw-secret", {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));

    expect(response.headers.get("location")).toBe("https://app.example.com/connect?google=connected&sync=pending");
    expect(response.headers.get("location")).not.toContain("raw-secret");
    expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });

  it("callback unknown・Google生errorも安全なreason以外を返さず、request originを信用しない", async () => {
    mocks.completeGoogleOAuth.mockRejectedValueOnce(new Error("refresh-secret person@gmail.com"));
    const unknown = await callbackGet(new Request("https://evil.example/api/google/oauth/callback?error=evil%20raw%20message&state=secret"));
    expect(unknown.headers.get("location")).toBe("https://app.example.com/connect?google=error&reason=server_error");
    expect(unknown.headers.get("referrer-policy")).toBe("no-referrer");
    expect(unknown.headers.get("set-cookie")).toMatch(/google_oauth_nonce=;.*Max-Age=0/i);
  });

  it.each([
    ["設定欠落", () => {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    }],
    ["不正redirect URI", () => {
      process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://%invalid.example/callback";
    }],
  ])("callbackの%sもrequest Hostを使わず安全redirectしてnonceをclearする", async (_name, arrange) => {
    arrange();
    const response = await callbackGet(new Request(
      `https://evil.example/api/google/oauth/callback?code=raw-secret-code&state=${"s".repeat(43)}&error=raw-secret-error`,
      { headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` } },
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/connect?google=error&reason=server_config");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toMatch(/google_oauth_nonce=;.*Path=\/api\/google\/oauth\/callback.*Max-Age=0/i);
    expect(response.headers.get("location")).not.toContain("evil.example");
    expect(response.headers.get("location")).not.toContain("raw-secret");
    expect(mocks.completeGoogleOAuth).not.toHaveBeenCalled();
  });

  it("callbackは完了結果のmemberId契約を確認してから成功扱いにする", async () => {
    mocks.completeGoogleOAuth.mockResolvedValueOnce(undefined);
    const response = await callbackGet(request(`/api/google/oauth/callback?code=code&state=${"s".repeat(43)}`, {
      headers: { cookie: `google_oauth_nonce=${"n".repeat(43)}` },
    }));
    expect(response.headers.get("location")).toBe("https://app.example.com/connect?google=error&reason=server_error");
  });

  it("meは未登録をsafe判定可能にし、登録時もtoken/raw errorを投影しない", async () => {
    mocks.findActiveMemberByMicrosoftEmail.mockResolvedValueOnce(null);
    const unregistered = await meGet(request("/api/me/calendar-connection"));
    expect(await unregistered.json()).toEqual({ registered: false, canManageMembers: true });

    mocks.getSyncStatuses.mockResolvedValueOnce([{
      memberId: member.id, provider: "google", status: "error", lastStartedAt: member.updatedAt,
      lastSucceededAt: "2026-08-10T00:00:00.000Z", lastErrorCode: "invalid_grant",
      lastErrorMessage: "Bearer raw-token person@gmail.com", updatedAt: member.updatedAt,
    }]);
    const response = await meGet(request("/api/me/calendar-connection"));
    const serialized = JSON.stringify(await response.json());
    expect(JSON.parse(serialized)).toEqual({ registered: true, canManageMembers: true, status: "connected", googleEmail: "person@gmail.com", lastSucceededAt: "2026-08-10T00:00:00.000Z", lastErrorSummary: "Googleカレンダーの再接続が必要です。" });
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("secret-cipher");
    expect(serialized).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("meは非管理者に管理者権限を付与しない", async () => {
    mocks.requireAppUser.mockResolvedValueOnce({ ...user, role: "sales_member" });

    const response = await meGet(request("/api/me/calendar-connection"));

    expect(await response.json()).toEqual(expect.objectContaining({
      registered: true,
      canManageMembers: false,
    }));
  });

  it("deleteはactiveメンバー本人のmemberIdだけを削除する", async () => {
    const response = await connectionDelete(request("/api/google/connection", { method: "DELETE" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.deleteConnection).toHaveBeenCalledWith(member.id);

    mocks.findActiveMemberByMicrosoftEmail.mockResolvedValueOnce(null);
    const forbidden = await connectionDelete(request("/api/google/connection", { method: "DELETE" }));
    expect(forbidden.status).toBe(403);
    expect(mocks.deleteConnection).toHaveBeenCalledTimes(1);
  });
});
