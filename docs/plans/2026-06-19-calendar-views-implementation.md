# 日・週・月カレンダー表示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 営業メンバーの予定を、期間移動できるGoogleカレンダー型の日・週・月ビューで閲覧できるようにする。

**Architecture:** 日付範囲とイベント配置を `src/domain/calendar.ts` の純粋関数へ集約し、日・週の時間軸と月間グリッドを別コンポーネントとして描画する。`ScheduleApp` は認証、表示状態、担当者フィルター、競合しないAPI取得だけを管理する。

**Tech Stack:** Next.js App Router、React 19、TypeScript、date-fns、Vitest、CSS

---

## 変更ファイル

- Create: `src/domain/calendar.ts` — 表示期間、日付移動、終日判定、日別分割、重複配置
- Create: `src/domain/calendar.test.ts` — カレンダー純粋関数の境界値テスト
- Create: `src/components/ScheduleApp.test.tsx` — 表示切替とAPI取得期間のコンポーネントテスト
- Create: `src/components/CalendarToolbar.tsx` — 今日・前後移動・表示切替・件数
- Create: `src/components/TimeGridCalendar.tsx` — 日・週の時間軸
- Create: `src/components/MonthCalendar.tsx` — 月間グリッド
- Modify: `src/components/ScheduleApp.tsx` — 状態、API期間、取得競合制御、ビュー統合
- Modify: `app/globals.css` — カレンダーのレイアウト、色、レスポンシブ表示
- Modify: `PROJECT.md` — 日・週・月表示をプロジェクト方針へ反映
- Modify: `.gitignore` — ブレインストーミング生成物を除外

ユーザー指示に従い、実装中のコミットは行わない。

### Task 1: 表示期間と移動の純粋関数

**Files:**
- Create: `src/domain/calendar.ts`
- Test: `src/domain/calendar.test.ts`

- [ ] **Step 1: 期間計算の失敗テストを書く**

```ts
import { describe, expect, it } from "vitest";
import { getCalendarRange, moveSelectedDate } from "./calendar";

describe("calendar range", () => {
  const selected = new Date("2026-06-19T12:00:00+09:00");

  it.each([
    ["day", "2026-06-18T15:00:00.000Z", "2026-06-19T15:00:00.000Z"],
    ["week", "2026-06-14T15:00:00.000Z", "2026-06-21T15:00:00.000Z"],
    ["month", "2026-05-31T15:00:00.000Z", "2026-07-05T15:00:00.000Z"],
  ] as const)("returns the %s API range", (mode, start, end) => {
    const range = getCalendarRange(mode, selected);
    expect(range.start.toISOString()).toBe(start);
    expect(range.end.toISOString()).toBe(end);
  });

  it("moves by the active view unit", () => {
    expect(moveSelectedDate(selected, "day", 1).getDate()).toBe(20);
    expect(moveSelectedDate(selected, "week", -1).getDate()).toBe(12);
    expect(moveSelectedDate(selected, "month", 1).getMonth()).toBe(6);
  });
});
```

- [ ] **Step 2: テストが未実装で失敗することを確認する**

Run: `npm test -- src/domain/calendar.test.ts`

Expected: FAIL with `Failed to load url ./calendar`.

- [ ] **Step 3: 期間計算を実装する**

```ts
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";

export type ViewMode = "day" | "week" | "month";

export interface CalendarRange {
  start: Date;
  end: Date;
}

const WEEK_OPTIONS = { weekStartsOn: 1 as const };

export function getCalendarRange(mode: ViewMode, selectedDate: Date): CalendarRange {
  if (mode === "day") {
    const start = startOfDay(selectedDate);
    return { start, end: addDays(start, 1) };
  }

  if (mode === "week") {
    const start = startOfWeek(selectedDate, WEEK_OPTIONS);
    return { start, end: addWeeks(start, 1) };
  }

  const start = startOfWeek(startOfMonth(selectedDate), WEEK_OPTIONS);
  const lastWeekStart = startOfWeek(endOfMonth(selectedDate), WEEK_OPTIONS);
  return { start, end: addWeeks(lastWeekStart, 1) };
}

export function moveSelectedDate(date: Date, mode: ViewMode, amount: number): Date {
  if (mode === "day") return addDays(date, amount);
  if (mode === "week") return addWeeks(date, amount);
  return addMonths(date, amount);
}
```

- [ ] **Step 4: 期間計算テストを通す**

Run: `npm test -- src/domain/calendar.test.ts`

Expected: 4 tests PASS.

### Task 2: 終日・複数日・重複予定の配置

**Files:**
- Modify: `src/domain/calendar.ts`
- Modify: `src/domain/calendar.test.ts`

- [ ] **Step 1: 配置計算の失敗テストを追加する**

```ts
import type { NormalizedEvent } from "./schedule";
import { isAllDayEvent, layoutTimedEvents } from "./calendar";

const baseEvent: NormalizedEvent = {
  eventId: "base",
  source: "google",
  sourceEventId: "base",
  ownerUserId: "sales-a",
  ownerName: "田中",
  calendarId: "primary",
  title: "予定",
  location: "",
  start: "2026-06-19T09:00:00+09:00",
  end: "2026-06-19T10:00:00+09:00",
  isOnlineMeeting: false,
  visibility: "team",
  updatedAt: "2026-06-18T00:00:00Z",
};

describe("calendar event layout", () => {
  it("detects date-only events as all-day", () => {
    expect(isAllDayEvent({ ...baseEvent, start: "2026-06-19", end: "2026-06-20" })).toBe(true);
    expect(isAllDayEvent(baseEvent)).toBe(false);
  });

  it("splits a cross-midnight event and lays overlaps into columns", () => {
    const segments = layoutTimedEvents(
      [
        { ...baseEvent, eventId: "a", start: "2026-06-19T09:00:00+09:00", end: "2026-06-19T11:00:00+09:00" },
        { ...baseEvent, eventId: "b", start: "2026-06-19T10:00:00+09:00", end: "2026-06-19T12:00:00+09:00" },
        { ...baseEvent, eventId: "c", start: "2026-06-19T23:00:00+09:00", end: "2026-06-20T01:00:00+09:00" },
      ],
      [new Date("2026-06-19T00:00:00+09:00"), new Date("2026-06-20T00:00:00+09:00")],
    );

    expect(segments.map(({ event, dayKey, startMinutes, endMinutes, column, columnCount }) => ({
      id: event.eventId, dayKey, startMinutes, endMinutes, column, columnCount,
    }))).toEqual([
      { id: "a", dayKey: "2026-06-19", startMinutes: 540, endMinutes: 660, column: 0, columnCount: 2 },
      { id: "b", dayKey: "2026-06-19", startMinutes: 600, endMinutes: 720, column: 1, columnCount: 2 },
      { id: "c", dayKey: "2026-06-19", startMinutes: 1380, endMinutes: 1440, column: 0, columnCount: 1 },
      { id: "c", dayKey: "2026-06-20", startMinutes: 0, endMinutes: 60, column: 0, columnCount: 1 },
    ]);
  });
});
```

- [ ] **Step 2: 新しいテストが未実装で失敗することを確認する**

Run: `npm test -- src/domain/calendar.test.ts`

Expected: FAIL because `isAllDayEvent` and `layoutTimedEvents` are not exported.

- [ ] **Step 3: 日付キー、表示日、イベント配置を実装する**

`src/domain/calendar.ts` に次を追加する。

```ts
import { eachDayOfInterval, format, min, parseISO } from "date-fns";
import type { NormalizedEvent } from "./schedule";

export interface TimedEventSegment {
  event: NormalizedEvent;
  dayKey: string;
  startMinutes: number;
  endMinutes: number;
  column: number;
  columnCount: number;
}

export function toDayKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function getVisibleDays(range: CalendarRange): Date[] {
  return eachDayOfInterval({ start: range.start, end: addDays(range.end, -1) });
}

export function isAllDayEvent(event: NormalizedEvent): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(event.start) && /^\d{4}-\d{2}-\d{2}$/.test(event.end);
}

export function eventsForDay(events: NormalizedEvent[], day: Date): NormalizedEvent[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  return events.filter((event) => {
    const eventStart = /^\d{4}-\d{2}-\d{2}$/.test(event.start) ? parseISO(event.start).getTime() : Date.parse(event.start);
    const eventEnd = /^\d{4}-\d{2}-\d{2}$/.test(event.end) ? parseISO(event.end).getTime() : Date.parse(event.end);
    return eventStart < dayEnd && eventEnd > dayStart;
  });
}

export function layoutTimedEvents(events: NormalizedEvent[], days: Date[]): TimedEventSegment[] {
  return days.flatMap((day) => {
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    const raw = events
      .filter((event) => !isAllDayEvent(event) && Date.parse(event.start) < dayEnd.getTime() && Date.parse(event.end) > dayStart.getTime())
      .map((event) => {
        const clippedStart = new Date(Math.max(Date.parse(event.start), dayStart.getTime()));
        const clippedEnd = min([new Date(event.end), dayEnd]);
        return {
          event,
          dayKey: toDayKey(day),
          startMinutes: clippedStart.getHours() * 60 + clippedStart.getMinutes(),
          endMinutes: clippedEnd.getTime() === dayEnd.getTime() ? 1440 : clippedEnd.getHours() * 60 + clippedEnd.getMinutes(),
          column: 0,
          columnCount: 1,
        };
      })
      .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);

    let cluster: TimedEventSegment[] = [];
    let clusterEnd = -1;
    const flush = () => {
      const columnEnds: number[] = [];
      for (const segment of cluster) {
        let column = columnEnds.findIndex((end) => end <= segment.startMinutes);
        if (column === -1) column = columnEnds.length;
        columnEnds[column] = segment.endMinutes;
        segment.column = column;
      }
      for (const segment of cluster) segment.columnCount = columnEnds.length;
      cluster = [];
      clusterEnd = -1;
    };

    for (const segment of raw) {
      if (cluster.length > 0 && segment.startMinutes >= clusterEnd) flush();
      cluster.push(segment);
      clusterEnd = Math.max(clusterEnd, segment.endMinutes);
    }
    if (cluster.length > 0) flush();
    return raw;
  });
}
```

上のimportは `eachDayOfInterval`, `format`, `min`, `parseISO` を既存date-fns importへ統合する。

- [ ] **Step 4: カレンダードメインテストを通す**

Run: `npm test -- src/domain/calendar.test.ts`

Expected: all tests PASS.

### Task 3: ツールバーと日・週時間軸

**Files:**
- Create: `src/components/CalendarToolbar.tsx`
- Create: `src/components/TimeGridCalendar.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: ツールバーを作成する**

```tsx
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import type { ViewMode } from "@/domain/calendar";

interface CalendarToolbarProps {
  title: string;
  mode: ViewMode;
  eventCount: number;
  onToday: () => void;
  onMove: (amount: -1 | 1) => void;
  onModeChange: (mode: ViewMode) => void;
}

export function CalendarToolbar(props: CalendarToolbarProps) {
  return (
    <div className="calendarToolbar">
      <div className="calendarNavigation">
        <button className="secondaryButton compactButton" onClick={props.onToday}>今日</button>
        <button className="iconButton" aria-label="前の期間" onClick={() => props.onMove(-1)}><ChevronLeft size={18} /></button>
        <button className="iconButton" aria-label="次の期間" onClick={() => props.onMove(1)}><ChevronRight size={18} /></button>
        <h2>{props.title}</h2>
      </div>
      <div className="calendarToolbarActions">
        <div className="controlGroup calendarMode" aria-label="表示切替">
          {(["day", "week", "month"] as const).map((mode) => (
            <button key={mode} className={props.mode === mode ? "active" : ""} onClick={() => props.onModeChange(mode)}>
              {{ day: "日", week: "週", month: "月" }[mode]}
            </button>
          ))}
        </div>
        <div className="countBadge"><Calendar aria-hidden="true" size={16} />{props.eventCount}件</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 時間軸コンポーネントを作成する**

```tsx
import { format } from "date-fns";
import { ja } from "date-fns/locale";
import type { NormalizedEvent } from "@/domain/schedule";
import { eventsForDay, isAllDayEvent, layoutTimedEvents, toDayKey } from "@/domain/calendar";

const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function TimeGridCalendar({ days, events }: { days: Date[]; events: NormalizedEvent[] }) {
  const segments = layoutTimedEvents(events, days);
  const allDayEvents = events.filter(isAllDayEvent);

  return (
    <div className="calendarScroller">
      <div className="timeGrid" style={{ "--calendar-columns": days.length } as React.CSSProperties}>
        <div className="timeGridHeaderCorner" />
        {days.map((day) => <div className="timeGridDayHeader" key={toDayKey(day)}>{format(day, "E d", { locale: ja })}</div>)}
        <div className="allDayLabel">終日</div>
        {days.map((day) => (
          <div className="allDayCell" key={toDayKey(day)}>
            {eventsForDay(allDayEvents, day).map((event) => <EventCard key={event.eventId} event={event} compact />)}
          </div>
        ))}
        <div className="hourLabels">{HOURS.map((hour) => <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>{`${hour}:00`}</span>)}</div>
        {days.map((day) => {
          const dayKey = toDayKey(day);
          return (
            <div className="timeGridDay" key={dayKey} style={{ height: 24 * HOUR_HEIGHT }}>
              {HOURS.map((hour) => <div className="hourLine" key={hour} style={{ top: hour * HOUR_HEIGHT }} />)}
              {segments.filter((segment) => segment.dayKey === dayKey).map((segment) => (
                <div key={`${segment.event.eventId}:${segment.dayKey}`} className={`timedEvent ${segment.event.source}`} style={{
                  top: segment.startMinutes / 60 * HOUR_HEIGHT,
                  height: Math.max((segment.endMinutes - segment.startMinutes) / 60 * HOUR_HEIGHT, 22),
                  left: `${segment.column / segment.columnCount * 100}%`,
                  width: `${100 / segment.columnCount}%`,
                }}><EventCard event={segment.event} /></div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventCard({ event, compact = false }: { event: NormalizedEvent; compact?: boolean }) {
  return (
    <article className={`calendarEventCard ${event.source}`} title={`${event.title} / ${event.ownerName}`}>
      {!compact && <time>{format(new Date(event.start), "HH:mm")}–{format(new Date(event.end), "HH:mm")}</time>}
      <strong>{event.title}</strong>
      <span>{event.ownerName}{event.location ? ` / ${event.location}` : ""}</span>
    </article>
  );
}
```

- [ ] **Step 3: 時間軸スタイルを追加する**

`app/globals.css` の既存カレンダー一覧スタイルを、次のクラス群を含むグリッドスタイルへ置き換える。

```css
.calendarToolbar,.calendarNavigation,.calendarToolbarActions{align-items:center;display:flex;gap:10px}
.calendarToolbar{justify-content:space-between;margin-bottom:16px}
.calendarNavigation h2{font-size:22px;margin:0 0 0 6px}
.calendarToolbarActions{margin-left:auto}
.calendarMode{grid-template-columns:repeat(3,1fr);min-width:150px}
.compactButton{min-height:36px}.iconButton{align-items:center;background:#fff;border:1px solid var(--border);border-radius:6px;display:inline-flex;height:36px;justify-content:center;width:36px}
.calendarScroller{border:1px solid var(--border);border-radius:8px;overflow:auto;max-height:calc(100vh - 190px)}
.timeGrid{display:grid;grid-template-columns:56px repeat(var(--calendar-columns),minmax(120px,1fr));min-width:720px;position:relative}
.timeGridHeaderCorner,.timeGridDayHeader,.allDayLabel,.allDayCell{background:#fff;border-bottom:1px solid var(--border);border-right:1px solid var(--border);min-height:38px;padding:8px;position:sticky;top:0;z-index:5}
.timeGridDayHeader{text-align:center;font-weight:800}.allDayLabel{color:var(--muted);font-size:12px;grid-column:1;top:38px;z-index:5}.allDayCell{top:38px;z-index:4}
.hourLabels{position:relative}.hourLabels span{color:var(--muted);font-size:11px;position:absolute;right:8px;transform:translateY(-50%)}
.timeGridDay{border-left:1px solid var(--border);position:relative}.hourLine{border-top:1px solid #e8ebea;left:0;position:absolute;right:0}
.timedEvent{overflow:hidden;padding:1px 2px;position:absolute}.calendarEventCard{border-left:3px solid currentColor;border-radius:4px;height:100%;overflow:hidden;padding:4px 6px}.calendarEventCard time,.calendarEventCard strong,.calendarEventCard span{display:block;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.calendarEventCard.google{background:#e8f0fe;color:#174ea6}.calendarEventCard.microsoft{background:#e7f0ff;color:#1b4f9c}.calendarEventCard.teams{background:#eeeafd;color:#4b3ca7}
```

- [ ] **Step 4: 型チェックを実行する**

Run: `npx tsc --noEmit`

Expected: PASS with no diagnostics.

### Task 4: 月間グリッド

**Files:**
- Create: `src/components/MonthCalendar.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: 月間コンポーネントを作成する**

```tsx
import { format, isSameDay, isSameMonth } from "date-fns";
import { ja } from "date-fns/locale";
import type { NormalizedEvent } from "@/domain/schedule";
import { eventsForDay, toDayKey } from "@/domain/calendar";

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

export function MonthCalendar({ days, selectedDate, events }: { days: Date[]; selectedDate: Date; events: NormalizedEvent[] }) {
  return (
    <div className="calendarScroller monthScroller">
      <div className="monthGrid">
        {WEEKDAYS.map((day) => <div className="monthWeekday" key={day}>{day}</div>)}
        {days.map((day) => {
          const dayEvents = eventsForDay(events, day);
          return (
            <section className={`monthDay ${!isSameMonth(day, selectedDate) ? "outsideMonth" : ""} ${isSameDay(day, new Date()) ? "today" : ""}`} key={toDayKey(day)}>
              <time>{format(day, "d", { locale: ja })}</time>
              {dayEvents.slice(0, 3).map((event) => (
                <article className={`monthEvent ${event.source}`} key={event.eventId} title={`${event.title} / ${event.ownerName}`}>
                  {!/^\d{4}-\d{2}-\d{2}$/.test(event.start) && <span>{format(new Date(event.start), "HH:mm")}</span>} {event.title}
                </article>
              ))}
              {dayEvents.length > 3 && <span className="moreEvents">ほか{dayEvents.length - 3}件</span>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 月間スタイルを追加する**

```css
.monthScroller{max-height:none}.monthGrid{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));min-width:840px}
.monthWeekday{background:#f8faf9;border-bottom:1px solid var(--border);font-size:12px;font-weight:800;padding:8px;text-align:center}
.monthDay{border-bottom:1px solid var(--border);border-right:1px solid var(--border);min-height:120px;padding:7px}.monthDay>time{display:inline-flex;font-size:12px;font-weight:800;margin-bottom:5px}.monthDay.outsideMonth{background:#f7f8f8;color:var(--muted)}.monthDay.today>time{align-items:center;background:var(--accent);border-radius:50%;color:#fff;height:24px;justify-content:center;width:24px}
.monthEvent{border-left:3px solid currentColor;border-radius:3px;font-size:11px;margin-bottom:4px;overflow:hidden;padding:4px;white-space:nowrap;text-overflow:ellipsis}.monthEvent.google{background:#e8f0fe;color:#174ea6}.monthEvent.microsoft{background:#e7f0ff;color:#1b4f9c}.monthEvent.teams{background:#eeeafd;color:#4b3ca7}.moreEvents{color:var(--muted);font-size:11px;font-weight:700}
```

- [ ] **Step 3: 型チェックを実行する**

Run: `npx tsc --noEmit`

Expected: PASS with no diagnostics.

### Task 5: ScheduleAppへ統合し、古い取得結果を破棄する

**Files:**
- Modify: `src/components/ScheduleApp.tsx`
- Create: `src/components/ScheduleApp.test.tsx`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `app/globals.css`

- [ ] **Step 1: DOMテスト環境を追加する**

Run: `npm install --save-dev jsdom`

Expected: `jsdom` が `devDependencies` に追加され、`package-lock.json` が更新される。

`vitest.config.ts` のincludeを次に変更する。

```ts
include: ["src/**/*.test.{ts,tsx}"],
```

- [ ] **Step 2: 表示切替とAPI範囲の失敗テストを書く**

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleApp } from "./ScheduleApp";

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: vi.fn(),
  getMicrosoftProvider: vi.fn(),
  hasFirebaseClientConfig: () => false,
}));

describe("ScheduleApp calendar navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T12:00:00+09:00"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [] }))));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fetches the active week, month, and next month ranges", async () => {
    render(<ScheduleApp initialMembers={[]} />);
    await act(async () => {});

    const fetchMock = vi.mocked(fetch);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("start=2026-06-14T15%3A00%3A00.000Z");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("end=2026-06-21T15%3A00%3A00.000Z");

    fireEvent.click(screen.getByRole("button", { name: "月" }));
    await act(async () => {});
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("start=2026-05-31T15%3A00%3A00.000Z");

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    await act(async () => {});
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("start=2026-06-28T15%3A00%3A00.000Z");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("end=2026-08-02T15%3A00%3A00.000Z");
  });
});
```

- [ ] **Step 3: コンポーネントテストが失敗することを確認する**

Run: `npm test -- src/components/ScheduleApp.test.tsx`

Expected: FAIL because the month button and period navigation do not exist.

- [ ] **Step 4: 表示状態と期間計算を置き換える**

次のimportと状態を使用し、固定日付とローカル `ViewMode` を削除する。

```tsx
import { format } from "date-fns";
import { ja } from "date-fns/locale";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarToolbar } from "@/components/CalendarToolbar";
import { MonthCalendar } from "@/components/MonthCalendar";
import { TimeGridCalendar } from "@/components/TimeGridCalendar";
import { getCalendarRange, getVisibleDays, moveSelectedDate, type ViewMode } from "@/domain/calendar";

const [mode, setMode] = useState<ViewMode>("week");
const [selectedDate, setSelectedDate] = useState(() => new Date());
const requestIdRef = useRef(0);
const range = useMemo(() => getCalendarRange(mode, selectedDate), [mode, selectedDate]);
const visibleDays = useMemo(() => getVisibleDays(range), [range]);
```

- [ ] **Step 5: API取得を表示期間とリクエストIDに対応させる**

```tsx
const loadEvents = useCallback(async () => {
  const requestId = ++requestIdRef.current;
  setLoading(true);
  setError(null);
  try {
    const params = new URLSearchParams({ start: range.start.toISOString(), end: range.end.toISOString() });
    if (selectedOwner !== "all") params.set("ownerUserId", selectedOwner);
    const headers: HeadersInit = {};
    if (firebaseReady && firebaseUser) headers.authorization = `Bearer ${await firebaseUser.getIdToken()}`;
    else headers["x-demo-email"] = "admin@example.co.jp";
    const response = await fetch(`/api/events?${params.toString()}`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const body = (await response.json()) as { events: NormalizedEvent[] };
    if (requestId === requestIdRef.current) setEvents(body.events);
  } catch (caught) {
    if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : "予定の取得に失敗しました。");
  } finally {
    if (requestId === requestIdRef.current) setLoading(false);
  }
}, [firebaseReady, firebaseUser, range, selectedOwner]);
```

- [ ] **Step 6: 一覧表示をカレンダー表示へ置き換える**

```tsx
const title = mode === "day"
  ? format(selectedDate, "yyyy年M月d日 EEEE", { locale: ja })
  : mode === "week"
    ? `${format(range.start, "yyyy年M月d日", { locale: ja })} – ${format(new Date(range.end.getTime() - 1), "M月d日", { locale: ja })}`
    : format(selectedDate, "yyyy年M月", { locale: ja });

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
  {mode === "month"
    ? <MonthCalendar days={visibleDays} selectedDate={selectedDate} events={events} />
    : <TimeGridCalendar days={visibleDays} events={events} />}
  {!loading && events.length === 0 ? <p className="emptyText calendarEmpty">表示対象の予定はありません。</p> : null}
</section>
```

サイドバー内の旧 `controlGroup` は削除する。認証、担当者選択、更新ボタンは維持する。

- [ ] **Step 7: レスポンシブ表示を仕上げる**

```css
.scheduleSurface{min-width:0}.loadingText{color:var(--accent-dark);font-size:13px;font-weight:700}.calendarEmpty{margin:12px 0 0}
@media(max-width:900px){.calendarToolbar{align-items:flex-start;flex-direction:column}.calendarToolbarActions{margin-left:0;width:100%}.calendarNavigation{flex-wrap:wrap}.calendarNavigation h2{flex-basis:100%;margin:4px 0 0}.calendarScroller{max-height:70vh}}
@media(max-width:760px){.scheduleSurface{padding:12px}.calendarToolbarActions{align-items:stretch;flex-direction:column}.countBadge{align-self:flex-start}}
```

- [ ] **Step 8: コンポーネントテスト、全テスト、型チェックを実行する**

Run: `npm test -- src/components/ScheduleApp.test.tsx && npm test && npx tsc --noEmit`

Expected: all tests PASS and no TypeScript diagnostics.

### Task 6: ドキュメントと生成物除外を更新する

**Files:**
- Modify: `PROJECT.md`
- Modify: `.gitignore`

- [ ] **Step 1: MVP要件へ表示方式を追記する**

`PROJECT.md` の `MVP Requirements` に次を追加する。

```md
- 予定はGoogleカレンダー型の日・週・月表示で閲覧でき、表示期間を前後または今日へ移動できる。
```

- [ ] **Step 2: ブレインストーミング生成物をGit対象外にする**

`.gitignore` に次を追加する。

```gitignore
.superpowers/
```

- [ ] **Step 3: ドキュメント差分を確認する**

Run: `git diff -- PROJECT.md .gitignore docs/plans/2026-06-19-calendar-views-design.md docs/plans/2026-06-19-calendar-views-implementation.md`

Expected: カレンダー要件、設計書、実装計画、生成物除外だけが表示される。

### Task 7: 完了検証

**Files:**
- Verify only

- [ ] **Step 1: 全テストを実行する**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 2: TypeScriptを検証する**

Run: `npx tsc --noEmit`

Expected: exit code 0 with no diagnostics.

- [ ] **Step 3: 本番ビルドを検証する**

Run: `npm run build`

Expected: Next.js production build succeeds.

- [ ] **Step 4: ブラウザで主要操作を確認する**

Run: `npm run dev`

Expected:

- 初期表示は今週の月曜から日曜になる。
- 日・週は24時間の時間軸、月は月間グリッドになる。
- 今日、前の期間、次の期間で見出しとAPI取得期間が変わる。
- 担当者フィルターで表示対象が変わる。
- 重複予定が横並びになり、Google/Microsoft/Teamsの色を維持する。
- 狭い画面で週・月表示を横スクロールできる。
- ブラウザコンソールに新しいエラーがない。

- [ ] **Step 5: 最終差分を確認する**

Run: `git status --short && git diff --check && git diff --stat`

Expected: 対象ファイルだけが変更され、`git diff --check` が成功する。
