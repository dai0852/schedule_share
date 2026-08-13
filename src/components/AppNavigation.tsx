import { CalendarDays, CalendarSync, Settings } from "lucide-react";
import Link from "next/link";

interface AppNavigationProps {
  showCalendar?: boolean;
  showGoogleConnection?: boolean;
  googleConnectionConfigured?: boolean;
  showAdminConsole?: boolean;
  className?: string;
}

export function AppNavigation({
  showCalendar = false,
  showGoogleConnection = false,
  googleConnectionConfigured = false,
  showAdminConsole = false,
  className,
}: AppNavigationProps) {
  if (!showCalendar && !showGoogleConnection && !showAdminConsole) return null;

  return (
    <nav
      className={["appNavigation", className].filter(Boolean).join(" ")}
      aria-label="アプリ内ナビゲーション"
    >
      {showCalendar ? (
        <Link className="secondaryButton navigationButton" href="/">
          <CalendarDays aria-hidden="true" size={16} />
          カレンダーを見る
        </Link>
      ) : null}
      {showGoogleConnection ? (
        <Link className="secondaryButton navigationButton" href="/connect">
          <CalendarSync aria-hidden="true" size={16} />
          {googleConnectionConfigured ? "Googleカレンダー設定・解除" : "Googleカレンダー接続"}
        </Link>
      ) : null}
      {showAdminConsole ? (
        <Link className="secondaryButton navigationButton" href="/admin">
          <Settings aria-hidden="true" size={16} />
          管理者コンソール
        </Link>
      ) : null}
    </nav>
  );
}
