"use client";

import { addDays, format, startOfDay } from "date-fns";
import { ja } from "date-fns/locale";
import { Calendar, Filter, LogIn, LogOut, RefreshCcw, ShieldCheck } from "lucide-react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SalesMember } from "@/data/demo";
import type { NormalizedEvent } from "@/domain/schedule";
import { getClientAuth, getMicrosoftProvider, hasFirebaseClientConfig } from "@/lib/firebase/client";

type ViewMode = "day" | "week";

interface ScheduleAppProps {
  initialMembers: SalesMember[];
}

export function ScheduleApp({ initialMembers }: ScheduleAppProps) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  const [mode, setMode] = useState<ViewMode>("day");
  const [selectedOwner, setSelectedOwner] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firebaseReady = hasFirebaseClientConfig();
  const today = useMemo(() => startOfDay(new Date("2026-06-19T00:00:00+09:00")), []);

  useEffect(() => {
    if (!firebaseReady) return;
    const auth = getClientAuth();
    return onAuthStateChanged(auth, setFirebaseUser);
  }, [firebaseReady]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const start = today.toISOString();
      const end = addDays(today, mode === "day" ? 1 : 7).toISOString();
      const params = new URLSearchParams({ start, end });
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
      setEvents(body.events);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "予定の取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  }, [firebaseReady, firebaseUser, mode, selectedOwner, today]);

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

  const grouped = groupByDay(events);

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

        <div className="controlGroup" aria-label="表示切替">
          <button className={mode === "day" ? "active" : ""} onClick={() => setMode("day")}>
            日
          </button>
          <button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}>
            週
          </button>
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

      <section className="scheduleSurface" aria-live="polite">
        <div className="scheduleHeader">
          <div>
            <p className="eyebrow">予定一覧</p>
            <h2>
              {format(today, "yyyy年M月d日", { locale: ja })} {mode === "week" ? "から7日間" : ""}
            </h2>
          </div>
          <div className="countBadge">
            <Calendar aria-hidden="true" size={16} />
            {events.length}件
          </div>
        </div>

        {error ? <p className="errorText">{error}</p> : null}
        {Object.entries(grouped).map(([day, dayEvents]) => (
          <div className="dayBlock" key={day}>
            <h3>{format(new Date(day), "M月d日 EEEE", { locale: ja })}</h3>
            <div className="eventList">
              {dayEvents.map((event) => (
                <article className="eventRow" key={event.eventId}>
                  <time>
                    {format(new Date(event.start), "HH:mm")} - {format(new Date(event.end), "HH:mm")}
                  </time>
                  <div>
                    <strong>{event.title}</strong>
                    <span>
                      {event.ownerName}
                      {event.location ? ` / ${event.location}` : ""}
                    </span>
                  </div>
                  <SourcePill event={event} />
                </article>
              ))}
            </div>
          </div>
        ))}
        {!loading && events.length === 0 ? <p className="emptyText">表示対象の予定はありません。</p> : null}
      </section>
    </section>
  );
}

function groupByDay(events: NormalizedEvent[]): Record<string, NormalizedEvent[]> {
  return events.reduce<Record<string, NormalizedEvent[]>>((acc, event) => {
    const key = startOfDay(new Date(event.start)).toISOString();
    acc[key] = acc[key] ?? [];
    acc[key].push(event);
    return acc;
  }, {});
}

function SourcePill({ event }: { event: NormalizedEvent }) {
  const label = event.source === "google" ? "Google" : event.source === "teams" ? "Teams" : "Microsoft";
  return <span className={`sourcePill ${event.source}`}>{label}</span>;
}
