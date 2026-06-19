import { NextResponse } from "next/server";
import { canManage } from "@/domain/access";
import { salesMembers } from "@/data/demo";
import { requireAppUser } from "@/server/auth";

export async function GET(request: Request) {
  try {
    const user = await requireAppUser(request);
    if (!canManage(user)) {
      return NextResponse.json({ error: "管理者権限が必要です。" }, { status: 403 });
    }
    return NextResponse.json({ members: salesMembers });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "メンバー取得に失敗しました。" }, { status: 500 });
  }
}
