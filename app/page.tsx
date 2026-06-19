import { CalendarDays } from "lucide-react";
import { ScheduleApp } from "@/components/ScheduleApp";
import { salesMembers } from "@/data/demo";

export default function Home() {
  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">社内限定</p>
          <h1>営業スケジュール共有</h1>
        </div>
        <div className="topbarBadge">
          <CalendarDays aria-hidden="true" size={18} />
          <span>閲覧専用</span>
        </div>
      </header>
      <ScheduleApp initialMembers={salesMembers} />
    </main>
  );
}
