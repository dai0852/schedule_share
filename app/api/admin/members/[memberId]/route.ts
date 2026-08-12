import { NextResponse } from "next/server";

import { canManage } from "@/domain/access";
import { requireAppUser } from "@/server/auth";
import {
  isMissingMemberError,
  MemberAdminInputError,
  parseUpdateMemberInput,
} from "@/server/memberAdmin";
import { getMemberStore } from "@/server/memberStore";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ memberId: string }> },
) {
  try {
    const user = await requireAppUser(request);
    if (!canManage(user)) {
      return NextResponse.json({ error: "管理者権限が必要です。" }, { status: 403 });
    }
    const body = await request.json().catch(() => {
      throw new MemberAdminInputError("JSON形式の入力が必要です。");
    });
    const { memberId } = await context.params;
    const member = await getMemberStore().updateMember(memberId, parseUpdateMemberInput(body));
    return NextResponse.json({ member });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof MemberAdminInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (isMissingMemberError(error)) {
      return NextResponse.json({ error: "指定されたメンバーが見つかりません。" }, { status: 404 });
    }
    return NextResponse.json({ error: "メンバー更新に失敗しました。" }, { status: 500 });
  }
}
