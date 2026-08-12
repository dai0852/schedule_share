"use client";

import { format } from "date-fns";
import { ja } from "date-fns/locale";
import { CalendarDays, Filter, LogOut, RefreshCcw, ShieldCheck } from "lucide-react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppNavigation } from "@/components/AppNavigation";
import { CalendarToolbar } from "@/components/CalendarToolbar";
import { LoginScreen } from "@/components/LoginScreen";
import { MonthCalendar } from "@/components/MonthCalendar";
import { TimeGridCalendar } from "@/components/TimeGridCalendar";
import { getCalendarRange, getVisibleDays, moveSelectedDate, type ViewMode } from "@/domain/calendar";
import type { PublicSalesMember } from "@/domain/member";
import {
  PUBLIC_EVENTS_RESPONSE_MAX_BYTES,
  sanitizeEventLocation,
  sanitizeEventTitle,
  type CalendarSource,
  type NormalizedEvent,
} from "@/domain/schedule";
import { getClientAuth, getMicrosoftProvider, hasFirebaseClientConfig } from "@/lib/firebase/client";

const MAX_MEMBER_RESPONSE_BYTES = 64 * 1_024;
const MAX_CONNECTION_RESPONSE_BYTES = 64 * 1_024;
const MAX_MEMBERS = 1_000;
const MAX_EVENTS = 1_000;
const MEMBER_FIELDS = new Set(["id", "displayName", "department"]);
const EVENT_FIELDS = new Set([
  "eventId", "source", "sourceEventId", "ownerUserId", "ownerName", "calendarId",
  "title", "location", "start", "end", "isOnlineMeeting", "visibility", "updatedAt",
]);

interface ScheduleAppProps {
  allowDemoAuth?: boolean;
}

export function ScheduleApp({ allowDemoAuth = false }: ScheduleAppProps = {}) {
  const firebaseReady = hasFirebaseClientConfig();
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authInitializing, setAuthInitializing] = useState(firebaseReady);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [members, setMembers] = useState<PublicSalesMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [canManageGoogle, setCanManageGoogle] = useState(false);
  const [canManageMembers, setCanManageMembers] = useState(false);
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [mode, setMode] = useState<ViewMode>("week");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [selectedOwner, setSelectedOwner] = useState("all");
  const [selectedSource, setSelectedSource] = useState<"all" | CalendarSource>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const authGeneration = useRef(0);
  const signInPending = useRef(false);
  const membersController = useRef<AbortController | null>(null);
  const connectionController = useRef<AbortController | null>(null);
  const eventsController = useRef<AbortController | null>(null);
  const range = useMemo(() => getCalendarRange(mode, selectedDate), [mode, selectedDate]);
  const visibleDays = useMemo(() => getVisibleDays(range), [range]);
  const isDemoMode = allowDemoAuth && !firebaseReady;
  const canLoad = !authInitializing
    && (isDemoMode || (firebaseReady && firebaseUser !== null));

  useEffect(() => {
    if (!firebaseReady) {
      setAuthInitializing(false);
      return;
    }
    let active = true;
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = onAuthStateChanged(
        getClientAuth(),
        (user) => {
          authGeneration.current += 1;
          membersController.current?.abort();
          eventsController.current?.abort();
          connectionController.current?.abort();
          signInPending.current = false;
          if (!active) return;
          setFirebaseUser(user);
          setAuthInitializing(false);
          setSigningIn(false);
          setAuthError(null);
          setMembers([]);
          setEvents([]);
          setCanManageGoogle(false);
          setCanManageMembers(false);
          setMembersLoading(false);
          setLoading(false);
          setMembersError(null);
          setError(null);
          setSelectedOwner("all");
        },
        () => {
          authGeneration.current += 1;
          membersController.current?.abort();
          eventsController.current?.abort();
          connectionController.current?.abort();
          signInPending.current = false;
          if (!active) return;
          setFirebaseUser(null);
          setAuthInitializing(false);
          setSigningIn(false);
          setMembers([]);
          setEvents([]);
          setCanManageGoogle(false);
          setCanManageMembers(false);
          setMembersLoading(false);
          setLoading(false);
          setMembersError(null);
          setError(null);
          setAuthError("Microsoft 365の認証状態を確認できませんでした。");
        },
      );
    } catch {
      authGeneration.current += 1;
      setFirebaseUser(null);
      setAuthInitializing(false);
      setAuthError("Microsoft 365の認証状態を確認できませんでした。");
    }
    return () => {
      active = false;
      authGeneration.current += 1;
      membersController.current?.abort();
      eventsController.current?.abort();
      connectionController.current?.abort();
      signInPending.current = false;
      unsubscribe();
    };
  }, [firebaseReady]);

  useEffect(() => {
    if (isDemoMode) {
      membersController.current?.abort();
      membersController.current = null;
      setMembers([]);
      setMembersLoading(false);
      setMembersError(null);
      setSelectedOwner("all");
      return;
    }
    if (!canLoad) return;
    const authenticatedUser = firebaseUser;
    const generation = authGeneration.current;
    const controller = new AbortController();
    membersController.current?.abort();
    membersController.current = controller;
    setMembersLoading(true);
    setMembersError(null);

    void (async () => {
      try {
        const headers = await authorizationHeaders(firebaseReady, allowDemoAuth, authenticatedUser);
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        const response = await fetch("/api/members", { headers, signal: controller.signal });
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        if (!response.ok) throw new SafeApiError();
        const nextMembers = parseMembersResponse(
          await readLimitedJson(response, MAX_MEMBER_RESPONSE_BYTES),
        );
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        setMembers(nextMembers);
        setSelectedOwner((current) => current === "all" || nextMembers.some((item) => item.id === current)
          ? current
          : "all");
      } catch {
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        setMembers([]);
        setSelectedOwner("all");
        setMembersError("担当者一覧を取得できませんでした。");
      } finally {
        if (!controller.signal.aborted && authGeneration.current === generation) setMembersLoading(false);
      }
    })();
    return () => controller.abort();
  }, [allowDemoAuth, canLoad, firebaseReady, firebaseUser, isDemoMode]);

  useEffect(() => {
    if (isDemoMode || !canLoad || !firebaseReady || !firebaseUser) {
      connectionController.current?.abort();
      connectionController.current = null;
      setCanManageGoogle(false);
      setCanManageMembers(false);
      return;
    }
    const authenticatedUser = firebaseUser;
    const generation = authGeneration.current;
    const controller = new AbortController();
    connectionController.current?.abort();
    connectionController.current = controller;
    setCanManageGoogle(false);
    setCanManageMembers(false);

    void (async () => {
      try {
        const headers = await authorizationHeaders(firebaseReady, allowDemoAuth, authenticatedUser);
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        const response = await fetch("/api/me/calendar-connection", {
          headers,
          signal: controller.signal,
        });
        if (controller.signal.aborted || authGeneration.current !== generation || !response.ok) return;
        const access = parseConnectionResponse(
          await readLimitedJson(response, MAX_CONNECTION_RESPONSE_BYTES),
        );
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        setCanManageGoogle(access.registered);
        setCanManageMembers(access.canManageMembers);
      } catch {
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        setCanManageGoogle(false);
        setCanManageMembers(false);
      }
    })();
    return () => controller.abort();
  }, [allowDemoAuth, canLoad, firebaseReady, firebaseUser, isDemoMode]);

  useEffect(() => {
    if (!canLoad) return;
    const authenticatedUser = firebaseUser;
    const generation = authGeneration.current;
    const controller = new AbortController();
    eventsController.current?.abort();
    eventsController.current = controller;
    setEvents([]);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const params = new URLSearchParams({
          start: range.start.toISOString(),
          end: range.end.toISOString(),
        });
        if (selectedOwner !== "all") params.set("ownerUserId", selectedOwner);
        if (selectedSource !== "all") params.set("source", selectedSource);
        const headers = await authorizationHeaders(firebaseReady, allowDemoAuth, authenticatedUser);
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        const response = await fetch(`/api/events?${params.toString()}`, {
          headers,
          signal: controller.signal,
        });
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        if (!response.ok) throw new SafeApiError();
        const nextEvents = parseEventsResponse(
          await readLimitedJson(response, PUBLIC_EVENTS_RESPONSE_MAX_BYTES),
        );
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        setEvents(nextEvents);
      } catch {
        if (controller.signal.aborted || authGeneration.current !== generation) return;
        setEvents([]);
        setError("予定の取得に失敗しました。時間をおいて再度お試しください。");
      } finally {
        if (!controller.signal.aborted && authGeneration.current === generation) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [
    canLoad,
    allowDemoAuth,
    firebaseReady,
    firebaseUser,
    range.start,
    range.end,
    selectedOwner,
    selectedSource,
    refreshGeneration,
  ]);

  async function handleSignIn() {
    if (signInPending.current) return;
    signInPending.current = true;
    setAuthError(null);
    setSigningIn(true);
    try {
      await signInWithPopup(getClientAuth(), getMicrosoftProvider());
    } catch {
      setAuthError("Microsoft 365でのログインに失敗しました。");
    } finally {
      signInPending.current = false;
      setSigningIn(false);
    }
  }

  async function handleSignOut() {
    if (!firebaseReady) return;
    setAuthError(null);
    try {
      await signOut(getClientAuth());
    } catch {
      setAuthError("ログアウトに失敗しました。もう一度お試しください。");
    }
  }

  const title = getCalendarTitle(mode, selectedDate, range);

  if (!firebaseReady && !allowDemoAuth) {
    return (
      <LoginScreen
        error="Firebase認証設定が不足しています。管理者へお問い合わせください。"
        initializing={false}
        signingIn={false}
        onSignIn={() => undefined}
        showSignIn={false}
        description="現在ログインを利用できません。管理者へお問い合わせください。"
      />
    );
  }

  if (firebaseReady && (authInitializing || !firebaseUser)) {
    return (
      <LoginScreen
        error={authError}
        initializing={authInitializing}
        signingIn={signingIn}
        onSignIn={handleSignIn}
      />
    );
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">社内限定</p>
          <h1>営業スケジュール共有</h1>
        </div>
        <div className="topbarBadge">
          <CalendarDays aria-hidden="true" size={18} />
          <span>閲覧専用</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="authPanel">
            <ShieldCheck aria-hidden="true" size={20} />
            <div>
              <strong>{firebaseReady ? "Microsoft 365" : "デモモード"}</strong>
              <span>{firebaseReady ? firebaseUser?.email : "ローカル確認用のデモ認証で表示中"}</span>
            </div>
          </div>

          <label className="selectLabel">
            <Filter aria-hidden="true" size={16} />
            担当者
            <select
              value={selectedOwner}
              onChange={(changeEvent) => {
                clearVisibleEvents();
                setSelectedOwner(changeEvent.target.value);
              }}
            >
              <option value="all">全員</option>
              {members.map((item) => (
                <option key={item.id} value={item.id}>{item.displayName}</option>
              ))}
            </select>
          </label>

          <label className="selectLabel">
            <Filter aria-hidden="true" size={16} />
            予定元
            <select
              value={selectedSource}
              onChange={(changeEvent) => {
                clearVisibleEvents();
                setSelectedSource(changeEvent.target.value as "all" | CalendarSource);
              }}
            >
              <option value="all">すべて</option>
              <option value="google">Google</option>
              <option value="microsoft">Microsoft</option>
              <option value="teams">Teams</option>
            </select>
          </label>

          {membersLoading ? <p className="loadingText">担当者一覧を読み込んでいます…</p> : null}
          {membersError ? <p className="errorText">{membersError}</p> : null}

          <button
            className="primaryButton"
            onClick={() => setRefreshGeneration((current) => current + 1)}
            disabled={loading || authInitializing || (firebaseReady && !firebaseUser)}
          >
            <RefreshCcw aria-hidden="true" size={16} />
            {loading ? "更新中" : "予定を更新"}
          </button>

          {firebaseReady && firebaseUser ? (
            <>
              <AppNavigation
                showGoogleConnection={canManageGoogle}
                showAdminConsole={canManageMembers}
              />
              <button className="secondaryButton" onClick={handleSignOut}>
                <LogOut aria-hidden="true" size={16} />
                ログアウト
              </button>
            </>
          ) : null}
        </aside>

        <section className="scheduleSurface" aria-live="polite" aria-busy={loading}>
          <CalendarToolbar
            title={title}
            mode={mode}
            eventCount={events.length}
            onToday={() => {
              clearVisibleEvents();
              setSelectedDate(new Date());
            }}
            onMove={(amount) => {
              clearVisibleEvents();
              setSelectedDate((date) => moveSelectedDate(date, mode, amount));
            }}
            onModeChange={(nextMode) => {
              clearVisibleEvents();
              setMode(nextMode);
            }}
          />
          {error ? <p className="errorText">{error}</p> : null}
          {loading ? <p className="loadingText">予定を読み込んでいます…</p> : null}
          {mode === "month" ? (
            <MonthCalendar days={visibleDays} selectedDate={selectedDate} events={events} />
          ) : (
            <TimeGridCalendar days={visibleDays} events={events} />
          )}
          {!loading && !error && events.length === 0 ? (
            <p className="emptyText calendarEmpty">表示対象の予定はありません。</p>
          ) : null}
        </section>
      </section>
    </main>
  );

  function clearVisibleEvents() {
    setEvents([]);
    setError(null);
  }
}

async function authorizationHeaders(
  firebaseReady: boolean,
  allowDemoAuth: boolean,
  user: User | null,
): Promise<HeadersInit> {
  if (!firebaseReady && allowDemoAuth) return { "x-demo-email": "admin@example.co.jp" };
  if (!user) throw new SafeApiError();
  return { authorization: `Bearer ${await user.getIdToken()}` };
}

async function readLimitedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new SafeApiError();
  }
  if (!response.body) throw new SafeApiError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await reader.read();
      if (done) {
        streamComplete = true;
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new SafeApiError();
      }
      chunks.push(value);
    }
  } catch {
    throw new SafeApiError();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new SafeApiError();
  }
}

function parseMembersResponse(value: unknown): PublicSalesMember[] {
  const root = exactObject(value, new Set(["members"]));
  if (!Array.isArray(root.members) || root.members.length > MAX_MEMBERS) throw new SafeApiError();
  const ids = new Set<string>();
  return root.members.map((item) => {
    const record = exactObject(item, MEMBER_FIELDS);
    const member = {
      id: publicId(record.id),
      displayName: boundedString(record.displayName, 200),
      department: boundedString(record.department, 200),
    };
    if (ids.has(member.id)) throw new SafeApiError();
    ids.add(member.id);
    return member;
  });
}

function parseConnectionResponse(value: unknown): { registered: boolean; canManageMembers: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeApiError();
  const record = value as Record<string, unknown>;
  const allowedFields = new Set([
    "registered", "canManageMembers", "status", "googleEmail", "lastSucceededAt", "lastErrorSummary",
  ]);
  if (Object.keys(record).some((field) => !allowedFields.has(field))
    || typeof record.registered !== "boolean") throw new SafeApiError();
  const canManageMembers = record.canManageMembers === undefined ? false : record.canManageMembers;
  if (typeof canManageMembers !== "boolean") throw new SafeApiError();
  if (!record.registered) {
    if (Object.keys(record).some((field) => field !== "registered" && field !== "canManageMembers")) {
      throw new SafeApiError();
    }
    return { registered: false, canManageMembers };
  }
  if (record.status !== "not_connected"
    && record.status !== "connected"
    && record.status !== "reconnect_required") throw new SafeApiError();
  if (record.googleEmail !== undefined) boundedString(record.googleEmail, 320);
  if (record.lastSucceededAt !== undefined) rfc3339(record.lastSucceededAt);
  if (record.lastErrorSummary !== undefined) boundedString(record.lastErrorSummary, 500);
  return { registered: true, canManageMembers };
}

function parseEventsResponse(value: unknown): NormalizedEvent[] {
  const root = exactObject(value, new Set(["events"]));
  if (!Array.isArray(root.events) || root.events.length > MAX_EVENTS) throw new SafeApiError();
  const ids = new Set<string>();
  return root.events.map((item) => {
    const record = exactObject(item, EVENT_FIELDS);
    const source = calendarSource(record.source);
    const sourceEventId = boundedString(record.sourceEventId, 1_024);
    const ownerUserId = publicId(record.ownerUserId);
    const eventId = boundedString(record.eventId, 2_048);
    const title = boundedText(record.title);
    const location = boundedText(record.location);
    const start = eventBoundary(record.start);
    const end = eventBoundary(record.end);
    const calendarId = boundedString(record.calendarId, 256);
    if (ids.has(eventId)
      || eventId !== `${source}:${ownerUserId}:${sourceEventId}`
      || boundaryKind(start) !== boundaryKind(end)
      || boundaryEpoch(start) >= boundaryEpoch(end)
      || calendarId !== (source === "google" ? "primary" : "outlook")
      || sanitizeEventTitle(title) !== title
      || sanitizeEventLocation(location) !== location
      || typeof record.isOnlineMeeting !== "boolean"
      || (record.visibility !== "team" && record.visibility !== "private")
      || (record.visibility === "private" && (title !== "予定あり" || location !== ""))) {
      throw new SafeApiError();
    }
    ids.add(eventId);
    return {
      eventId,
      source,
      sourceEventId,
      ownerUserId,
      ownerName: boundedString(record.ownerName, 256),
      calendarId,
      title,
      location,
      start,
      end,
      isOnlineMeeting: record.isOnlineMeeting,
      visibility: record.visibility,
      updatedAt: rfc3339(record.updatedAt),
    };
  });
}

function exactObject(value: unknown, fields: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeApiError();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw new SafeApiError();
  return record;
}

function publicId(value: unknown): string {
  const id = boundedString(value, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new SafeApiError();
  return id;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || hasForbiddenControl(value)) {
    throw new SafeApiError();
  }
  return value;
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096 || hasForbiddenControl(value)) throw new SafeApiError();
  return value;
}

function calendarSource(value: unknown): CalendarSource {
  if (value !== "google" && value !== "microsoft" && value !== "teams") throw new SafeApiError();
  return value;
}

function eventBoundary(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || (!validDateOnly(value) && !validRfc3339(value))) {
    throw new SafeApiError();
  }
  return value;
}

function rfc3339(value: unknown): string {
  if (typeof value !== "string" || !validRfc3339(value)) throw new SafeApiError();
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
  if (!Number.isSafeInteger(parsed)) throw new SafeApiError();
  return parsed;
}

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12
      || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}

class SafeApiError extends Error {}

function getCalendarTitle(
  mode: ViewMode,
  selectedDate: Date,
  range: { start: Date; end: Date },
): string {
  if (mode === "day") return format(selectedDate, "yyyy年M月d日 EEEE", { locale: ja });
  if (mode === "week") {
    return `${format(range.start, "yyyy年M月d日", { locale: ja })} – ${format(
      new Date(range.end.getTime() - 1),
      "M月d日",
      { locale: ja },
    )}`;
  }
  return format(selectedDate, "yyyy年M月", { locale: ja });
}
