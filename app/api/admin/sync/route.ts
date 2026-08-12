import { NextResponse } from "next/server";

import { syncAllCalendars, type SyncSummary } from "@/server/calendarSync";
import { requireAdminSyncRequest } from "@/server/syncAuth";

const NO_STORE = "no-store, max-age=0";

export async function POST(request: Request) {
  try {
    await requireAdminSyncRequest(request);
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set("cache-control", NO_STORE);
      return error;
    }
    return jsonNoStore({ error: "カレンダー同期を開始できませんでした。" }, 500);
  }

  try {
    const summary = await syncAllCalendars();
    return jsonNoStore(toSafeSummary(summary), 200);
  } catch {
    return jsonNoStore({ error: "カレンダー同期を開始できませんでした。" }, 500);
  }
}

function toSafeSummary(summary: SyncSummary): SyncSummary {
  if (
    (summary.status !== "completed" && summary.status !== "locked")
    || !isSafeCount(summary.members)
    || !isSafeCount(summary.succeededProviders)
    || !isSafeCount(summary.failedProviders)
    || !isSafeCount(summary.skippedProviders)
  ) {
    throw new Error("Invalid sync summary");
  }
  return {
    status: summary.status,
    members: summary.members,
    succeededProviders: summary.succeededProviders,
    failedProviders: summary.failedProviders,
    skippedProviders: summary.skippedProviders,
  };
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function jsonNoStore(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": NO_STORE },
  });
}
