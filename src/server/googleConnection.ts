import { createHash, randomBytes, randomUUID } from "node:crypto";

import { buildGoogleOAuthUrl } from "@/integrations/googleCalendar";
import { encryptSecret, type EncryptedSecret } from "./tokenCrypto";
import { getMemberStore, type MemberStore } from "./memberStore";

export type GoogleConnectionErrorCode =
  | "not_registered"
  | "server_config"
  | "invalid_request"
  | "invalid_state"
  | "access_denied"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "refresh_token_required"
  | "account_mismatch";

export class GoogleConnectionError extends Error {
  constructor(readonly code: GoogleConnectionErrorCode, message: string) {
    super(message);
    this.name = "GoogleConnectionError";
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface CommonDependencies {
  store?: MemberStore;
  config?: GoogleOAuthConfig;
  now?: () => string;
}

interface StartDependencies extends CommonDependencies {
  generateState?: () => string;
  generateBrowserNonce?: () => string;
}

interface CallbackDependencies extends CommonDependencies {
  fetch?: typeof fetch;
  encrypt?: (plaintext: string) => EncryptedSecret;
  generateRevision?: () => string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  return validateConfig({
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
  });
}

export async function startGoogleOAuth(
  identity: { uid: string; email: string },
  dependencies: StartDependencies = {},
): Promise<{ authorizationUrl: string; browserNonce: string; cookieSecure: boolean }> {
  const store = dependencies.store ?? getMemberStore();
  const member = await store.findActiveMemberByMicrosoftEmail(identity.email);
  if (!member) {
    throw new GoogleConnectionError("not_registered", "営業メンバーとして登録されていません。");
  }
  const config = dependencies.config === undefined ? getGoogleOAuthConfig() : validateConfig(dependencies.config);
  const now = dependencies.now?.() ?? new Date().toISOString();
  const rawState = dependencies.generateState?.() ?? randomBytes(32).toString("base64url");
  const browserNonce = dependencies.generateBrowserNonce?.() ?? randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
  await store.createOAuthState(hashState(rawState), {
    memberId: member.id,
    browserNonceHash: hashState(browserNonce),
    startedByUid: identity.uid,
    microsoftEmail: member.microsoftEmail,
    createdAt: now,
    expiresAt,
  });
  return {
    authorizationUrl: buildGoogleOAuthUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state: rawState }),
    browserNonce,
    cookieSecure: new URL(config.redirectUri).protocol === "https:",
  };
}

export async function completeGoogleOAuth(
  input: { code?: string; state?: string; error?: string; browserNonce?: string },
  dependencies: CallbackDependencies = {},
): Promise<{ memberId: string }> {
  const config = dependencies.config === undefined ? getGoogleOAuthConfig() : validateConfig(dependencies.config);
  if (!validBase64urlSecret(input.state) || !validBase64urlSecret(input.browserNonce)
    || !validOAuthResponse(input.code, input.error)) {
    throw new GoogleConnectionError("invalid_request", "Google OAuth応答が不正です。");
  }
  const store = dependencies.store ?? getMemberStore();
  const now = dependencies.now?.() ?? new Date().toISOString();
  const state = await store.consumeOAuthState(hashState(input.state), hashState(input.browserNonce), now);
  if (!state) throw new GoogleConnectionError("invalid_state", "Google OAuth stateが無効です。");
  if (input.error) {
    throw new GoogleConnectionError("access_denied", "Googleの同意が完了しませんでした。");
  }

  const fetcher = dependencies.fetch ?? fetch;
  const token = await exchangeAuthorizationCode(input.code as string, config, fetcher);
  const userinfo = await fetchUserinfo(token.accessToken, fetcher);
  const existing = await store.getConnection(state.memberId);
  if (existing && existing.googleSubject !== userinfo.sub) {
    throw new GoogleConnectionError("account_mismatch", "以前と同じGoogleアカウントで再度連携してください。");
  }

  let encrypted: EncryptedSecret;
  let connectedAt = now;
  if (token.refreshToken) {
    encrypted = (dependencies.encrypt ?? encryptSecret)(token.refreshToken);
  } else {
    if (!existing) {
      throw new GoogleConnectionError("refresh_token_required", "再度Google連携を開始してください。");
    }
    encrypted = {
      ciphertext: existing.encryptedRefreshToken,
      iv: existing.tokenIv,
      authTag: existing.tokenAuthTag,
    };
    connectedAt = existing.connectedAt;
  }

  await store.saveConnection({
    memberId: state.memberId,
    revision: dependencies.generateRevision?.() ?? randomUUID(),
    googleSubject: userinfo.sub,
    googleEmail: userinfo.email,
    calendarId: "primary",
    encryptedRefreshToken: encrypted.ciphertext,
    tokenIv: encrypted.iv,
    tokenAuthTag: encrypted.authTag,
    connectedAt,
    updatedAt: now,
  }, {
    memberId: state.memberId,
    startedByUid: state.startedByUid,
    microsoftEmail: state.microsoftEmail,
  });
  return { memberId: state.memberId };
}

function validateConfig(config: GoogleOAuthConfig): GoogleOAuthConfig {
  if (!nonEmpty(config.clientId) || !nonEmpty(config.clientSecret) || !nonEmpty(config.redirectUri)) {
    throw new GoogleConnectionError("server_config", "Google OAuth設定が不足しています。");
  }
  try {
    const redirect = new URL(config.redirectUri);
    const isLoopback = redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]";
    if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && isLoopback)) throw new Error("unsafe redirect");
  } catch {
    throw new GoogleConnectionError("server_config", "Google OAuth設定が不足しています。");
  }
  return config;
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

async function exchangeAuthorizationCode(
  code: string,
  config: GoogleOAuthConfig,
  fetcher: typeof fetch,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
  try {
    const response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("upstream");
    const value = await readLimitedJson(response);
    const record = objectRecord(value);
    const accessToken = boundedString(record.access_token, 8_192);
    if (!accessToken) throw new Error("invalid response");
    const refreshToken = record.refresh_token === undefined ? undefined : boundedString(record.refresh_token, 8_192);
    if (record.refresh_token !== undefined && !refreshToken) throw new Error("invalid response");
    return { accessToken, ...(refreshToken ? { refreshToken } : {}) };
  } catch {
    throw new GoogleConnectionError("token_exchange_failed", "Google認証情報を取得できませんでした。");
  }
}

async function fetchUserinfo(
  accessToken: string,
  fetcher: typeof fetch,
): Promise<{ sub: string; email: string }> {
  try {
    const response = await fetcher("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("upstream");
    const value = await readLimitedJson(response);
    const record = objectRecord(value);
    const sub = boundedString(record.sub, 255);
    const email = boundedString(record.email, 320);
    if (!sub || !email || record.email_verified !== true) throw new Error("invalid response");
    return { sub, email };
  } catch {
    throw new GoogleConnectionError("userinfo_failed", "Googleアカウントを確認できませんでした。");
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
  return value as Record<string, unknown>;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const maximumBytes = 64 * 1024;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) throw new Error("response too large");
  if (!response.body) throw new Error("invalid response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let streamEnded = false;
  while (!streamEnded) {
    const { done, value } = await reader.read();
    streamEnded = done;
    if (done) continue;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function boundedString(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validBase64urlSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validOAuthResponse(code: unknown, error: unknown): boolean {
  const hasCode = typeof code === "string" && code.length > 0 && code.length <= 4_096;
  const hasError = typeof error === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(error);
  return hasCode !== hasError;
}
