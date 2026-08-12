import { NextResponse } from "next/server";

import { requireAppUser } from "@/server/auth";
import { GoogleConnectionError, startGoogleOAuth } from "@/server/googleConnection";

const NO_STORE = { "cache-control": "no-store" };
const OAUTH_NONCE_COOKIE = "google_oauth_nonce";
const OAUTH_CALLBACK_PATH = "/api/google/oauth/callback";

export async function POST(request: Request) {
  try {
    const user = await requireAppUser(request);
    const result = await startGoogleOAuth({ uid: user.uid, email: user.email });
    const response = NextResponse.json(
      { authorizationUrl: result.authorizationUrl },
      { headers: { ...NO_STORE, "referrer-policy": "no-referrer" } },
    );
    response.cookies.set(OAUTH_NONCE_COOKIE, result.browserNonce, {
      httpOnly: true,
      secure: result.cookieSecure,
      sameSite: "lax",
      path: OAUTH_CALLBACK_PATH,
      maxAge: 600,
    });
    return response;
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set("cache-control", "no-store");
      return error;
    }
    if (error instanceof GoogleConnectionError && error.code === "not_registered") {
      return NextResponse.json({ error: "営業メンバーとして登録されていません。" }, { status: 403, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Google連携を開始できませんでした。" }, { status: 500, headers: NO_STORE });
  }
}
