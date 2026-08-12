import { demoEvents } from "@/data/demo";
import {
  eventBoundaryToEpochMs,
  filterEvents,
  sanitizeEventLocation,
  sanitizeEventTitle,
  sortEvents,
  type CalendarSource,
  type EventFilters,
  type NormalizedEvent,
} from "@/domain/schedule";
import type { SalesMemberRecord } from "@/domain/member";
import { getAdminFirestore, hasFirebaseAdminConfig } from "@/lib/firebase/admin";
import { getMemberStore } from "@/server/memberStore";

const MAX_PUBLIC_EVENTS = 1_000;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const EVENT_FIELDS = new Set([
  "eventId", "source", "sourceEventId", "ownerUserId", "ownerName", "calendarId",
  "title", "location", "start", "end", "isOnlineMeeting", "visibility", "updatedAt",
  "startEpochMs", "endEpochMs",
]);

type ValidatedEventFilters = Required<Pick<EventFilters, "start" | "end">>
  & Pick<EventFilters, "ownerUserId" | "source">;

type FirestoreQuery = {
  where(field: string, operator: string, value: unknown): FirestoreQuery;
  limit(maximum: number): { get(): Promise<{ docs: Array<{ data(): unknown }> }> };
};

export interface EventDependencies {
  listMembers(): Promise<SalesMemberRecord[]>;
}

const defaultDependencies: EventDependencies = {
  listMembers: () => getMemberStore().listMembers(),
};

export async function listEvents(
  filters: EventFilters,
  dependencies: EventDependencies = defaultDependencies,
): Promise<NormalizedEvent[]> {
  const safeFilters = validateEventFilters(filters);
  const production = process.env.NODE_ENV === "production";
  const useFirestore = process.env.USE_FIRESTORE === "true";

  if (production || useFirestore) {
    if (!useFirestore || !hasFirebaseAdminConfig()) {
      throw new Error("予定データ設定が不足しています。");
    }
    const activeOwnerIds = await getActiveOwnerIds(dependencies);
    if (safeFilters.ownerUserId && !activeOwnerIds.has(safeFilters.ownerUserId)) return [];
    const events = await listFirestoreEvents(safeFilters);
    return sortEvents(filterPublicEvents(events, safeFilters)
      .filter((event) => activeOwnerIds.has(event.ownerUserId)));
  }

  if (process.env.ALLOW_DEMO_AUTH === "true") {
    return sortEvents(filterPublicEvents([...demoEvents], safeFilters));
  }

  throw new Error("予定データ設定が不足しています。");
}

async function getActiveOwnerIds(dependencies: EventDependencies): Promise<Set<string>> {
  const members = await dependencies.listMembers();
  if (!Array.isArray(members)) invalidStoredEvents();
  const allIds = new Set<string>();
  const activeIds = new Set<string>();
  for (const member of members) {
    if (!member || typeof member !== "object"
      || typeof member.active !== "boolean"
      || allIds.has(member.id)) invalidStoredEvents();
    const id = validatePublicMemberId(member.id);
    allIds.add(id);
    if (member.active) activeIds.add(id);
  }
  return activeIds;
}

async function listFirestoreEvents(filters: ValidatedEventFilters): Promise<NormalizedEvent[]> {
  let query = getAdminFirestore().collection("events") as unknown as FirestoreQuery;
  if (filters.ownerUserId) query = query.where("ownerUserId", "==", filters.ownerUserId);
  if (filters.source) query = query.where("source", "==", filters.source);
  query = query
    .where("startEpochMs", "<", boundaryToEpochMs(filters.end))
    .where("endEpochMs", ">", boundaryToEpochMs(filters.start));

  const snapshot = await query.limit(MAX_PUBLIC_EVENTS + 1).get();
  if (!Array.isArray(snapshot.docs) || snapshot.docs.length > MAX_PUBLIC_EVENTS) invalidStoredEvents();
  try {
    return snapshot.docs.map((document) => decodeStoredEvent(document.data()));
  } catch {
    invalidStoredEvents();
  }
}

export function toPublicEvent(event: NormalizedEvent): NormalizedEvent {
  return {
    eventId: event.eventId,
    source: event.source,
    sourceEventId: event.sourceEventId,
    ownerUserId: event.ownerUserId,
    ownerName: event.ownerName,
    calendarId: event.calendarId,
    title: event.title,
    location: event.location,
    start: event.start,
    end: event.end,
    isOnlineMeeting: event.isOnlineMeeting,
    visibility: event.visibility,
    updatedAt: event.updatedAt,
  };
}

function validateEventFilters(filters: EventFilters): ValidatedEventFilters {
  if (!filters || typeof filters !== "object") throw new Error("予定の期間が正しくありません。");
  const start = validateBoundary(filters.start);
  const end = validateBoundary(filters.end);
  const startMs = boundaryToEpochMs(start);
  const endMs = boundaryToEpochMs(end);
  if (boundaryKind(start) !== boundaryKind(end)
    || startMs >= endMs
    || endMs - startMs > MAX_RANGE_MS) {
    throw new Error("予定の期間が正しくありません。");
  }
  const ownerUserId = filters.ownerUserId === undefined
    ? undefined
    : validatePublicMemberId(filters.ownerUserId);
  const source = filters.source === undefined ? undefined : validateSource(filters.source);
  return { start, end, ...(ownerUserId ? { ownerUserId } : {}), ...(source ? { source } : {}) };
}

function filterPublicEvents(
  events: NormalizedEvent[],
  filters: ValidatedEventFilters,
): NormalizedEvent[] {
  const normalizedFilters: EventFilters = {
    ...filters,
    start: new Date(boundaryToEpochMs(filters.start)).toISOString(),
    end: new Date(boundaryToEpochMs(filters.end)).toISOString(),
  };
  const startMs = boundaryToEpochMs(filters.start);
  const endMs = boundaryToEpochMs(filters.end);
  return filterEvents(events, normalizedFilters).filter((event) => (
    boundaryToEpochMs(event.start) < endMs && boundaryToEpochMs(event.end) > startMs
  ));
}

function decodeStoredEvent(value: unknown): NormalizedEvent {
  const record = objectRecord(value);
  if (Object.keys(record).some((key) => !EVENT_FIELDS.has(key))) invalidStoredEvents();

  const eventId = boundedString(record.eventId, 2_048);
  const source = validateSource(record.source);
  const sourceEventId = boundedString(record.sourceEventId, 1_024);
  const ownerUserId = validatePublicMemberId(record.ownerUserId);
  const ownerName = boundedString(record.ownerName, 256);
  const calendarId = boundedString(record.calendarId, 256);
  const title = boundedText(record.title);
  const location = boundedText(record.location);
  const start = validateBoundary(record.start);
  const end = validateBoundary(record.end);
  const updatedAt = validateRfc3339(record.updatedAt);
  const startEpochMs = safeInteger(record.startEpochMs);
  const endEpochMs = safeInteger(record.endEpochMs);

  if (eventId !== `${source}:${ownerUserId}:${sourceEventId}`
    || boundaryKind(start) !== boundaryKind(end)
    || boundaryToEpochMs(start) >= boundaryToEpochMs(end)
    || startEpochMs !== boundaryToEpochMs(start)
    || endEpochMs !== boundaryToEpochMs(end)
    || calendarId !== (source === "google" ? "primary" : "outlook")
    || sanitizeEventTitle(title) !== title
    || sanitizeEventLocation(location) !== location
    || typeof record.isOnlineMeeting !== "boolean"
    || (record.visibility !== "team" && record.visibility !== "private")
    || (record.visibility === "private" && (title !== "予定あり" || location !== ""))) {
    invalidStoredEvents();
  }

  return toPublicEvent({
    eventId,
    source,
    sourceEventId,
    ownerUserId,
    ownerName,
    calendarId,
    title,
    location,
    start,
    end,
    isOnlineMeeting: record.isOnlineMeeting,
    visibility: record.visibility,
    updatedAt,
  });
}

function validateBoundary(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new Error("予定の期間が正しくありません。");
  }
  if (isValidDateOnly(value) || isValidRfc3339(value)) return value;
  throw new Error("予定の期間が正しくありません。");
}

function validateRfc3339(value: unknown): string {
  if (typeof value === "string" && isValidRfc3339(value)) return value;
  invalidStoredEvents();
}

function isValidDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return Boolean(match && validDateParts(match[1], match[2], match[3]));
}

function isValidRfc3339(value: string): boolean {
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

function boundaryToEpochMs(value: string): number {
  const parsed = eventBoundaryToEpochMs(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("予定の期間が正しくありません。");
  return parsed;
}

function boundaryKind(value: string): "date" | "timestamp" {
  return isValidDateOnly(value) ? "date" : "timestamp";
}

function validatePublicMemberId(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("担当者が正しくありません。");
  }
  return value;
}

function validateSource(value: unknown): CalendarSource {
  if (value === "google" || value === "microsoft" || value === "teams") return value;
  throw new Error("予定元が正しくありません。");
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidStoredEvents();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || hasForbiddenControl(value)) {
    invalidStoredEvents();
  }
  return value;
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096 || hasForbiddenControl(value)) invalidStoredEvents();
  return value;
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidStoredEvents();
  return value;
}

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12
      || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}

function invalidStoredEvents(): never {
  throw new Error("予定データを取得できません。");
}
