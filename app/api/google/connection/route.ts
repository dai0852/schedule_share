import { NextResponse } from "next/server";

import { requireAppUser } from "@/server/auth";
import { getMemberStore } from "@/server/memberStore";

const NO_STORE = { "cache-control": "no-store" };

export async function DELETE(request: Request) {
  try {
    const user = await requireAppUser(request);
    const store = getMemberStore();
    const member = await store.findActiveMemberByMicrosoftEmail(user.email);
    if (!member) {
      return NextResponse.json({ error: "営業メンバーとして登録されていません。" }, { status: 403, headers: NO_STORE });
    }
    await store.deleteConnection(member.id);
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set("cache-control", "no-store");
      return error;
    }
    return NextResponse.json({ error: "Google連携を解除できませんでした。" }, { status: 500, headers: NO_STORE });
  }
}
