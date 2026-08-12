import { NextResponse } from "next/server";

import { requireAppUser } from "@/server/auth";
import { toActivePublicMembers } from "@/server/memberAdmin";
import { getMemberStore } from "@/server/memberStore";

export async function GET(request: Request) {
  try {
    await requireAppUser(request);
    const members = toActivePublicMembers(await getMemberStore().listMembers());
    return NextResponse.json({ members });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "メンバー取得に失敗しました。" }, { status: 500 });
  }
}
