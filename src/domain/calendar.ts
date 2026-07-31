import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  format,
  min,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { NormalizedEvent } from "./schedule";

export type ViewMode = "day" | "week" | "month";

export interface CalendarRange {
  start: Date;
  end: Date;
}

export interface TimedEventSegment {
  event: NormalizedEvent;
  dayKey: string;
  startMinutes: number;
  endMinutes: number;
  column: number;
  columnCount: number;
}

const WEEK_OPTIONS = { weekStartsOn: 1 as const };
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

export function getVisibleDays(range: CalendarRange): Date[] {
  return eachDayOfInterval({ start: range.start, end: addDays(range.end, -1) });
}

export function toDayKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function isAllDayEvent(event: NormalizedEvent): boolean {
  return DATE_ONLY_PATTERN.test(event.start) && DATE_ONLY_PATTERN.test(event.end);
}

export function eventsForDay(events: NormalizedEvent[], day: Date): NormalizedEvent[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();

  return events.filter((event) => {
    const eventStart = parseEventDate(event.start).getTime();
    const eventEnd = parseEventDate(event.end).getTime();
    return eventStart < dayEnd && eventEnd > dayStart;
  });
}

export function layoutTimedEvents(
  events: NormalizedEvent[],
  days: Date[],
): TimedEventSegment[] {
  return days.flatMap((day) => {
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    const segments = events
      .filter(
        (event) =>
          !isAllDayEvent(event) &&
          Date.parse(event.start) < dayEnd.getTime() &&
          Date.parse(event.end) > dayStart.getTime(),
      )
      .map<TimedEventSegment>((event) => {
        const clippedStart = new Date(Math.max(Date.parse(event.start), dayStart.getTime()));
        const clippedEnd = min([new Date(event.end), dayEnd]);
        return {
          event,
          dayKey: toDayKey(day),
          startMinutes: clippedStart.getHours() * 60 + clippedStart.getMinutes(),
          endMinutes:
            clippedEnd.getTime() === dayEnd.getTime()
              ? 1440
              : clippedEnd.getHours() * 60 + clippedEnd.getMinutes(),
          column: 0,
          columnCount: 1,
        };
      })
      .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);

    layoutClusters(segments);
    return segments;
  });
}

function layoutClusters(segments: TimedEventSegment[]) {
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

  for (const segment of segments) {
    if (cluster.length > 0 && segment.startMinutes >= clusterEnd) flush();
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.endMinutes);
  }
  if (cluster.length > 0) flush();
}

function parseEventDate(value: string): Date {
  return DATE_ONLY_PATTERN.test(value) ? parseISO(value) : new Date(value);
}
