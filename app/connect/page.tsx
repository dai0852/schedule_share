import { GoogleConnectPanel } from "@/components/GoogleConnectPanel";

export default function ConnectPage() {
  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">連携</p>
          <h1>Google Calendar接続</h1>
        </div>
      </header>
      <GoogleConnectPanel />
    </main>
  );
}
