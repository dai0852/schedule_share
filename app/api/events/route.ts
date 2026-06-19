import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth";
import { listEvents } from "@/server/events";

export async function GET(request: Request) {
  try {
    await requireAppUser(request);
    const url = new URL(request.url);
    const events = await listEvents({
      start: url.searchParams.get("start") ?? undefined,
      end: url.searchParams.get("end") ?? undefined,
      ownerUserId: url.searchParams.get("ownerUserId") ?? undefined,
      source: (url.searchParams.get("source") as never) ?? undefined,
    });
    return NextResponse.json({ events });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "予定の取得に失敗しました。" }, { status: 500 });
  }
}
