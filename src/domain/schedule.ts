export type CalendarSource = "google" | "microsoft" | "teams";
export type EventVisibility = "team" | "private";

export interface NormalizedEvent {
  eventId: string;
  source: CalendarSource;
  sourceEventId: string;
  ownerUserId: string;
  ownerName: string;
  calendarId: string;
  title: string;
  location: string;
  start: string;
  end: string;
  isOnlineMeeting: boolean;
  visibility: EventVisibility;
  updatedAt: string;
}

export interface EventOwnerContext {
  ownerUserId: string;
  ownerName: string;
  calendarId: string;
}

export interface GoogleCalendarEvent {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  visibility?: string;
  attendees?: unknown[];
  hangoutLink?: string;
  conferenceData?: unknown;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  updated?: string;
}

export interface MicrosoftGraphEvent {
  id?: string;
  subject?: string;
  sensitivity?: string;
  location?: { displayName?: string };
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  body?: unknown;
  attendees?: unknown[];
  onlineMeeting?: unknown;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  lastModifiedDateTime?: string;
}

export interface EventFilters {
  start?: string;
  end?: string;
  ownerUserId?: string;
  source?: CalendarSource;
}

export function mapGoogleEvent(
  event: GoogleCalendarEvent,
  owner: EventOwnerContext,
): NormalizedEvent {
  const sourceEventId = event.id ?? crypto.randomUUID();
  const visibility: EventVisibility = event.visibility === "private" ? "private" : "team";

  return {
    eventId: `google:${sourceEventId}`,
    source: "google",
    sourceEventId,
    ownerUserId: owner.ownerUserId,
    ownerName: owner.ownerName,
    calendarId: owner.calendarId,
    title: visibility === "private" ? "予定あり" : event.summary || "無題の予定",
    location: visibility === "private" ? "" : event.location || "",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    isOnlineMeeting: Boolean(event.hangoutLink || event.conferenceData),
    visibility,
    updatedAt: event.updated ?? new Date().toISOString(),
  };
}

export function mapMicrosoftEvent(
  event: MicrosoftGraphEvent,
  owner: EventOwnerContext,
): NormalizedEvent {
  const sourceEventId = event.id ?? crypto.randomUUID();
  const provider = event.onlineMeetingProvider?.toLowerCase() ?? "";
  const location = event.location?.displayName ?? "";
  const isTeams = provider.includes("teams") || location.toLowerCase().includes("teams");
  const visibility: EventVisibility = event.sensitivity === "private" ? "private" : "team";

  return {
    eventId: `${isTeams ? "teams" : "microsoft"}:${sourceEventId}`,
    source: isTeams ? "teams" : "microsoft",
    sourceEventId,
    ownerUserId: owner.ownerUserId,
    ownerName: owner.ownerName,
    calendarId: owner.calendarId,
    title: visibility === "private" ? "予定あり" : event.subject || "無題の予定",
    location: visibility === "private" ? "" : location,
    start: normalizeMicrosoftDate(event.start),
    end: normalizeMicrosoftDate(event.end),
    isOnlineMeeting: Boolean(event.isOnlineMeeting || event.onlineMeeting),
    visibility,
    updatedAt: event.lastModifiedDateTime ?? new Date().toISOString(),
  };
}

export function filterEvents(events: NormalizedEvent[], filters: EventFilters): NormalizedEvent[] {
  const startMs = filters.start ? Date.parse(filters.start) : Number.NEGATIVE_INFINITY;
  const endMs = filters.end ? Date.parse(filters.end) : Number.POSITIVE_INFINITY;

  return events.filter((event) => {
    if (filters.ownerUserId && event.ownerUserId !== filters.ownerUserId) return false;
    if (filters.source && event.source !== filters.source) return false;

    const eventStartMs = Date.parse(event.start);
    const eventEndMs = Date.parse(event.end);
    return eventStartMs < endMs && eventEndMs > startMs;
  });
}

export function sortEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.sort((a, b) => {
    const startDiff = Date.parse(a.start) - Date.parse(b.start);
    if (startDiff !== 0) return startDiff;
    return a.ownerName.localeCompare(b.ownerName, "ja");
  });
}

function normalizeMicrosoftDate(value?: { dateTime?: string; timeZone?: string }): string {
  if (!value?.dateTime) return "";
  if (/[zZ]|[+-]\d\d:\d\d$/.test(value.dateTime)) return value.dateTime;
  if (value.timeZone === "Tokyo Standard Time") return `${value.dateTime}+09:00`;
  return value.dateTime;
}
