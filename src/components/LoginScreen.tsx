"use client";

import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

interface LoginScreenProps {
  error: string | null;
  initializing: boolean;
  signingIn: boolean;
  onSignIn: () => void;
  embedded?: boolean;
  title?: string;
  description?: ReactNode;
  showSignIn?: boolean;
}

export function LoginScreen({
  error,
  initializing,
  signingIn,
  onSignIn,
  embedded = false,
  title = "営業スケジュール共有",
  description,
  showSignIn = true,
}: LoginScreenProps) {
  const titleId = embedded ? "connect-login-title" : "login-title";
  const TitleHeading = embedded ? "h2" : "h1";
  const card = (
    <section className={embedded ? "loginCard embeddedLoginCard" : "loginCard"} aria-labelledby={titleId}>
      <div className="loginBadge">
        <ShieldCheck aria-hidden="true" size={18} />
        社内限定・閲覧専用
      </div>
      <p className="loginEyebrow">SALES SCHEDULE</p>
      <TitleHeading id={titleId}>{title}</TitleHeading>
      <p className="loginDescription">
        {description ?? (
          <>
            会社のMicrosoft 365アカウントでサインインしてください。
            <br />
            認証後に営業チームの予定を閲覧できます。
          </>
        )}
      </p>

      {initializing ? (
        <div className="loginStatus" role="status">
          <span className="loginSpinner" aria-hidden="true" />
          ログイン状態を確認しています…
        </div>
      ) : showSignIn ? (
        <>
          <div className="loginDivider" aria-hidden="true">
            <span>会社アカウント</span>
          </div>
          <button
            className="microsoftSignInButton"
            type="button"
            onClick={onSignIn}
            disabled={signingIn}
            aria-label={signingIn ? "サインインしています…" : "Microsoft でサインイン"}
          >
            <span className="microsoftMark" aria-hidden="true">
              <span className="microsoftRed" />
              <span className="microsoftGreen" />
              <span className="microsoftBlue" />
              <span className="microsoftYellow" />
            </span>
            <span className="microsoftButtonText" aria-hidden="true">
              <strong>Microsoft</strong>
              <span>{signingIn ? "サインインしています…" : "でサインイン"}</span>
            </span>
          </button>
        </>
      ) : null}

      {error ? (
        <p className="loginError" role="alert">
          {error}
        </p>
      ) : null}
      <p className="loginFootnote">許可された社内ドメインのアカウントのみ利用できます。</p>
    </section>
  );

  if (embedded) return card;

  return (
    <main className="loginPage">
      <div className="loginAccent loginAccentTop" aria-hidden="true" />
      <div className="loginAccent loginAccentBottom" aria-hidden="true" />
      {card}
    </main>
  );
}
