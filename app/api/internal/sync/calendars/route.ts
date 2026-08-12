import { NextResponse } from "next/server";

import { syncAllCalendars, type SyncSummary } from "@/server/calendarSync";
import { isConfiguredSyncSecret, isValidSyncSecret } from "@/server/syncAuth";

const NO_STORE = "no-store, max-age=0";

export async function POST(request: Request) {
  const configuredSecret = process.env.SYNC_JOB_SECRET;
  if (!isConfiguredSyncSecret(configuredSecret)) {
    return jsonNoStore({ error: "同期ジョブの設定が不足しています。" }, 500);
  }
  if (!isValidSyncSecret(request.headers.get("x-sync-secret"), configuredSecret)) {
    return jsonNoStore({ error: "同期認証に失敗しました。" }, 401);
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
