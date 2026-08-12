import { CalendarDays, ShieldCheck } from "lucide-react";

import { GoogleConnectPanel } from "@/components/GoogleConnectPanel";

export default function ConnectPage() {
  return (
    <main className="connectPage">
      <header className="topbar connectTopbar">
        <div>
          <p className="eyebrow">Calendar connection</p>
          <h1>Googleカレンダー接続</h1>
        </div>
        <span className="topbarBadge"><ShieldCheck aria-hidden="true" size={16} />読み取り専用</span>
      </header>

      <div className="connectLayout">
        <aside className="connectGuide" aria-labelledby="connect-guide-title">
          <div className="connectGuideIcon"><CalendarDays aria-hidden="true" size={24} /></div>
          <p className="eyebrow">For sales members</p>
          <h2 id="connect-guide-title">一度の接続で<br />予定を自動共有</h2>
          <ol>
            <li><span>1</span>会社のMicrosoft 365アカウントでログイン</li>
            <li><span>2</span>Googleアカウントで読み取りを許可</li>
            <li><span>3</span>以後は予定を自動で同期</li>
          </ol>
          <p className="connectGuideNote">本文・参加者・会議URLは取得しません。</p>
        </aside>
        <GoogleConnectPanel />
      </div>
    </main>
  );
}
