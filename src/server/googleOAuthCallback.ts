import { NextResponse } from "next/server";

import {
  completeGoogleOAuth,
  getGoogleOAuthConfig,
  GoogleConnectionError,
  type GoogleConnectionErrorCode,
} from "./googleConnection";
import { syncAllCalendars } from "./calendarSync";

const OAUTH_NONCE_COOKIE = "google_oauth_nonce";
const OAUTH_CALLBACK_PATH = "/api/google/oauth/callback";

const CALLBACK_REASONS = new Set<GoogleConnectionErrorCode>([
  "server_config", "invalid_request", "invalid_state", "access_denied",
  "token_exchange_failed", "userinfo_failed", "refresh_token_required", "account_mismatch",
]);

export interface GoogleOAuthCallbackDependencies {
  completeOAuth: typeof completeGoogleOAuth;
  getConfig: typeof getGoogleOAuthConfig;
  syncCalendars: typeof syncAllCalendars;
  scheduleAfter(callback: () => Promise<void>): void;
}

export function createGoogleOAuthCallbackHandler(dependencies: GoogleOAuthCallbackDependencies) {
  return async function googleOAuthCallback(request: Request) {
    const requestUrl = new URL(request.url);
    let trustedOrigin: string | undefined;
    let secureCookie: boolean;
    try {
      const redirectUri = new URL(dependencies.getConfig().redirectUri);
      trustedOrigin = redirectUri.origin;
      secureCookie = redirectUri.protocol === "https:";
    } catch {
      return redirect(undefined, false, { google: "error", reason: "server_config" });
    }
    try {
      const completion = await dependencies.completeOAuth({
        code: requestUrl.searchParams.get("code") ?? undefined,
        state: requestUrl.searchParams.get("state") ?? undefined,
        error: requestUrl.searchParams.get("error") ?? undefined,
        browserNonce: readCookie(request.headers.get("cookie"), OAUTH_NONCE_COOKIE),
      });
      if (!completion.memberId) throw new Error("invalid completion");
      try {
        dependencies.scheduleAfter(async () => {
          try {
            await dependencies.syncCalendars({ memberId: completion.memberId });
          } catch {
            // Connection remains valid. Safe status/retry is handled by scheduled sync.
          }
        });
      } catch {
        // If response-after scheduling is unavailable, the next periodic sync recovers.
      }
      return redirect(trustedOrigin, secureCookie, { google: "connected", sync: "pending" });
    } catch (error) {
      const reason = error instanceof GoogleConnectionError && CALLBACK_REASONS.has(error.code)
        ? error.code
        : "server_error";
      return redirect(trustedOrigin, secureCookie, { google: "error", reason });
    }
  };
}

function redirect(trustedOrigin: string | undefined, secureCookie: boolean, query: Record<string, string>): NextResponse {
  const search = new URLSearchParams(query).toString();
  const relativeDestination = `/connect?${search}`;
  const destination = trustedOrigin === undefined
    ? relativeDestination
    : new URL(relativeDestination, trustedOrigin).toString();
  const response = new NextResponse(null, {
    status: 307,
    headers: {
      location: destination,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
  response.cookies.set(OAUTH_NONCE_COOKIE, "", {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: OAUTH_CALLBACK_PATH,
    maxAge: 0,
  });
  return response;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
