import { NextResponse } from "next/server";
import { canManage } from "@/domain/access";
import { requireAppUser } from "@/server/auth";
import {
  isDuplicateMemberError,
  MemberAdminInputError,
  parseCreateMemberInput,
  toAdminSyncStatuses,
} from "@/server/memberAdmin";
import { getMemberStore } from "@/server/memberStore";

export async function GET(request: Request) {
  try {
    const user = await requireAppUser(request);
    if (!canManage(user)) {
      return NextResponse.json({ error: "管理者権限が必要です。" }, { status: 403 });
    }
    const store = getMemberStore();
    const [members, syncStatuses] = await Promise.all([
      store.listMembers(),
      store.getSyncStatuses(),
    ]);
    return NextResponse.json({ members, syncStatuses: toAdminSyncStatuses(syncStatuses) });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "メンバー取得に失敗しました。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAppUser(request);
    if (!canManage(user)) {
      return NextResponse.json({ error: "管理者権限が必要です。" }, { status: 403 });
    }
    const body = await request.json().catch(() => {
      throw new MemberAdminInputError("JSON形式の入力が必要です。");
    });
    const member = await getMemberStore().createMember(parseCreateMemberInput(body));
    return NextResponse.json({ member }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof MemberAdminInputError || isDuplicateMemberError(error)) {
      const message = error instanceof MemberAdminInputError
        ? error.message
        : "同じMicrosoftメールアドレスのメンバーは既に登録されています。";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "メンバー登録に失敗しました。" }, { status: 500 });
  }
}
