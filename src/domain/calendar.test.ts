import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "./schedule";
import {
  eventsForDay,
  getCalendarRange,
  getVisibleDays,
  isAllDayEvent,
  layoutTimedEvents,
  moveSelectedDate,
} from "./calendar";

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

describe("calendar range", () => {
  const selected = new Date("2026-06-19T12:00:00+09:00");

  it.each([
    ["day", "2026-06-18T15:00:00.000Z", "2026-06-19T15:00:00.000Z", 1],
    ["week", "2026-06-14T15:00:00.000Z", "2026-06-21T15:00:00.000Z", 7],
    ["month", "2026-05-31T15:00:00.000Z", "2026-07-05T15:00:00.000Z", 35],
  ] as const)("returns the %s API range", (mode, start, end, dayCount) => {
    const range = getCalendarRange(mode, selected);
    expect(range.start.toISOString()).toBe(start);
    expect(range.end.toISOString()).toBe(end);
    expect(getVisibleDays(range)).toHaveLength(dayCount);
  });

  it("moves by the active view unit across month and year boundaries", () => {
    expect(moveSelectedDate(selected, "day", 1).getDate()).toBe(20);
    expect(moveSelectedDate(selected, "week", -1).getDate()).toBe(12);
    expect(moveSelectedDate(selected, "month", 1).getMonth()).toBe(6);
    expect(moveSelectedDate(new Date("2026-12-19T12:00:00+09:00"), "month", 1).getFullYear()).toBe(2027);
  });
});

describe("calendar event layout", () => {
  it("detects date-only events as all-day", () => {
    expect(isAllDayEvent({ ...baseEvent, start: "2026-06-19", end: "2026-06-20" })).toBe(true);
    expect(isAllDayEvent(baseEvent)).toBe(false);
  });

  it("uses an exclusive end date for all-day events", () => {
    const allDayEvent = { ...baseEvent, start: "2026-06-19", end: "2026-06-20" };
    expect(eventsForDay([allDayEvent], new Date("2026-06-19T00:00:00+09:00"))).toHaveLength(1);
    expect(eventsForDay([allDayEvent], new Date("2026-06-20T00:00:00+09:00"))).toHaveLength(0);
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
      id: event.eventId,
      dayKey,
      startMinutes,
      endMinutes,
      column,
      columnCount,
    }))).toEqual([
      { id: "a", dayKey: "2026-06-19", startMinutes: 540, endMinutes: 660, column: 0, columnCount: 2 },
      { id: "b", dayKey: "2026-06-19", startMinutes: 600, endMinutes: 720, column: 1, columnCount: 2 },
      { id: "c", dayKey: "2026-06-19", startMinutes: 1380, endMinutes: 1440, column: 0, columnCount: 1 },
      { id: "c", dayKey: "2026-06-20", startMinutes: 0, endMinutes: 60, column: 0, columnCount: 1 },
    ]);
  });
});
