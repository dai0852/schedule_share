import { describe, expect, it, vi } from "vitest";

import type { CalendarConnectionRecord, MemberStore } from "./memberStore";
import {
  completeGoogleOAuth,
  GoogleConnectionError,
  startGoogleOAuth,
  type GoogleOAuthConfig,
} from "./googleConnection";

const NOW = "2026-08-11T09:00:00.000Z";
const RAW_STATE = "s".repeat(43);
const BROWSER_NONCE = "n".repeat(43);
const CONFIG: GoogleOAuthConfig = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://app.example.com/api/google/oauth/callback",
};
const member = {
  id: "member-1",
  displayName: "佐藤",
  department: "営業",
  microsoftEmail: "sato@example.com",
  active: true,
  microsoftSyncEnabled: true,
  googleConnectionStatus: "not_connected" as const,
  createdAt: NOW,
  updatedAt: NOW,
};
const identity = { uid: "firebase-uid", email: member.microsoftEmail };
const oauthState = {
  memberId: member.id,
  browserNonceHash: "nonce-hash",
  startedByUid: identity.uid,
  microsoftEmail: identity.email,
  createdAt: NOW,
  expiresAt: "2026-08-11T09:10:00.000Z",
};

function callbackInput(overrides: Partial<{ code: string; state: string; error: string; browserNonce: string }> = {}) {
  return { code: "code", state: RAW_STATE, browserNonce: BROWSER_NONCE, ...overrides };
}

function store(overrides: Partial<MemberStore> = {}): MemberStore {
  return {
    listMembers: vi.fn(), createMember: vi.fn(), updateMember: vi.fn(),
    findActiveMemberByMicrosoftEmail: vi.fn().mockResolvedValue(member),
    createOAuthState: vi.fn(), consumeOAuthState: vi.fn().mockResolvedValue(oauthState),
    getConnection: vi.fn().mockResolvedValue(null), saveConnection: vi.fn(), deleteConnection: vi.fn(),
    saveGoogleReconnectFailure: vi.fn(), saveSyncStatus: vi.fn(), getSyncStatuses: vi.fn(),
    replaceProviderEvents: vi.fn(), acquireSyncLock: vi.fn(), renewSyncLock: vi.fn(), releaseSyncLock: vi.fn(),
    ...overrides,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("Google connection service", () => {
  it("事前登録済みactiveメンバーだけにstateをhash保存してURLを返す", async () => {
    const memberStore = store();
    const result = await startGoogleOAuth(identity, {
      store: memberStore,
      config: CONFIG,
      generateState: () => RAW_STATE,
      generateBrowserNonce: () => BROWSER_NONCE,
      now: () => NOW,
    });

    expect(result).toMatchObject({ authorizationUrl: expect.stringContaining(`state=${RAW_STATE}`), browserNonce: BROWSER_NONCE, cookieSecure: true });
    expect(memberStore.createOAuthState).toHaveBeenCalledOnce();
    const [hash, stateRecord] = vi.mocked(memberStore.createOAuthState).mock.calls[0];
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(RAW_STATE);
    expect(stateRecord).toEqual({
      memberId: member.id,
      browserNonceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      startedByUid: identity.uid,
      microsoftEmail: member.microsoftEmail,
      createdAt: NOW,
      expiresAt: "2026-08-11T09:10:00.000Z",
    });
    expect(JSON.stringify(stateRecord)).not.toContain(RAW_STATE);
    expect(JSON.stringify(stateRecord)).not.toContain(BROWSER_NONCE);
  });

  it("未登録・inactive相当をroleに関係なく拒否し、stateを保存しない", async () => {
    const memberStore = store({ findActiveMemberByMicrosoftEmail: vi.fn().mockResolvedValue(null) });
    await expect(startGoogleOAuth({ uid: "admin-uid", email: "admin@example.com" }, { store: memberStore, config: CONFIG })).rejects.toMatchObject({
      message: "営業メンバーとして登録されていません。",
      code: "not_registered",
    });
    expect(memberStore.createOAuthState).not.toHaveBeenCalled();
  });

  it("server OAuth設定不足を固定エラーで拒否する", async () => {
    await expect(startGoogleOAuth(identity, {
      store: store(), config: { ...CONFIG, clientSecret: "" },
    })).rejects.toMatchObject({ code: "server_config", message: "Google OAuth設定が不足しています。" });

    await expect(startGoogleOAuth(identity, {
      store: store(), config: { ...CONFIG, redirectUri: "http://evil.example/api/google/oauth/callback" },
    })).rejects.toMatchObject({ code: "server_config" });

    await expect(startGoogleOAuth(identity, {
      store: store(),
      config: { ...CONFIG, redirectUri: "http://localhost:3000/api/google/oauth/callback" },
      generateState: () => RAW_STATE,
      generateBrowserNonce: () => BROWSER_NONCE,
      now: () => NOW,
    })).resolves.toMatchObject({ cookieSecure: false });
  });

  it("stateをhashで一度消費し、tokenとuserinfoを固定endpointへ正確に送る", async () => {
    const memberStore = store();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" }))
      .mockResolvedValueOnce(response({ sub: "google-sub", email: "person@gmail.com", email_verified: true }));

    const result = await completeGoogleOAuth(callbackInput({ code: "authorization-secret" }), {
      store: memberStore, config: CONFIG, fetch: fetcher, now: () => NOW,
      encrypt: vi.fn().mockReturnValue({ ciphertext: "cipher", iv: "iv", authTag: "tag" }),
    });

    expect(result).toEqual({ memberId: member.id });
    expect(memberStore.consumeOAuthState).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      NOW,
    );
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://oauth2.googleapis.com/token", expect.objectContaining({ method: "POST" }));
    const tokenInit = fetcher.mock.calls[0][1] as RequestInit;
    expect(Object.fromEntries(new URLSearchParams(tokenInit.body as string))).toEqual({
      code: "authorization-secret", client_id: CONFIG.clientId, client_secret: CONFIG.clientSecret,
      redirect_uri: CONFIG.redirectUri, grant_type: "authorization_code",
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://openidconnect.googleapis.com/v1/userinfo", expect.objectContaining({
      headers: { authorization: "Bearer access-secret" },
    }));
  });

  it("初回refresh token必須・再接続same sub保持・different sub拒否を分ける", async () => {
    const existing: CalendarConnectionRecord = {
      memberId: member.id, revision: "11111111-1111-4111-8111-111111111111", googleSubject: "same-sub", googleEmail: "old@gmail.com", calendarId: "primary",
      encryptedRefreshToken: "old-cipher", tokenIv: "old-iv", tokenAuthTag: "old-tag", connectedAt: NOW, updatedAt: NOW,
    };
    const firstFetcher = vi.fn().mockResolvedValueOnce(response({ access_token: "access" })).mockResolvedValueOnce(response({ sub: "same-sub", email: "new@gmail.com", email_verified: true }));
    await expect(completeGoogleOAuth(callbackInput(), { store: store(), config: CONFIG, fetch: firstFetcher })).rejects.toMatchObject({ code: "refresh_token_required" });

    const sameStore = store({ getConnection: vi.fn().mockResolvedValue(existing) });
    const sameFetcher = vi.fn().mockResolvedValueOnce(response({ access_token: "access" })).mockResolvedValueOnce(response({ sub: "same-sub", email: "new@gmail.com", email_verified: true }));
    await completeGoogleOAuth(callbackInput(), { store: sameStore, config: CONFIG, fetch: sameFetcher, now: () => NOW });
    expect(sameStore.saveConnection).toHaveBeenCalledWith(expect.objectContaining({
      encryptedRefreshToken: "old-cipher", tokenIv: "old-iv", tokenAuthTag: "old-tag", googleEmail: "new@gmail.com",
    }), expect.objectContaining({ memberId: member.id, microsoftEmail: identity.email, startedByUid: identity.uid }));

    const differentStore = store({ getConnection: vi.fn().mockResolvedValue(existing) });
    const differentFetcher = vi.fn().mockResolvedValueOnce(response({ access_token: "access" })).mockResolvedValueOnce(response({ sub: "other-sub", email: "new@gmail.com", email_verified: true }));
    await expect(completeGoogleOAuth(callbackInput(), { store: differentStore, config: CONFIG, fetch: differentFetcher })).rejects.toMatchObject({ code: "account_mismatch" });
    expect(differentStore.saveConnection).not.toHaveBeenCalled();

    const replacementStore = store({ getConnection: vi.fn().mockResolvedValue(existing) });
    const replacementFetcher = vi.fn()
      .mockResolvedValueOnce(response({ access_token: "access", refresh_token: "new-refresh" }))
      .mockResolvedValueOnce(response({ sub: "other-sub", email: "other@gmail.com", email_verified: true }));
    await expect(completeGoogleOAuth(callbackInput(), { store: replacementStore, config: CONFIG, fetch: replacementFetcher })).rejects.toMatchObject({ code: "account_mismatch" });
    expect(replacementStore.saveConnection).not.toHaveBeenCalled();
  });

  it("verified userinfoと新refresh tokenを厳格検証し、暗号化フィールドだけ保存する", async () => {
    for (const userinfo of [
      { sub: "sub", email: "x@gmail.com", email_verified: false },
      { email: "x@gmail.com", email_verified: true },
      { sub: "sub", email_verified: true },
    ]) {
      const fetcher = vi.fn().mockResolvedValueOnce(response({ access_token: "access", refresh_token: "refresh" })).mockResolvedValueOnce(response(userinfo));
      await expect(completeGoogleOAuth(callbackInput(), { store: store(), config: CONFIG, fetch: fetcher })).rejects.toBeInstanceOf(GoogleConnectionError);
    }

    const memberStore = store();
    const encrypt = vi.fn().mockReturnValue({ ciphertext: "cipher", iv: "iv", authTag: "tag" });
    const fetcher = vi.fn().mockResolvedValueOnce(response({ access_token: "access", refresh_token: "plain-refresh" })).mockResolvedValueOnce(response({ sub: "sub", email: "x@gmail.com", email_verified: true }));
    await completeGoogleOAuth(callbackInput(), {
      store: memberStore, config: CONFIG, fetch: fetcher, encrypt, now: () => NOW,
      generateRevision: () => "22222222-2222-4222-8222-222222222222",
    });
    expect(encrypt).toHaveBeenCalledWith("plain-refresh");
    const saved = vi.mocked(memberStore.saveConnection).mock.calls[0][0];
    expect(saved).toEqual({ memberId: member.id, revision: "22222222-2222-4222-8222-222222222222", googleSubject: "sub", googleEmail: "x@gmail.com", calendarId: "primary", encryptedRefreshToken: "cipher", tokenIv: "iv", tokenAuthTag: "tag", connectedAt: NOW, updatedAt: NOW });
    expect(JSON.stringify(saved)).not.toContain("plain-refresh");
  });

  it("missing・expired・replay stateとprovider errorをsafe codeへ分類する", async () => {
    for (const input of [{ code: "code" }, { state: RAW_STATE, browserNonce: BROWSER_NONCE }]) {
      await expect(completeGoogleOAuth(input, { store: store(), config: CONFIG })).rejects.toMatchObject({ code: "invalid_request" });
    }
    const missingStateStore = store({ consumeOAuthState: vi.fn().mockResolvedValue(null) });
    await expect(completeGoogleOAuth(callbackInput(), { store: missingStateStore, config: CONFIG })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(completeGoogleOAuth(callbackInput({ code: undefined as never, error: "access_denied" }), { store: store(), config: CONFIG })).rejects.toMatchObject({ code: "access_denied" });
  });

  it("state・browser nonce・code/errorの形式と長さをconsume前に拒否する", async () => {
    const memberStore = store();
    const invalidInputs = [
      callbackInput({ state: "short" }),
      callbackInput({ state: `${"s".repeat(42)}!` }),
      callbackInput({ browserNonce: "short" }),
      callbackInput({ code: "c".repeat(4097) }),
      callbackInput({ code: undefined as never, error: "e".repeat(129) }),
    ];
    for (const input of invalidInputs) {
      await expect(completeGoogleOAuth(input, { store: memberStore, config: CONFIG })).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(memberStore.consumeOAuthState).not.toHaveBeenCalled();
  });

  it("token/userinfo応答のbyte上限と各フィールド長を固定エラーで拒否する", async () => {
    const tooLarge = new Response("x".repeat(65_537), { status: 200 });
    const readAll = vi.spyOn(tooLarge, "text");
    await expect(completeGoogleOAuth(callbackInput(), {
      store: store(), config: CONFIG, fetch: vi.fn().mockResolvedValue(tooLarge),
    })).rejects.toMatchObject({ code: "token_exchange_failed" });
    expect(readAll).not.toHaveBeenCalled();

    for (const tokenBody of [
      { access_token: "a".repeat(8193), refresh_token: "refresh" },
      { access_token: "access", refresh_token: "r".repeat(8193) },
    ]) {
      const fetcher = vi.fn().mockResolvedValueOnce(response(tokenBody));
      await expect(completeGoogleOAuth(callbackInput(), { store: store(), config: CONFIG, fetch: fetcher })).rejects.toMatchObject({ code: "token_exchange_failed" });
    }

    for (const userinfo of [
      { sub: "s".repeat(256), email: "x@gmail.com", email_verified: true },
      { sub: "sub", email: `${"e".repeat(310)}@example.com`, email_verified: true },
    ]) {
      const fetcher = vi.fn().mockResolvedValueOnce(response({ access_token: "access", refresh_token: "refresh" })).mockResolvedValueOnce(response(userinfo));
      await expect(completeGoogleOAuth(callbackInput(), { store: store(), config: CONFIG, fetch: fetcher })).rejects.toMatchObject({ code: "userinfo_failed" });
    }
  });
});
