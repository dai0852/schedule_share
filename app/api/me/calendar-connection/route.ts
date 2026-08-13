import { NextResponse } from "next/server";

import { canManage } from "@/domain/access";
import { requireAppUser } from "@/server/auth";
import { toAdminSyncStatuses } from "@/server/memberAdmin";
import { getMemberStore } from "@/server/memberStore";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  try {
    const user = await requireAppUser(request);
    const canManageMembers = canManage(user);
    const store = getMemberStore();
    const member = await store.findActiveMemberByMicrosoftEmail(user.email);
    if (!member) return NextResponse.json({ registered: false, canManageMembers: false }, { headers: NO_STORE });

    const [connection, statuses] = await Promise.all([
      store.getConnection(member.id),
      store.getSyncStatuses(member.id),
    ]);
    const googleStatus = toAdminSyncStatuses(statuses).find((status) => status.provider === "google");
    return NextResponse.json({
      registered: true,
      canManageMembers,
      status: member.googleConnectionStatus,
      ...(connection ? { googleEmail: connection.googleEmail } : {}),
      ...(googleStatus?.lastSucceededAt ? { lastSucceededAt: googleStatus.lastSucceededAt } : {}),
      ...(googleStatus?.lastErrorSummary ? { lastErrorSummary: googleStatus.lastErrorSummary } : {}),
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set("cache-control", "no-store");
      return error;
    }
    return NextResponse.json({ error: "Google連携状態を取得できませんでした。" }, { status: 500, headers: NO_STORE });
  }
}
