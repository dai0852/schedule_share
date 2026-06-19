"use client";

import { CheckCircle2, CircleAlert, Settings } from "lucide-react";
import type { SalesMember } from "@/data/demo";

export function AdminMembers({ initialMembers }: { initialMembers: SalesMember[] }) {
  return (
    <section className="adminSurface">
      <div className="scheduleHeader">
        <div>
          <p className="eyebrow">MVP</p>
          <h2>表示対象メンバー</h2>
        </div>
        <Settings aria-hidden="true" size={20} />
      </div>
      <div className="memberTable" role="table" aria-label="営業メンバー一覧">
        <div className="memberRow header" role="row">
          <span>氏名</span>
          <span>部署</span>
          <span>Google</span>
          <span>Microsoft</span>
        </div>
        {initialMembers.map((member) => (
          <div className="memberRow" role="row" key={member.id}>
            <span>
              <strong>{member.name}</strong>
              <small>{member.email}</small>
            </span>
            <span>{member.department}</span>
            <Status enabled={member.googleConnected} />
            <Status enabled={member.microsoftSyncEnabled} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Status({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? "status ok" : "status warn"}>
      {enabled ? <CheckCircle2 aria-hidden="true" size={16} /> : <CircleAlert aria-hidden="true" size={16} />}
      {enabled ? "有効" : "未接続"}
    </span>
  );
}
