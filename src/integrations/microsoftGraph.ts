import {
  mapMicrosoftEvent,
  type EventOwnerContext,
  type MicrosoftGraphEvent,
  type NormalizedEvent,
} from "@/domain/schedule";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_SELECT =
  "id,subject,start,end,location,isAllDay,isCancelled,isOnlineMeeting,onlineMeetingProvider,sensitivity";
const GRAPH_TOP = "100";
const GRAPH_TIMEZONE = "Tokyo Standard Time";
const MICROSOFT_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const GRAPH_PAGE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const TOKEN_MAX_LENGTH = 8_192;
const CLIENT_SECRET_MAX_LENGTH = 8_192;
const USER_PRINCIPAL_NAME_MAX_LENGTH = 320;
const EVENT_ID_MAX_LENGTH = 1_024;
const EVENT_TEXT_MAX_LENGTH = 4_096;
const EVENT_PROVIDER_MAX_LENGTH = 128;
const EVENT_SENSITIVITY_MAX_LENGTH = 128;
const NEXT_LINK_MAX_LENGTH = 16 * 1024;
const SKIP_TOKEN_MAX_LENGTH = 8 * 1024;
const MAX_PAGES = 100;
const MAX_EVENTS_PER_PAGE = 500;
const MAX_TOTAL_EVENTS = 50_000;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_CUMULATIVE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_NORMALIZED_CHARACTERS = 16 * 1024 * 1024;

export interface MicrosoftFetchParams {
  accessToken: string;
  userPrincipalName: string;
  start: string;
  end: string;
  syncedAt: string;
  owner: EventOwnerContext;
}

export interface MicrosoftFetchSafetyLimits {
  maxCumulativeResponseBytes: number;
  maxNormalizedCharacters: number;
}

export type MicrosoftGraphErrorCode =
  | "server_config"
  | "invalid_request"
  | "upstream_rejected"
  | "permission_denied"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_response"
  | "timeout";

const ERROR_MESSAGES: Record<MicrosoftGraphErrorCode, string> = {
  server_config: "Microsoft Graph連携のサーバー設定が無効です。",
  invalid_request: "Microsoft Graph連携のリクエストが無効です。",
  upstream_rejected: "Microsoft Graphへのリクエストが拒否されました。",
  permission_denied: "Microsoftカレンダーの読み取り権限がありません。",
  rate_limited: "Microsoft Graphの利用上限に達しました。",
  upstream_unavailable: "Microsoft Graphを一時的に利用できません。",
  invalid_response: "Microsoft Graphから無効な応答を受信しました。",
  timeout: "Microsoft Graphへの接続がタイムアウトしました。",
};

export class MicrosoftGraphError extends Error {
  constructor(readonly code: MicrosoftGraphErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MicrosoftGraphError";
  }
}

export async function getMicrosoftAppAccessToken(): Promise<string> {
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!isCanonicalUuid(tenantId)
    || !isCanonicalUuid(clientId)
    || !boundedNonBlankString(clientSecret, CLIENT_SECRET_MAX_LENGTH)) {
    throw new MicrosoftGraphError("server_config");
  }

  const endpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  return withMicrosoftResponse(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, async (response) => {
    if (!response.ok) throw classifyHttpError(response.status);
    const value = await readLimitedJson(response, TOKEN_RESPONSE_MAX_BYTES);
    if (!isRecord(value) || !boundedNonBlankString(value.access_token, TOKEN_MAX_LENGTH)) {
      throw new MicrosoftGraphError("invalid_response");
    }
    return value.access_token;
  });
}

export async function fetchAllMicrosoftCalendarView(
  params: MicrosoftFetchParams,
  safetyLimitOverrides: Partial<MicrosoftFetchSafetyLimits> = {},
): Promise<NormalizedEvent[]> {
  const userPrincipalName = validateFetchParams(params);
  const safetyLimits = resolveSafetyLimits(safetyLimitOverrides);
  const firstUrl = createCalendarViewUrl(params, userPrincipalName);
  const expectedPath = firstUrl.pathname;

  const events: NormalizedEvent[] = [];
  const seenNextLinks = new Set<string>();
  let nextUrl: URL | undefined = firstUrl;
  let pageCount = 0;
  let totalItemCount = 0;
  let cumulativeResponseBytes = 0;
  let normalizedCharacters = 0;

  while (nextUrl) {
    if (pageCount >= MAX_PAGES) throw new MicrosoftGraphError("invalid_response");
    pageCount += 1;
    const page = await withMicrosoftResponse(nextUrl, {
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        prefer: `outlook.timezone="${GRAPH_TIMEZONE}"`,
      },
    }, async (response) => {
      if (!response.ok) throw classifyHttpError(response.status);
      return readLimitedJsonWithByteLength(response, GRAPH_PAGE_RESPONSE_MAX_BYTES);
    });
    cumulativeResponseBytes = addWithinBudget(
      cumulativeResponseBytes,
      page.byteLength,
      safetyLimits.maxCumulativeResponseBytes,
    );
    if (!isRecord(page.value) || !Array.isArray(page.value.value)) {
      throw new MicrosoftGraphError("invalid_response");
    }
    const items = page.value.value;
    if (items.length > MAX_EVENTS_PER_PAGE) throw new MicrosoftGraphError("invalid_response");
    totalItemCount += items.length;
    if (totalItemCount > MAX_TOTAL_EVENTS) throw new MicrosoftGraphError("invalid_response");

    for (const item of items) {
      const safeEvent = pickSafeMicrosoftEvent(item);
      if (safeEvent === null) continue;
      const normalized = {
        ...mapMicrosoftEvent(safeEvent, params.owner),
        updatedAt: params.syncedAt,
      };
      normalizedCharacters = addWithinBudget(
        normalizedCharacters,
        countNormalizedStringCharacters(normalized),
        safetyLimits.maxNormalizedCharacters,
      );
      events.push(normalized);
    }

    const rawNextLink = page.value["@odata.nextLink"];
    if (rawNextLink === undefined) {
      nextUrl = undefined;
      continue;
    }
    nextUrl = validateNextLink(rawNextLink, expectedPath, params.start, params.end);
    const canonicalNextLink = nextUrl.toString();
    if (seenNextLinks.has(canonicalNextLink)) {
      throw new MicrosoftGraphError("invalid_response");
    }
    seenNextLinks.add(canonicalNextLink);
  }

  return events;
}

/** @deprecated Prefer fetchAllMicrosoftCalendarView. */
export async function fetchMicrosoftCalendarView(
  params: MicrosoftFetchParams,
): Promise<NormalizedEvent[]> {
  return fetchAllMicrosoftCalendarView(params);
}

function createCalendarViewUrl(params: MicrosoftFetchParams, userPrincipalName: string): URL {
  const url = new URL(
    `${GRAPH_ORIGIN}/v1.0/users/${encodeURIComponent(userPrincipalName)}/calendarView`,
  );
  url.searchParams.set("startDateTime", params.start);
  url.searchParams.set("endDateTime", params.end);
  url.searchParams.set("$select", GRAPH_SELECT);
  url.searchParams.set("$top", GRAPH_TOP);
  return url;
}

function validateNextLink(
  value: unknown,
  expectedPath: string,
  expectedStart: string,
  expectedEnd: string,
): URL {
  if (!boundedNonBlankString(value, NEXT_LINK_MAX_LENGTH)) {
    throw new MicrosoftGraphError("invalid_response");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MicrosoftGraphError("invalid_response");
  }
  if (url.protocol !== "https:"
    || url.hostname !== "graph.microsoft.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.pathname !== expectedPath) {
    throw new MicrosoftGraphError("invalid_response");
  }

  const allowedKeys = new Set([
    "startDateTime", "endDateTime", "$select", "$top", "$skiptoken", "$skip",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new MicrosoftGraphError("invalid_response");
    }
  }
  const invariantQueries = new Map([
    ["startDateTime", expectedStart],
    ["endDateTime", expectedEnd],
    ["$select", GRAPH_SELECT],
  ]);
  for (const [key, expectedValue] of invariantQueries) {
    if (url.searchParams.has(key) && url.searchParams.get(key) !== expectedValue) {
      throw new MicrosoftGraphError("invalid_response");
    }
  }
  const skipTokens = url.searchParams.getAll("$skiptoken");
  const skips = url.searchParams.getAll("$skip");
  if (skipTokens.length + skips.length !== 1
    || (skipTokens.length === 1 && !boundedNonBlankString(skipTokens[0], SKIP_TOKEN_MAX_LENGTH))
    || (skips.length === 1 && !isValidSkip(skips[0]))) {
    throw new MicrosoftGraphError("invalid_response");
  }
  const top = url.searchParams.get("$top");
  if (top !== null && (!isValidSkip(top) || Number(top) < 1 || Number(top) > Number(GRAPH_TOP))) {
    throw new MicrosoftGraphError("invalid_response");
  }
  return url;
}

function isValidSkip(value: string): boolean {
  return /^(?:0|[1-9]\d{0,14})$/.test(value) && Number.isSafeInteger(Number(value));
}

function pickSafeMicrosoftEvent(value: unknown): MicrosoftGraphEvent | null {
  if (!isRecord(value)
    || !boundedNonBlankString(value.id, EVENT_ID_MAX_LENGTH)
    || typeof value.isCancelled !== "boolean") {
    throw new MicrosoftGraphError("invalid_response");
  }
  if (value.isCancelled) return null;
  if (typeof value.isAllDay !== "boolean"
    || typeof value.isOnlineMeeting !== "boolean"
    || !optionalBoundedString(value.subject, EVENT_TEXT_MAX_LENGTH)
    || !boundedNonBlankString(value.sensitivity, EVENT_SENSITIVITY_MAX_LENGTH)
    || !optionalBoundedString(value.onlineMeetingProvider, EVENT_PROVIDER_MAX_LENGTH)) {
    throw new MicrosoftGraphError("invalid_response");
  }
  const location = pickLocation(value.location);
  const start = pickDateTimeTimeZone(value.start, value.isAllDay);
  const end = pickDateTimeTimeZone(value.end, value.isAllDay);
  if (!start || !end || (value.isAllDay && start.timeZone !== end.timeZone)) {
    throw new MicrosoftGraphError("invalid_response");
  }

  const normalizedStart = normalizeMicrosoftDateForValidation(start, value.isAllDay);
  const normalizedEnd = normalizeMicrosoftDateForValidation(end, value.isAllDay);
  if (Date.parse(normalizedStart) >= Date.parse(normalizedEnd)) {
    throw new MicrosoftGraphError("invalid_response");
  }

  return {
    id: value.id,
    ...(typeof value.subject === "string" ? { subject: value.subject } : {}),
    sensitivity: value.sensitivity,
    ...(location ? { location } : {}),
    isAllDay: value.isAllDay,
    isCancelled: false,
    isOnlineMeeting: value.isOnlineMeeting,
    ...(typeof value.onlineMeetingProvider === "string"
      ? { onlineMeetingProvider: value.onlineMeetingProvider }
      : {}),
    start,
    end,
  };
}

function pickLocation(value: unknown): { displayName?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !optionalBoundedString(value.displayName, EVENT_TEXT_MAX_LENGTH)) {
    throw new MicrosoftGraphError("invalid_response");
  }
  return typeof value.displayName === "string" ? { displayName: value.displayName } : {};
}

function pickDateTimeTimeZone(
  value: unknown,
  isAllDay: boolean,
): { dateTime: string; timeZone: string } | undefined {
  if (!isRecord(value)
    || !boundedNonBlankString(value.dateTime, 64)
    || !boundedNonBlankString(value.timeZone, 64)) return undefined;
  const result = { dateTime: value.dateTime, timeZone: value.timeZone };
  try {
    normalizeMicrosoftDateForValidation(result, isAllDay);
    return result;
  } catch {
    return undefined;
  }
}

function normalizeMicrosoftDateForValidation(
  value: { dateTime: string; timeZone: string },
  isAllDay: boolean,
): string {
  if (isAllDay) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0{1,9})?$/.exec(value.dateTime);
    if (!match || !isValidDateParts(match[1], match[2], match[3])
      || !isAcceptedGraphTimeZone(value.timeZone)) {
      throw new MicrosoftGraphError("invalid_response");
    }
    return `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
  }
  if (isRfc3339(value.dateTime)) return value.dateTime;
  if (!isLocalDateTime(value.dateTime)) throw new MicrosoftGraphError("invalid_response");
  if (value.timeZone === "Tokyo Standard Time" || value.timeZone === "Asia/Tokyo") {
    return `${value.dateTime}+09:00`;
  }
  if (value.timeZone === "UTC") return `${value.dateTime}Z`;
  throw new MicrosoftGraphError("invalid_response");
}

function isAcceptedGraphTimeZone(value: string): boolean {
  return value === "Tokyo Standard Time" || value === "Asia/Tokyo" || value === "UTC";
}

function validateFetchParams(params: MicrosoftFetchParams): string {
  if (!params || typeof params !== "object"
    || !boundedNonBlankString(params.accessToken, TOKEN_MAX_LENGTH)
    || !isRfc3339(params.start)
    || !isRfc3339(params.end)
    || !isRfc3339(params.syncedAt)
    || !isValidUserPrincipalName(params.userPrincipalName)) {
    throw new MicrosoftGraphError("invalid_request");
  }
  const start = Date.parse(params.start);
  const end = Date.parse(params.end);
  if (start >= end || end - start > MAX_RANGE_MS
    || !params.owner || typeof params.owner !== "object"
    || !boundedNonBlankString(params.owner.ownerUserId, 256)
    || !boundedNonBlankString(params.owner.ownerName, 256)
    || params.owner.calendarId !== "outlook") {
    throw new MicrosoftGraphError("invalid_request");
  }
  return params.userPrincipalName.trim().toLowerCase();
}

function isValidUserPrincipalName(value: unknown): value is string {
  if (!boundedNonBlankString(value, USER_PRINCIPAL_NAME_MAX_LENGTH) || value !== value.trim()) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || value.indexOf("@") !== at) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/iu.test(local) || local.startsWith(".") || local.endsWith(".")) {
    return false;
  }
  if (domain.length > 253 || !domain.includes(".")) return false;
  return domain.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/iu.test(label));
}

async function withMicrosoftResponse<T>(
  input: string | URL,
  init: RequestInit,
  handleResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MICROSOFT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await handleResponse(response);
  } catch (error) {
    if (error instanceof MicrosoftGraphError) throw error;
    throw new MicrosoftGraphError(controller.signal.aborted ? "timeout" : "upstream_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function classifyHttpError(status: number): MicrosoftGraphError {
  if (status === 403) return new MicrosoftGraphError("permission_denied");
  if (status === 429) return new MicrosoftGraphError("rate_limited");
  if (status >= 500) return new MicrosoftGraphError("upstream_unavailable");
  return new MicrosoftGraphError("upstream_rejected");
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
    if (error instanceof MicrosoftGraphError) throw error;
    if (isAbortError(error)) throw error;
    throw new MicrosoftGraphError("invalid_response");
  }
}

function resolveSafetyLimits(
  overrides: Partial<MicrosoftFetchSafetyLimits>,
): MicrosoftFetchSafetyLimits {
  if (!overrides || typeof overrides !== "object") throw new MicrosoftGraphError("invalid_request");
  return {
    maxCumulativeResponseBytes: resolveSafetyLimit(
      overrides.maxCumulativeResponseBytes,
      MAX_CUMULATIVE_RESPONSE_BYTES,
    ),
    maxNormalizedCharacters: resolveSafetyLimit(
      overrides.maxNormalizedCharacters,
      MAX_NORMALIZED_CHARACTERS,
    ),
  };
}

function resolveSafetyLimit(value: number | undefined, defaultMaximum: number): number {
  if (value === undefined) return defaultMaximum;
  if (!Number.isSafeInteger(value) || value <= 0) throw new MicrosoftGraphError("invalid_request");
  return Math.min(value, defaultMaximum);
}

function addWithinBudget(current: number, addition: number, maximum: number): number {
  if (!Number.isSafeInteger(addition) || addition < 0 || current > maximum - addition) {
    throw new MicrosoftGraphError("invalid_response");
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

function hasForbiddenControl(value: string): boolean {
  return value.includes("\u0000") || value.includes("\r") || value.includes("\n");
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(match && isValidDateParts(match[1], match[2], match[3]) && Number.isFinite(Date.parse(value)));
}

function isLocalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?$/.exec(value);
  return Boolean(match && isValidDateParts(match[1], match[2], match[3])
    && Number.isFinite(Date.parse(`${value}Z`)));
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
