"use client";

import { ExternalLink, KeyRound } from "lucide-react";

export function GoogleConnectPanel() {
  const configured = Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);
  return (
    <section className="adminSurface">
      <div className="scheduleHeader">
        <div>
          <p className="eyebrow">OAuth</p>
          <h2>読み取り専用で接続</h2>
        </div>
        <KeyRound aria-hidden="true" size={20} />
      </div>
      <p className="plainText">
        営業メンバーごとにGoogle Calendar読み取りを許可し、予定の作成や編集はGoogle Calendar側で行います。
      </p>
      <button className="primaryButton" disabled={!configured}>
        <ExternalLink aria-hidden="true" size={16} />
        Google Calendarを接続
      </button>
      {!configured ? (
        <p className="emptyText">Google OAuthクライアント設定後に接続ボタンを有効化します。</p>
      ) : null}
    </section>
  );
}
