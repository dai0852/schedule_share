"use client";

import { format } from "date-fns";
import { ja } from "date-fns/locale";
import { Filter, LogIn, LogOut, RefreshCcw, ShieldCheck } from "lucide-react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarToolbar } from "@/components/CalendarToolbar";
import { MonthCalendar } from "@/components/MonthCalendar";
import { TimeGridCalendar } from "@/components/TimeGridCalendar";
import type { SalesMember } from "@/data/demo";
import {
  getCalendarRange,
  getVisibleDays,
  moveSelectedDate,
  type ViewMode,
} from "@/domain/calendar";
import type { NormalizedEvent } from "@/domain/schedule";
import { getClientAuth, getMicrosoftProvider, hasFirebaseClientConfig } from "@/lib/firebase/client";

interface ScheduleAppProps {
  initialMembers: SalesMember[];
}

export function ScheduleApp({ initialMembers }: ScheduleAppProps) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [mode, setMode] = useState<ViewMode>("week");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [selectedOwner, setSelectedOwner] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const firebaseReady = hasFirebaseClientConfig();
  const range = useMemo(() => getCalendarRange(mode, selectedDate), [mode, selectedDate]);
  const visibleDays = useMemo(() => getVisibleDays(range), [range]);

  useEffect(() => {
    if (!firebaseReady) return;
    const auth = getClientAuth();
    return onAuthStateChanged(auth, setFirebaseUser);
  }, [firebaseReady]);

  const loadEvents = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      });
      if (selectedOwner !== "all") params.set("ownerUserId", selectedOwner);

      const headers: HeadersInit = {};
      if (firebaseReady && firebaseUser) {
        headers.authorization = `Bearer ${await firebaseUser.getIdToken()}`;
      } else {
        headers["x-demo-email"] = "admin@example.co.jp";
      }

      const response = await fetch(`/api/events?${params.toString()}`, { headers });
      if (!response.ok) throw new Error(await response.text());
      const body = (await response.json()) as { events: NormalizedEvent[] };
      if (requestId === requestIdRef.current) setEvents(body.events);
    } catch (caught) {
      if (requestId === requestIdRef.current) {
        setError(caught instanceof Error ? caught.message : "予定の取得に失敗しました。");
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [firebaseReady, firebaseUser, range, selectedOwner]);

  useEffect(() => {
    if (!firebaseReady || firebaseUser) void loadEvents();
  }, [firebaseReady, firebaseUser, loadEvents]);

  async function handleSignIn() {
    const auth = getClientAuth();
    await signInWithPopup(auth, getMicrosoftProvider());
  }

  async function handleSignOut() {
    if (!firebaseReady) return;
    await signOut(getClientAuth());
  }

  const title = getCalendarTitle(mode, selectedDate, range);

  return (
    <section className="workspace">
      <aside className="sidebar">
        <div className="authPanel">
          <ShieldCheck aria-hidden="true" size={20} />
          <div>
            <strong>{firebaseReady ? "Microsoftログイン" : "デモモード"}</strong>
            <span>{firebaseUser?.email ?? "ローカル確認用のデモ認証で表示中"}</span>
          </div>
        </div>

        <label className="selectLabel">
          <Filter aria-hidden="true" size={16} />
          担当者
          <select value={selectedOwner} onChange={(event) => setSelectedOwner(event.target.value)}>
            <option value="all">全員</option>
            {initialMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>

        <button className="primaryButton" onClick={loadEvents} disabled={loading}>
          <RefreshCcw aria-hidden="true" size={16} />
          {loading ? "更新中" : "予定を更新"}
        </button>

        {firebaseReady ? (
          firebaseUser ? (
            <button className="secondaryButton" onClick={handleSignOut}>
              <LogOut aria-hidden="true" size={16} />
              ログアウト
            </button>
          ) : (
            <button className="primaryButton" onClick={handleSignIn}>
              <LogIn aria-hidden="true" size={16} />
              Microsoftでログイン
            </button>
          )
        ) : null}
      </aside>

      <section className="scheduleSurface" aria-live="polite" aria-busy={loading}>
        <CalendarToolbar
          title={title}
          mode={mode}
          eventCount={events.length}
          onToday={() => setSelectedDate(new Date())}
          onMove={(amount) => setSelectedDate((date) => moveSelectedDate(date, mode, amount))}
          onModeChange={setMode}
        />
        {error ? <p className="errorText">{error}</p> : null}
        {loading ? <p className="loadingText">予定を読み込んでいます…</p> : null}
        {mode === "month" ? (
          <MonthCalendar days={visibleDays} selectedDate={selectedDate} events={events} />
        ) : (
          <TimeGridCalendar days={visibleDays} events={events} />
        )}
        {!loading && events.length === 0 ? (
          <p className="emptyText calendarEmpty">表示対象の予定はありません。</p>
        ) : null}
      </section>
    </section>
  );
}

function getCalendarTitle(
  mode: ViewMode,
  selectedDate: Date,
  range: { start: Date; end: Date },
): string {
  if (mode === "day") {
    return format(selectedDate, "yyyy年M月d日 EEEE", { locale: ja });
  }
  if (mode === "week") {
    return `${format(range.start, "yyyy年M月d日", { locale: ja })} – ${format(
      new Date(range.end.getTime() - 1),
      "M月d日",
      { locale: ja },
    )}`;
  }
  return format(selectedDate, "yyyy年M月", { locale: ja });
}
