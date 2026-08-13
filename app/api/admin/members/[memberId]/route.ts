import { NextResponse } from "next/server";

import { canManage } from "@/domain/access";
import { requireAppUser } from "@/server/auth";
import {
  isDuplicateMemberError,
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
    if (isDuplicateMemberError(error)) {
      return NextResponse.json({ error: "同じMicrosoftメールアドレスのメンバーは既に登録されています。" }, { status: 400 });
    }
    if (isMissingMemberError(error)) {
      return NextResponse.json({ error: "指定されたメンバーが見つかりません。" }, { status: 404 });
    }
    return NextResponse.json({ error: "メンバー更新に失敗しました。" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ memberId: string }> },
) {
  try {
    const user = await requireAppUser(request);
    if (!canManage(user)) {
      return NextResponse.json({ error: "管理者権限が必要です。" }, { status: 403 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "メンバー削除に失敗しました。" }, { status: 500 });
  }

  const store = getMemberStore();
  let lease: Awaited<ReturnType<typeof store.acquireSyncLock>> = null;
  try {
    lease = await store.acquireSyncLock(new Date());
    if (!lease) {
      return NextResponse.json(
        { error: "予定の同期処理中です。しばらくしてからもう一度お試しください。" },
        { status: 409 },
      );
    }
    const { memberId } = await context.params;
    await store.deleteMember(memberId, { lease, now: () => new Date() });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (isMissingMemberError(error)) {
      return NextResponse.json({ error: "指定されたメンバーが見つかりません。" }, { status: 404 });
    }
    return NextResponse.json({ error: "メンバー削除に失敗しました。" }, { status: 500 });
  } finally {
    if (lease) await store.releaseSyncLock(lease).catch(() => undefined);
  }
}
