import {
  mapGoogleEvent,
  type EventOwnerContext,
  type GoogleCalendarEvent,
  type NormalizedEvent,
} from "@/domain/schedule";

const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;
const GOOGLE_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const GOOGLE_EVENTS_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const GOOGLE_TOKEN_MAX_LENGTH = 8_192;
const GOOGLE_CLIENT_ID_MAX_LENGTH = 2_048;
const GOOGLE_CLIENT_SECRET_MAX_LENGTH = 8_192;
const GOOGLE_EVENT_ID_MAX_LENGTH = 1_024;
const GOOGLE_EVENT_TEXT_MAX_LENGTH = 4_096;
const GOOGLE_EVENT_VISIBILITY_MAX_LENGTH = 64;
const GOOGLE_CONFERENCE_TYPE_MAX_LENGTH = 128;
const GOOGLE_PAGE_TOKEN_MAX_LENGTH = 2_048;
const GOOGLE_MAX_PAGES = 100;
const GOOGLE_MAX_EVENTS_PER_PAGE = 2_500;
const GOOGLE_MAX_TOTAL_EVENTS = 50_000;
const GOOGLE_MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const GOOGLE_MAX_CUMULATIVE_RESPONSE_BYTES = 32 * 1024 * 1024;
const GOOGLE_MAX_NORMALIZED_CHARACTERS = 16 * 1024 * 1024;
const GOOGLE_EVENTS_FIELDS =
  "nextPageToken,items(id,summary,location,visibility,start(date,dateTime),end(date,dateTime),updated,conferenceData(conferenceSolution(key(type))))";

export interface GoogleFetchParams {
  accessToken: string;
  timeMin: string;
  timeMax: string;
  owner: EventOwnerContext;
}

export interface GoogleFetchSafetyLimits {
  maxCumulativeResponseBytes: number;
  maxNormalizedCharacters: number;
}

export type GoogleCalendarErrorCode =
  | "server_config"
  | "invalid_request"
  | "reconnect_required"
  | "upstream_rejected"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_response"
  | "timeout";

const GOOGLE_CALENDAR_ERROR_MESSAGES: Record<GoogleCalendarErrorCode, string> = {
  server_config: "Google Calendar連携のサーバー設定が無効です。",
  invalid_request: "Google Calendar連携のリクエストが無効です。",
  reconnect_required: "Google Calendarの再接続が必要です。",
  upstream_rejected: "Google Calendarへのリクエストが拒否されました。",
  rate_limited: "Google Calendarの利用上限に達しました。",
  upstream_unavailable: "Google Calendarを一時的に利用できません。",
  invalid_response: "Google Calendarから無効な応答を受信しました。",
  timeout: "Google Calendarへの接続がタイムアウトしました。",
};

export class GoogleCalendarError extends Error {
  constructor(readonly code: GoogleCalendarErrorCode) {
    super(GOOGLE_CALENDAR_ERROR_MESSAGES[code]);
    this.name = "GoogleCalendarError";
  }
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  if (!boundedNonBlankString(refreshToken, GOOGLE_TOKEN_MAX_LENGTH)) {
    throw new GoogleCalendarError("invalid_request");
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!boundedNonBlankString(clientId, GOOGLE_CLIENT_ID_MAX_LENGTH)
    || !boundedNonBlankString(clientSecret, GOOGLE_CLIENT_SECRET_MAX_LENGTH)) {
    throw new GoogleCalendarError("server_config");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return withGoogleResponse(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, async (response) => {
    if (!response.ok) {
      if (response.status === 400) {
        const errorBody = await tryReadLimitedJson(response, GOOGLE_TOKEN_RESPONSE_MAX_BYTES);
        if (isRecord(errorBody) && errorBody.error === "invalid_grant") {
          throw new GoogleCalendarError("reconnect_required");
        }
      }
      throw classifyHttpError(response.status);
    }
    const value = await readLimitedJson(response, GOOGLE_TOKEN_RESPONSE_MAX_BYTES);
    if (!isRecord(value) || !boundedNonBlankString(value.access_token, GOOGLE_TOKEN_MAX_LENGTH)) {
      throw new GoogleCalendarError("invalid_response");
    }
    return value.access_token;
  });
}

export async function fetchAllGoogleEvents(
  params: GoogleFetchParams,
  safetyLimitOverrides: Partial<GoogleFetchSafetyLimits> = {},
): Promise<NormalizedEvent[]> {
  validateGoogleFetchParams(params);
  const safetyLimits = resolveGoogleFetchSafetyLimits(safetyLimitOverrides);
  const events: NormalizedEvent[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;
  let totalItemCount = 0;
  let cumulativeResponseBytes = 0;
  let normalizedCharacters = 0;
  do {
    if (pageCount >= GOOGLE_MAX_PAGES) throw new GoogleCalendarError("invalid_response");
    pageCount += 1;
    const url = new URL(GOOGLE_CALENDAR_EVENTS_ENDPOINT);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", params.timeMin);
    url.searchParams.set("timeMax", params.timeMax);
    url.searchParams.set("maxResults", "2500");
    url.searchParams.set("timeZone", "Asia/Tokyo");
    url.searchParams.set("fields", GOOGLE_EVENTS_FIELDS);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const page = await withGoogleResponse(url, {
      headers: { authorization: `Bearer ${params.accessToken}` },
    }, async (response) => {
      if (!response.ok) throw await classifyCalendarEventsHttpError(response);
      return readLimitedJsonWithByteLength(response, GOOGLE_EVENTS_RESPONSE_MAX_BYTES);
    });
    cumulativeResponseBytes = addWithinBudget(
      cumulativeResponseBytes,
      page.byteLength,
      safetyLimits.maxCumulativeResponseBytes,
    );
    const value = page.value;
    if (!isRecord(value) || (value.items !== undefined && !Array.isArray(value.items))) {
      throw new GoogleCalendarError("invalid_response");
    }
    const items = value.items ?? [];
    if (items.length > GOOGLE_MAX_EVENTS_PER_PAGE) throw new GoogleCalendarError("invalid_response");
    totalItemCount += items.length;
    if (totalItemCount > GOOGLE_MAX_TOTAL_EVENTS) throw new GoogleCalendarError("invalid_response");
    for (const item of items) {
      const event = pickSafeGoogleEvent(item);
      if (event === null) continue;
      const normalized = mapGoogleEvent(event, params.owner);
      normalizedCharacters = addWithinBudget(
        normalizedCharacters,
        countNormalizedStringCharacters(normalized),
        safetyLimits.maxNormalizedCharacters,
      );
      events.push(normalized);
    }
    if (value.nextPageToken === undefined) {
      pageToken = undefined;
    } else if (boundedNonBlankString(value.nextPageToken, GOOGLE_PAGE_TOKEN_MAX_LENGTH)) {
      pageToken = value.nextPageToken;
      if (seenPageTokens.has(pageToken)) throw new GoogleCalendarError("invalid_response");
      seenPageTokens.add(pageToken);
    } else {
      throw new GoogleCalendarError("invalid_response");
    }
  } while (pageToken);
  return events;
}

function pickSafeGoogleEvent(value: unknown): GoogleCalendarEvent | null {
  if (!isRecord(value)) throw new GoogleCalendarError("invalid_response");
  if (value.status === "cancelled") return null;
  if (!boundedNonBlankString(value.id, GOOGLE_EVENT_ID_MAX_LENGTH)) {
    throw new GoogleCalendarError("invalid_response");
  }
  if (!optionalBoundedString(value.summary, GOOGLE_EVENT_TEXT_MAX_LENGTH)
    || !optionalBoundedString(value.location, GOOGLE_EVENT_TEXT_MAX_LENGTH)
    || !isValidGoogleVisibility(value.visibility)
    || !isRfc3339(value.updated)) throw new GoogleCalendarError("invalid_response");
  const start = pickGoogleDate(value.start);
  const end = pickGoogleDate(value.end);
  if (!start || !end || dateKind(start) !== dateKind(end)
    || Date.parse(start.dateTime ?? start.date ?? "") >= Date.parse(end.dateTime ?? end.date ?? "")) {
    throw new GoogleCalendarError("invalid_response");
  }
  const conferenceType = readConferenceType(value.conferenceData);
  return {
    id: value.id,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(typeof value.location === "string" ? { location: value.location } : {}),
    ...(typeof value.visibility === "string" ? { visibility: value.visibility } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(typeof value.updated === "string" ? { updated: value.updated } : {}),
    ...(conferenceType ? {
      conferenceData: { conferenceSolution: { key: { type: conferenceType } } },
    } : {}),
  };
}

function pickGoogleDate(value: unknown): { date?: string; dateTime?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const hasDate = value.date !== undefined;
  const hasDateTime = value.dateTime !== undefined;
  if (hasDate === hasDateTime) return undefined;
  if (isRfc3339(value.dateTime)) return { dateTime: value.dateTime };
  if (isCalendarDate(value.date)) return { date: value.date };
  return undefined;
}

function readConferenceType(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.conferenceSolution)
    || !isRecord(value.conferenceSolution.key)) return undefined;
  const type = value.conferenceSolution.key.type;
  return boundedNonBlankString(type, GOOGLE_CONFERENCE_TYPE_MAX_LENGTH) ? type : undefined;
}

async function withGoogleResponse<T>(
  input: string | URL,
  init: RequestInit,
  handleResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await handleResponse(response);
  } catch (error) {
    if (error instanceof GoogleCalendarError) throw error;
    throw new GoogleCalendarError(controller.signal.aborted ? "timeout" : "upstream_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function classifyHttpError(status: number): GoogleCalendarError {
  if (status === 429) return new GoogleCalendarError("rate_limited");
  if (status >= 500) return new GoogleCalendarError("upstream_unavailable");
  return new GoogleCalendarError("upstream_rejected");
}

async function classifyCalendarEventsHttpError(response: Response): Promise<GoogleCalendarError> {
  if (response.status !== 403) return classifyHttpError(response.status);
  const value = await tryReadLimitedJson(response, GOOGLE_TOKEN_RESPONSE_MAX_BYTES);
  return hasAllowlistedRateLimitReason(value)
    ? new GoogleCalendarError("rate_limited")
    : new GoogleCalendarError("upstream_rejected");
}

function hasAllowlistedRateLimitReason(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error) || !Array.isArray(value.error.errors)
    || value.error.errors.length > 100) return false;
  const allowlist = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);
  return value.error.errors.some((item) =>
    isRecord(item)
    && typeof item.reason === "string"
    && item.reason.length <= 128
    && allowlist.has(item.reason));
}

async function tryReadLimitedJson(response: Response, maximumBytes: number): Promise<unknown> {
  try {
    return await readLimitedJson(response, maximumBytes);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

async function readLimitedJson(response: Response, maximumBytes: number): Promise<unknown> {
  return (await readLimitedJsonWithByteLength(response, maximumBytes)).value;
}

async function readLimitedJsonWithByteLength(
  response: Response,
  maximumBytes: number,
): Promise<{ value: unknown; byteLength: number }> {
  try {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
    }
    if (!response.body) throw new Error("empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let streamEnded = false;
    while (!streamEnded) {
      const { done, value } = await reader.read();
      streamEnded = done;
      if (done) continue;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      byteLength,
    };
  } catch (error) {
    if (error instanceof GoogleCalendarError) throw error;
    if (isAbortError(error)) throw error;
    throw new GoogleCalendarError("invalid_response");
  }
}

function resolveGoogleFetchSafetyLimits(
  overrides: Partial<GoogleFetchSafetyLimits>,
): GoogleFetchSafetyLimits {
  if (!overrides || typeof overrides !== "object") throw new GoogleCalendarError("invalid_request");
  return {
    maxCumulativeResponseBytes: resolveSafetyLimit(
      overrides.maxCumulativeResponseBytes,
      GOOGLE_MAX_CUMULATIVE_RESPONSE_BYTES,
    ),
    maxNormalizedCharacters: resolveSafetyLimit(
      overrides.maxNormalizedCharacters,
      GOOGLE_MAX_NORMALIZED_CHARACTERS,
    ),
  };
}

function resolveSafetyLimit(value: number | undefined, defaultMaximum: number): number {
  if (value === undefined) return defaultMaximum;
  if (!Number.isSafeInteger(value) || value <= 0) throw new GoogleCalendarError("invalid_request");
  return Math.min(value, defaultMaximum);
}

function addWithinBudget(current: number, addition: number, maximum: number): number {
  if (!Number.isSafeInteger(addition) || addition < 0 || current > maximum - addition) {
    throw new GoogleCalendarError("invalid_response");
  }
  return current + addition;
}

function countNormalizedStringCharacters(event: NormalizedEvent): number {
  return Object.values(event).reduce(
    (total, value) => total + (typeof value === "string" ? value.length : 0),
    0,
  );
}

function boundedNonBlankString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string"
    && value.length <= maximumLength
    && value.trim().length > 0
    && !hasForbiddenControl(value);
}

function optionalBoundedString(value: unknown, maximumLength: number): value is string | undefined {
  return value === undefined
    || (typeof value === "string" && value.length <= maximumLength && !hasForbiddenControl(value));
}

function isValidGoogleVisibility(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (!optionalBoundedString(value, GOOGLE_EVENT_VISIBILITY_MAX_LENGTH)) return false;
  return value === "default"
    || value === "public"
    || value === "private"
    || value === "confidential";
}

function hasForbiddenControl(value: string): boolean {
  return value.includes("\u0000") || value.includes("\r") || value.includes("\n");
}

function validateGoogleFetchParams(params: GoogleFetchParams): void {
  if (!params || typeof params !== "object"
    || !boundedNonBlankString(params.accessToken, GOOGLE_TOKEN_MAX_LENGTH)
    || !isRfc3339(params.timeMin)
    || !isRfc3339(params.timeMax)) {
    throw new GoogleCalendarError("invalid_request");
  }
  const start = Date.parse(params.timeMin);
  const end = Date.parse(params.timeMax);
  if (start >= end || end - start > GOOGLE_MAX_RANGE_MS
    || !params.owner || typeof params.owner !== "object"
    || !boundedNonBlankString(params.owner.ownerUserId, 256)
    || !boundedNonBlankString(params.owner.ownerName, 256)
    || params.owner.calendarId !== "primary") {
    throw new GoogleCalendarError("invalid_request");
  }
}

function dateKind(value: { date?: string; dateTime?: string }): "date" | "dateTime" {
  return value.dateTime === undefined ? "date" : "dateTime";
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(match && isValidDateParts(match[1], match[2], match[3]) && Number.isFinite(Date.parse(value)));
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return Boolean(match && isValidDateParts(match[1], match[2], match[3]));
}

function isValidDateParts(yearValue: string, monthValue: string, dayValue: string): boolean {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildGoogleOAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  return url.toString();
}
