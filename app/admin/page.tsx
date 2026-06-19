import { AdminMembers } from "@/components/AdminMembers";
import { salesMembers } from "@/data/demo";

export default function AdminPage() {
  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">管理</p>
          <h1>営業メンバー設定</h1>
        </div>
      </header>
      <AdminMembers initialMembers={salesMembers} />
    </main>
  );
}
