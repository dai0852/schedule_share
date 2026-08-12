import { NextResponse } from "next/server";
import { PUBLIC_EVENTS_RESPONSE_MAX_BYTES, type CalendarSource, type EventFilters } from "@/domain/schedule";
import { requireAppUser } from "@/server/auth";
import { listEvents, toPublicEvent } from "@/server/events";

const ALLOWED_QUERY_FIELDS = new Set(["start", "end", "ownerUserId", "source"]);
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

export async function GET(request: Request) {
  try {
    await requireAppUser(request);
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "予定の取得に失敗しました。" }, { status: 500 });
  }

  try {
    const url = new URL(request.url);
    const filters = parseEventFilters(url.searchParams);
    const events = await listEvents(filters);
    const payload = JSON.stringify({ events: events.map(toPublicEvent) });
    if (new TextEncoder().encode(payload).byteLength > PUBLIC_EVENTS_RESPONSE_MAX_BYTES) {
      throw new EventResponseTooLargeError();
    }
    return new Response(payload, {
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof InvalidEventQueryError) {
      return NextResponse.json({ error: "予定の検索条件が正しくありません。" }, { status: 400 });
    }
    return NextResponse.json({ error: "予定の取得に失敗しました。" }, { status: 500 });
  }
}

class InvalidEventQueryError extends Error {}
class EventResponseTooLargeError extends Error {}

function parseEventFilters(searchParams: URLSearchParams): EventFilters {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_FIELDS.has(key) || searchParams.getAll(key).length !== 1) invalidQuery();
  }
  const start = requiredBoundary(searchParams.get("start"));
  const end = requiredBoundary(searchParams.get("end"));
  if (boundaryKind(start) !== boundaryKind(end)) invalidQuery();
  const startMs = boundaryEpoch(start);
  const endMs = boundaryEpoch(end);
  if (startMs >= endMs || endMs - startMs > MAX_RANGE_MS) invalidQuery();

  const ownerValue = searchParams.get("ownerUserId");
  const ownerUserId = ownerValue === null ? undefined : publicMemberId(ownerValue);
  const sourceValue = searchParams.get("source");
  const source = sourceValue === null ? undefined : calendarSource(sourceValue);
  return { start, end, ...(ownerUserId ? { ownerUserId } : {}), ...(source ? { source } : {}) };
}

function requiredBoundary(value: string | null): string {
  if (value === null || value.length > 64 || (!validDateOnly(value) && !validRfc3339(value))) invalidQuery();
  return value;
}

function validDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return Boolean(match && validDateParts(match[1], match[2], match[3]));
}

function validRfc3339(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(value);
  return Boolean(match && validDateParts(match[1], match[2], match[3]) && Number.isFinite(Date.parse(value)));
}

function validDateParts(yearValue: string, monthValue: string, dayValue: string): boolean {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function boundaryKind(value: string): "date" | "timestamp" {
  return validDateOnly(value) ? "date" : "timestamp";
}

function boundaryEpoch(value: string): number {
  const parsed = Date.parse(validDateOnly(value) ? `${value}T00:00:00.000+09:00` : value);
  if (!Number.isSafeInteger(parsed)) invalidQuery();
  return parsed;
}

function publicMemberId(value: string): string {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalidQuery();
  return value;
}

function calendarSource(value: string): CalendarSource {
  if (value !== "google" && value !== "microsoft" && value !== "teams") invalidQuery();
  return value;
}

function invalidQuery(): never {
  throw new InvalidEventQueryError();
}
