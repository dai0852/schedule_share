import { AppNavigation } from "@/components/AppNavigation";
import { AdminMembers } from "@/components/AdminMembers";

export default function AdminPage() {
  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">管理</p>
          <h1>営業メンバー設定</h1>
        </div>
        <AppNavigation showCalendar />
      </header>
      <AdminMembers />
    </main>
  );
}
