export type CalendarSource = "google" | "microsoft" | "teams";
export type EventVisibility = "team" | "private";

export const PUBLIC_EVENTS_RESPONSE_MAX_BYTES = 8 * 1_024 * 1_024;
export const CALENDAR_SOURCE_LABELS: Record<CalendarSource, string> = {
  google: "Google",
  microsoft: "Microsoft",
  teams: "Microsoft",
};

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
  id: string;
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
  id: string;
  subject?: string;
  sensitivity?: string;
  location?: { displayName?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
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
  const sourceEventId = requireSourceEventId(event.id);
  const visibility: EventVisibility = event.visibility === "private" || event.visibility === "confidential"
    ? "private"
    : "team";

  return {
    eventId: `google:${owner.ownerUserId}:${sourceEventId}`,
    source: "google",
    sourceEventId,
    ownerUserId: owner.ownerUserId,
    ownerName: owner.ownerName,
    calendarId: owner.calendarId,
    title: visibility === "private" ? "予定あり" : sanitizeEventTitle(event.summary ?? ""),
    location: visibility === "private" ? "" : sanitizeEventLocation(event.location ?? ""),
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
  const sourceEventId = requireSourceEventId(event.id);
  const location = event.location?.displayName ?? "";
  const visibility: EventVisibility = event.sensitivity === undefined || event.sensitivity === "normal"
    ? "team"
    : "private";

  return {
    eventId: `microsoft:${owner.ownerUserId}:${sourceEventId}`,
    source: "microsoft",
    sourceEventId,
    ownerUserId: owner.ownerUserId,
    ownerName: owner.ownerName,
    calendarId: owner.calendarId,
    title: visibility === "private" ? "予定あり" : sanitizeEventTitle(event.subject ?? ""),
    location: visibility === "private" ? "" : sanitizeEventLocation(location),
    start: normalizeMicrosoftDate(event.start, event.isAllDay),
    end: normalizeMicrosoftDate(event.end, event.isAllDay),
    isOnlineMeeting: Boolean(event.isOnlineMeeting || event.onlineMeeting),
    visibility,
    updatedAt: event.lastModifiedDateTime ?? new Date().toISOString(),
  };
}

export function filterEvents(events: NormalizedEvent[], filters: EventFilters): NormalizedEvent[] {
  const startMs = filters.start ? eventBoundaryToEpochMs(filters.start) : Number.NEGATIVE_INFINITY;
  const endMs = filters.end ? eventBoundaryToEpochMs(filters.end) : Number.POSITIVE_INFINITY;

  return events.filter((event) => {
    if (filters.ownerUserId && event.ownerUserId !== filters.ownerUserId) return false;
    if (filters.source && !matchesSourceFilter(event.source, filters.source)) return false;

    const eventStartMs = eventBoundaryToEpochMs(event.start);
    const eventEndMs = eventBoundaryToEpochMs(event.end);
    return eventStartMs < endMs && eventEndMs > startMs;
  });
}

function matchesSourceFilter(source: CalendarSource, filter: CalendarSource): boolean {
  if (filter === "microsoft") return source === "microsoft" || source === "teams";
  return source === filter;
}

export function sortEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.sort((a, b) => {
    const startDiff = eventBoundaryToEpochMs(a.start) - eventBoundaryToEpochMs(b.start);
    if (startDiff !== 0) return startDiff;
    return a.ownerName.localeCompare(b.ownerName, "ja");
  });
}

export function eventBoundaryToEpochMs(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000+09:00` : value);
}

function normalizeMicrosoftDate(
  value?: { dateTime?: string; timeZone?: string },
  isAllDay = false,
): string {
  if (!value?.dateTime) return "";
  if (isAllDay) return value.dateTime.slice(0, 10);
  if (/[zZ]|[+-]\d\d:\d\d$/.test(value.dateTime)) return value.dateTime;
  if (value.timeZone === "Tokyo Standard Time" || value.timeZone === "Asia/Tokyo") {
    return `${value.dateTime}+09:00`;
  }
  if (value.timeZone === "UTC") return `${value.dateTime}Z`;
  return value.dateTime;
}

export interface UrlSanitizerDiagnostics {
  scannedCodeUnits: number;
  candidateChecks: number;
}

export function sanitizeEventTitle(value: string, diagnostics?: UrlSanitizerDiagnostics): string {
  if (value.length > URL_SANITIZER_MAX_INPUT_LENGTH) return "予定あり";
  const ranges = findUrlLikeRanges(value, diagnostics);
  const containedUrl = ranges.length > 0;
  const withoutUrls = removeRanges(value, ranges);
  const preserveTrailingSlash = ranges.some((range) => range.start > 0 && value[range.start - 1] === "/");
  const normalized = trimTitlePunctuation(
    withoutUrls.replace(/\s+/gu, " ").trim(),
    preserveTrailingSlash,
  );
  if (normalized && !/^(?:url|link|リンク|会議url|参加url)$/iu.test(normalized)) return normalized;
  return containedUrl ? "予定あり" : "無題の予定";
}

export function sanitizeEventLocation(value: string, diagnostics?: UrlSanitizerDiagnostics): string {
  if (value.length > URL_SANITIZER_MAX_INPUT_LENGTH) return "";
  return containsUrlLike(value, diagnostics) ? "" : value;
}

const URL_SANITIZER_MAX_INPUT_LENGTH = 65_536;
const URL_TOKEN_TERMINATORS = new Set([
  "<", ">", '"', "'", "「", "」", "『", "』", "【", "】", "〈", "〉", "《", "》",
  "（", "）", "(", ")", "[", "]", "［", "］", "{", "}", "｛", "｝",
  "、", "。", "，", "：", "・", "！", "？", "；",
]);
const URL_TOKEN_WHITESPACE = /\s/u;
const MEETING_PATH_SEGMENTS = new Set([
  "meet", "join", "meeting", "meetup", "conference", "webinar", "call", "room",
]);
const MEETING_HOST_LABELS = new Set([
  "meet", "meeting", "meetings", "conference", "conferencing", "call", "room",
  "video", "webinar", "webconference", "videoconference",
]);
const STRONG_URL_QUERY_KEYS = new Set([
  "token", "access_token", "id_token", "auth", "authorization", "join", "meeting",
  "pwd", "password", "key", "session", "session_id", "sessionid",
]);

function containsUrlLike(value: string, diagnostics?: UrlSanitizerDiagnostics): boolean {
  return findUrlLikeRanges(value, diagnostics).length > 0;
}

function findUrlLikeRanges(
  value: string,
  diagnostics?: UrlSanitizerDiagnostics,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < value.length) {
    recordScannedCodeUnit(diagnostics);
    if (startsWithHttpScheme(value, index)) {
      recordCandidateCheck(diagnostics);
      const { end } = scanUrlToken(value, index, diagnostics);
      const candidate = value.slice(index, end);
      if (isExplicitHttpUrl(candidate)) {
        ranges.push({ start: index, end });
        index = end;
        continue;
      }
      index = findNextHttpScheme(value, index + 1, end, diagnostics) ?? end;
      continue;
    } else if (value.startsWith("//", index) && hasBareUrlBoundary(value, index)) {
      recordCandidateCheck(diagnostics);
      const { end } = scanUrlToken(value, index, diagnostics);
      const candidate = value.slice(index, end);
      if (isProtocolRelativeUrl(candidate)) {
        ranges.push({ start: index, end });
        index = end;
        continue;
      }
      index = findNextHttpScheme(value, index + 2, end, diagnostics) ?? end;
      continue;
    } else if (isPotentialBareUrlStart(value[index]) && hasBareUrlBoundary(value, index)) {
      recordCandidateCheck(diagnostics);
      const authorityProbe = probeBareAuthority(value, index, diagnostics);
      if (authorityProbe.embeddedSchemeIndex !== undefined) {
        index = authorityProbe.embeddedSchemeIndex;
        continue;
      }
      if (authorityProbe.embeddedBareUrlIndex !== undefined) {
        index = authorityProbe.embeddedBareUrlIndex;
        continue;
      }
      if (authorityProbe.isCandidate) {
        const token = scanUrlToken(value, index, diagnostics);
        const { end } = token;
        const candidate = value.slice(index, end);
        if (token.embeddedStrongBareUrlIndex !== undefined
          && isWeakSingleLabelAuthority(value.slice(index, authorityProbe.nextIndex))) {
          ranges.push({ start: token.embeddedStrongBareUrlIndex, end });
          index = end;
          continue;
        }
        if (isSchemelessUrl(candidate, authorityProbe.hasSuffix)) {
          ranges.push({ start: index, end });
          index = end;
          continue;
        }
        index = findNextHttpScheme(value, authorityProbe.nextIndex, end, diagnostics) ?? end;
        continue;
      }
      index = Math.max(index + 1, authorityProbe.nextIndex);
      continue;
    }
    index += 1;
  }
  return ranges;
}

function parseUrlAuthorityShape(
  candidate: string,
  allowSingleLabel: boolean,
): { hostname: string; port?: string; isUnbracketedIpv6: boolean } | null {
  const suffixIndex = candidate.search(/[/?#]/u);
  const authority = suffixIndex < 0 ? candidate : candidate.slice(0, suffixIndex);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (!hostAndPort) return null;

  let hostname = hostAndPort;
  let port: string | undefined;
  let isUnbracketedIpv6 = false;
  if (hostAndPort.startsWith("[")) {
    const closingBracket = hostAndPort.indexOf("]");
    if (closingBracket < 0) return null;
    hostname = hostAndPort.slice(0, closingBracket + 1);
    const remainder = hostAndPort.slice(closingBracket + 1);
    if (remainder) {
      if (!remainder.startsWith(":")) return null;
      port = remainder.slice(1);
    }
  } else {
    const colonCount = countCharacter(hostAndPort, ":");
    if (colonCount > 1) {
      isUnbracketedIpv6 = true;
    } else if (colonCount === 1) {
      const colonIndex = hostAndPort.lastIndexOf(":");
      hostname = hostAndPort.slice(0, colonIndex);
      port = hostAndPort.slice(colonIndex + 1);
    }
  }

  const normalizedHostname = normalizeUrlHostname(hostname, isUnbracketedIpv6);
  if (!normalizedHostname || !isAllowedUrlHost(normalizedHostname, allowSingleLabel)) return null;
  return {
    hostname: normalizedHostname,
    ...(port === undefined ? {} : { port }),
    isUnbracketedIpv6,
  };
}

function startsWithHttpScheme(value: string, index: number): boolean {
  const prefix = value.slice(index, index + 8).toLowerCase();
  return prefix.startsWith("http://") || prefix.startsWith("https://");
}

function scanUrlToken(
  value: string,
  start: number,
  diagnostics?: UrlSanitizerDiagnostics,
): { end: number; embeddedStrongBareUrlIndex?: number } {
  const ipv6Brackets = findIpv6AuthorityBrackets(value, start, diagnostics);
  let internalIpv6Close = -1;
  let embeddedStrongBareUrlIndex: number | undefined;
  let pathSegmentStart: number | undefined;
  let reachedParameters = false;
  let index = start;
  while (index < value.length) {
    recordScannedCodeUnit(diagnostics);
    const isIpv6Bracket = ipv6Brackets
      && (index === ipv6Brackets.open || index === ipv6Brackets.close);
    if (!reachedParameters && pathSegmentStart === index && value[index] === "[") {
      const close = value.indexOf("]", index + 1);
      if (close >= 0 && value.slice(index + 1, close).includes(":")) internalIpv6Close = close;
    }
    const isInternalIpv6Bracket = internalIpv6Close >= 0
      && (index === pathSegmentStart || index === internalIpv6Close);
    if (!isIpv6Bracket && !isInternalIpv6Bracket && isUrlTokenTerminator(value[index])) break;

    if (!reachedParameters && pathSegmentStart !== undefined
      && (value[index] === "/" || value[index] === "?" || value[index] === "#")) {
      if (embeddedStrongBareUrlIndex === undefined) {
        embeddedStrongBareUrlIndex = findStrongEmbeddedBareAuthorityStart(
          value,
          pathSegmentStart,
          index,
          diagnostics,
        );
      }
      pathSegmentStart = undefined;
    }
    if (!reachedParameters && (value[index] === "?" || value[index] === "#")) {
      reachedParameters = true;
    } else if (!reachedParameters && value[index] === "/") {
      pathSegmentStart = index + 1;
      internalIpv6Close = -1;
    }
    index += 1;
  }
  if (!reachedParameters && pathSegmentStart !== undefined
    && embeddedStrongBareUrlIndex === undefined) {
    embeddedStrongBareUrlIndex = findStrongEmbeddedBareAuthorityStart(
      value,
      pathSegmentStart,
      index,
      diagnostics,
    );
  }
  return {
    end: index,
    ...(embeddedStrongBareUrlIndex === undefined ? {} : { embeddedStrongBareUrlIndex }),
  };
}

function findIpv6AuthorityBrackets(
  value: string,
  start: number,
  diagnostics?: UrlSanitizerDiagnostics,
): { open: number; close: number } | null {
  let authorityStart = start;
  if (startsWithHttpScheme(value, start)) {
    authorityStart = start + (value.slice(start, start + 8).toLowerCase().startsWith("https://") ? 8 : 7);
  } else if (value.startsWith("//", start)) {
    authorityStart = start + 2;
  }

  for (let index = authorityStart; index < value.length; index += 1) {
    recordScannedCodeUnit(diagnostics);
    const character = value[index];
    if (character === "/" || character === "?" || character === "#"
      || (character !== "[" && character !== "]" && isUrlTokenTerminator(character))) return null;
    if (character === "]") return null;
    if (character !== "[") continue;
    const close = value.indexOf("]", index + 1);
    if (close < 0 || !value.slice(index + 1, close).includes(":")) return null;
    return { open: index, close };
  }
  return null;
}

function isUrlTokenTerminator(character: string): boolean {
  return URL_TOKEN_WHITESPACE.test(character) || URL_TOKEN_TERMINATORS.has(character);
}

function isPotentialBareUrlStart(character: string): boolean {
  return character === "[" || /[a-z0-9]/iu.test(character);
}

function probeBareAuthority(
  value: string,
  start: number,
  diagnostics?: UrlSanitizerDiagnostics,
): {
  isCandidate: boolean;
  hasSuffix: boolean;
  nextIndex: number;
  embeddedSchemeIndex?: number;
  embeddedBareUrlIndex?: number;
} {
  let index = start;
  while (index < value.length && isBareAuthorityCharacter(value[index])) {
    recordScannedCodeUnit(diagnostics);
    if (index > start && startsWithHttpScheme(value, index)) {
      return {
        isCandidate: false,
        hasSuffix: false,
        nextIndex: index,
        embeddedSchemeIndex: index,
      };
    }
    index += 1;
  }
  const suffix = value[index];
  if (suffix === "/" && value[index + 1] === "/") {
    return { isCandidate: false, hasSuffix: false, nextIndex: index };
  }
  const hasSuffix = suffix === "/" || suffix === "?" || suffix === "#";
  const bestStart = findBestBareAuthorityStart(value, start, index, hasSuffix, diagnostics);
  if (bestStart === start) {
    return { isCandidate: true, hasSuffix, nextIndex: index };
  }
  if (bestStart !== null) {
    return {
      isCandidate: false,
      hasSuffix: false,
      nextIndex: bestStart,
      embeddedBareUrlIndex: bestStart,
    };
  }
  return { isCandidate: false, hasSuffix: false, nextIndex: index };
}

function findBestBareAuthorityStart(
  value: string,
  start: number,
  authorityEnd: number,
  hasSuffix: boolean,
  diagnostics?: UrlSanitizerDiagnostics,
): number | null {
  const fullAuthority = value.slice(start, authorityEnd);
  if (isUserinfoAuthorityUrlLike(fullAuthority, hasSuffix)) return start;
  if (fullAuthority.includes("@")) return null;

  let lastColon = -1;
  let secondLastColon = -1;
  let lastOpeningBracket = -1;
  for (let index = authorityEnd - 1; index > start; index -= 1) {
    recordScannedCodeUnit(diagnostics);
    const character = value[index];
    if (character === ":") {
      if (lastColon < 0) lastColon = index;
      else if (secondLastColon < 0) secondLastColon = index;
    } else if (character === "[" && lastOpeningBracket < 0) {
      lastOpeningBracket = index;
    }
  }

  const candidates = [
    start,
    lastColon >= 0 ? lastColon + 1 : -1,
    secondLastColon >= 0 ? secondLastColon + 1 : -1,
    lastOpeningBracket,
  ];
  let bestStart: number | null = null;
  let bestScore = 0;
  for (const candidateStart of new Set(candidates)) {
    if (candidateStart < start || candidateStart >= authorityEnd) continue;
    const score = scoreBareAuthority(value.slice(candidateStart, authorityEnd), hasSuffix);
    if (score > bestScore || (score === bestScore && score > 0
      && (bestStart === null || candidateStart > bestStart))) {
      bestScore = score;
      bestStart = candidateStart;
    }
  }
  return bestStart;
}

function scoreBareAuthority(authority: string, hasSuffix: boolean): number {
  // WHATWG URL canonicalizes a decimal label such as "8443" to an IPv4
  // address. Here it is much more likely to be the port of the preceding
  // host, so do not let that canonicalization outrank the full host:port.
  if (/^\d+$/u.test(authority)) return 0;
  const shape = parseUrlAuthorityShape(authority, true);
  if (!shape) return 0;
  const lower = shape.hostname.toLowerCase();
  const unwrapped = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  if (!hasSuffix && !lower.startsWith("www.") && !isKnownMeetingHost(lower)) return 0;
  if (isKnownMeetingHost(lower)) return 3;
  if (isValidDnsHost(unwrapped) || isValidIpv4Host(unwrapped) || unwrapped.includes(":")) return 2;
  return /^\d+$/u.test(unwrapped) ? 0 : 1;
}

function isWeakSingleLabelAuthority(authority: string): boolean {
  const shape = parseUrlAuthorityShape(authority, true);
  if (!shape || shape.port !== undefined || shape.isUnbracketedIpv6) return false;
  const hostname = shape.hostname.toLowerCase();
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped !== "localhost"
    && !isKnownMeetingHost(hostname)
    && !isValidDnsHost(unwrapped)
    && !isValidIpv4Host(unwrapped)
    && !unwrapped.includes(":");
}

function isStrongEmbeddedBareAuthority(authority: string): boolean {
  if (!authority || /^\d+$/u.test(authority)) return false;
  const shape = parseUrlAuthorityShape(authority, true);
  if (!shape) return false;
  const hostname = shape.hostname.toLowerCase();
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return shape.port !== undefined
    || unwrapped === "localhost"
    || isKnownMeetingHost(hostname)
    || isValidDnsHost(unwrapped)
    || isValidIpv4Host(unwrapped)
    || unwrapped.includes(":");
}

function findStrongEmbeddedBareAuthorityStart(
  value: string,
  start: number,
  end: number,
  diagnostics?: UrlSanitizerDiagnostics,
): number | undefined {
  if (start >= end) return undefined;
  const bestStart = findBestBareAuthorityStart(value, start, end, true, diagnostics);
  if (bestStart === null
    || !isStrongEmbeddedBareAuthority(value.slice(bestStart, end))) return undefined;
  return bestStart;
}

function isUserinfoAuthorityUrlLike(authority: string, hasSuffix: boolean): boolean {
  const firstAt = authority.indexOf("@");
  const lastAt = authority.lastIndexOf("@");
  if (firstAt <= 0 || lastAt >= authority.length - 1) return false;

  const shape = parseUrlAuthorityShape(authority, true);
  if (!shape || (!hasSuffix && shape.port === undefined)) return false;

  // One @ is valid userinfo. Multiple @ characters are malformed, but a
  // syntactically valid trailing host is still passed to the full-token
  // classifier so a strong query/path can discard all credentials fail-safe.
  return hasSuffix || shape.port !== undefined;
}

function findNextHttpScheme(
  value: string,
  start: number,
  end: number,
  diagnostics?: UrlSanitizerDiagnostics,
): number | null {
  for (let index = start; index < end; index += 1) {
    recordScannedCodeUnit(diagnostics);
    if (startsWithHttpScheme(value, index)) return index;
  }
  return null;
}

function recordScannedCodeUnit(diagnostics?: UrlSanitizerDiagnostics): void {
  if (diagnostics) diagnostics.scannedCodeUnits += 1;
}

function recordCandidateCheck(diagnostics?: UrlSanitizerDiagnostics): void {
  if (diagnostics) diagnostics.candidateChecks += 1;
}

function isBareAuthorityCharacter(character: string): boolean {
  return /[a-z0-9.:[\]@+%_~-]/iu.test(character);
}

function isExplicitHttpUrl(candidate: string): boolean {
  if (hasParsableHttpHost(candidate)) return true;
  const authorityStart = candidate.indexOf("//") + 2;
  const shape = parseUrlAuthorityShape(candidate.slice(authorityStart), true);
  return Boolean(shape && shape.port !== undefined && !isValidExplicitPort(shape.port));
}

function isProtocolRelativeUrl(candidate: string): boolean {
  if (hasParsableHttpHost(`https:${candidate}`)) return true;
  const shape = parseUrlAuthorityShape(candidate.slice(2), true);
  return Boolean(shape && shape.port !== undefined && !isValidExplicitPort(shape.port));
}

function isSchemelessUrl(candidate: string, hasSuffix: boolean): boolean {
  const shape = parseUrlAuthorityShape(candidate, true);
  if (!shape) return false;
  if (shape.port !== undefined && !isValidExplicitPort(shape.port)) return true;
  if (!hasSuffix) {
    return shape.port !== undefined
      || shape.hostname.toLowerCase().startsWith("www.")
      || isKnownMeetingHost(shape.hostname);
  }
  if (shape.isUnbracketedIpv6) return true;
  if (!hasParsableHttpHost(`https://${candidate}`)) return false;

  const hostname = shape.hostname.toLowerCase();
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isValidDnsHost(unwrapped) || isValidIpv4Host(unwrapped) || unwrapped.includes(":")) return true;
  if (shape.port !== undefined || unwrapped === "localhost") return true;
  return (isMeetingHostLabel(unwrapped) && hasMeetingPathSegment(candidate))
    || hasStrongUrlParameter(candidate);
}

function isMeetingHostLabel(hostname: string): boolean {
  return MEETING_HOST_LABELS.has(decodeUrlComponent(hostname).toLowerCase());
}

function hasMeetingPathSegment(candidate: string): boolean {
  const suffixIndex = candidate.search(/[/?#]/u);
  if (suffixIndex < 0 || candidate[suffixIndex] !== "/") return false;
  const queryIndex = candidate.indexOf("?", suffixIndex);
  const fragmentIndex = candidate.indexOf("#", suffixIndex);
  const pathEnd = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), candidate.length);
  return candidate.slice(suffixIndex + 1, pathEnd).split("/").some((segment) =>
    MEETING_PATH_SEGMENTS.has(decodeUrlComponent(segment).toLowerCase()));
}

function hasStrongUrlParameter(candidate: string): boolean {
  const queryIndex = candidate.indexOf("?");
  const fragmentIndex = candidate.indexOf("#");
  const parameterSections: string[] = [];
  if (queryIndex >= 0) {
    const queryEnd = fragmentIndex > queryIndex ? fragmentIndex : candidate.length;
    parameterSections.push(candidate.slice(queryIndex + 1, queryEnd));
  }
  if (fragmentIndex >= 0) parameterSections.push(candidate.slice(fragmentIndex + 1));
  return parameterSections.some((section) => section.split(/[&;]/u).some((parameter) => {
    const separatorIndex = parameter.indexOf("=");
    const rawKey = separatorIndex < 0 ? parameter : parameter.slice(0, separatorIndex);
    return STRONG_URL_QUERY_KEYS.has(decodeUrlComponent(rawKey).toLowerCase());
  }));
}

function decodeUrlComponent(value: string): string {
  let decoded = value.replace(/\+/gu, " ");
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function normalizeUrlHostname(hostname: string, isUnbracketedIpv6: boolean): string | null {
  const url = parseHttpUrl(isUnbracketedIpv6
    ? `https://[${hostname}]`
    : `https://${hostname}`);
  return url?.hostname ?? null;
}

function isAllowedUrlHost(hostname: string, allowSingleLabel: boolean): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return isValidDnsHost(unwrapped)
    || isValidIpv4Host(unwrapped)
    || unwrapped.includes(":")
    || (allowSingleLabel && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(unwrapped));
}

function isValidIpv4Host(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function countCharacter(value: string, expected: string): number {
  let count = 0;
  for (const character of value) if (character === expected) count += 1;
  return count;
}

function isValidExplicitPort(port: string): boolean {
  if (!/^\d{1,5}$/u.test(port)) return false;
  const numericPort = Number(port);
  return numericPort >= 1 && numericPort <= 65_535;
}

function hasParsableHttpHost(candidate: string): boolean {
  const url = parseHttpUrl(candidate);
  return Boolean(url?.hostname);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isValidDnsHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().replace(/\.$/u, "").split(".");
  if (labels.length < 2) return false;
  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  if (!labels.every((label) => labelPattern.test(label))) return false;
  const topLevel = labels.at(-1) ?? "";
  return /^[a-z]{2,63}$/u.test(topLevel) || /^xn--[a-z0-9-]{2,59}$/u.test(topLevel);
}

function isKnownMeetingHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "meet.google.com"
    || lower === "hangouts.google.com"
    || lower === "teams.microsoft.com"
    || lower === "teams.live.com"
    || lower === "zoom.us"
    || lower.endsWith(".zoom.us");
}

function hasBareUrlBoundary(source: string, start: number): boolean {
  if (start === 0) return true;
  return !/[a-z0-9._%+@-]/iu.test(source[start - 1]);
}

function removeRanges(value: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return value;
  const pieces: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    pieces.push(value.slice(cursor, range.start), " ");
    cursor = range.end;
  }
  pieces.push(value.slice(cursor));
  return pieces.join("");
}

function trimTitlePunctuation(value: string, preserveTrailingSlash = false): string {
  const withoutLeadingPunctuation = value
    .replace(/^[\s:：、,。・|/\\\-–—()[\]{}（）［］｛｝「」『』【】〈〉《》]+/u, "");
  return (preserveTrailingSlash
    ? withoutLeadingPunctuation.replace(/[\s:：、,。・|\\\-–—()[\]{}（）［］｛｝「」『』【】〈〉《》]+$/u, "")
    : withoutLeadingPunctuation.replace(/[\s:：、,。・|/\\\-–—()[\]{}（）［］｛｝「」『』【】〈〉《》]+$/u, ""))
    .trim();
}

function requireSourceEventId(value: string | undefined): string {
  if (!value?.trim()) throw new Error("Source event ID is required.");
  return value;
}
