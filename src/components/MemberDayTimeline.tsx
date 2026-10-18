"use client";

import { addDays, format, startOfDay } from "date-fns";
import { ja } from "date-fns/locale";
import { useEffect, useRef, type CSSProperties } from "react";

import { MemberAvatar } from "@/components/MemberAvatar";
import { eventsForDay, isAllDayEvent, layoutTimedEvents, type TimedEventSegment } from "@/domain/calendar";
import type { PublicSalesMember } from "@/domain/member";
import { getMemberColorStyle, type MemberColorMap } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";

const HOUR_HEIGHT = 80;
const TOTAL_HEIGHT = 24 * HOUR_HEIGHT;
const MIN_EVENT_MINUTES = 24;
const MIN_EVENT_HEIGHT = MIN_EVENT_MINUTES * HOUR_HEIGHT / 60;

type MemberColumn = { id: string; name: string; department: string; events: NormalizedEvent[] };
type DisplaySegment = TimedEventSegment & {
  displayStart: number;
  displayEnd: number;
};

export function MemberDayTimeline({
  day,
  events,
  members,
  memberColors,
  memberPhotoUrls = {},
  onEventSelect,
}: {
  day: Date;
  events: NormalizedEvent[];
  members: PublicSalesMember[];
  memberColors: MemberColorMap;
  memberPhotoUrls?: Record<string, string>;
  onEventSelect?: (event: NormalizedEvent) => void;
}) {
  const dayEvents = eventsForDay(events, day);
  const columns = buildColumns(members, dayEvents);
  const timedColumns = columns.map((column) => layoutDisplaySegments(
    layoutTimedEvents(column.events.filter((event) => !isAllDayEvent(event)), [day]),
  ));
  const firstTimedMinute = timedColumns.flat().reduce(
    (earliest, segment) => Math.min(earliest, segment.startMinutes),
    Number.POSITIVE_INFINITY,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const firstHour = Number.isFinite(firstTimedMinute)
      ? Math.floor(firstTimedMinute / 60)
      : 9;
    const scrollToFirstEvent = () => {
      // Leave enough space below the frozen rows to read the first hour label.
      if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, Math.min(23, firstHour - 1) * HOUR_HEIGHT - 12);
    };
    scrollToFirstEvent();
    // A parent dialog opens in its effect, after this child effect runs.
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(scrollToFirstEvent) : undefined;
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [day.getTime(), firstTimedMinute]);

  const gridStyle = {
    "--timeline-columns": columns.length,
    "--timeline-height": `${TOTAL_HEIGHT}px`,
    "--timeline-hour-height": `${HOUR_HEIGHT}px`,
  } as CSSProperties;

  return (
    <section aria-label="担当者別の日別スケジュール" className="memberDayTimeline">
      <div className="memberDayTimelineTitle">
        <h2>{format(day, "M月d日（E）のスケジュール", { locale: ja })}</h2>
        <span>{dayEvents.length}件</span>
      </div>
      {columns.length === 0 ? (
        <p className="memberDayEmpty">この日の予定はありません。</p>
      ) : (
        <div
          aria-label="日別スケジュールのスクロール領域"
          className="memberDayTimelineScroller"
          ref={scrollRef}
          role="region"
          tabIndex={0}
        >
          <div
            aria-label="担当者別の時間割"
            className="memberDayTimelineGrid"
            role="table"
            style={gridStyle}
          >
            <div className="memberDayTimelineRow" role="row">
            <div className="memberDayCorner" role="columnheader">時刻</div>
            {columns.map((column) => (
              <div
                className="memberDayHeader"
                role="columnheader"
                key={`header:${column.id}`}
                style={getMemberColorStyle(column.id, memberColors)}
              >
                <MemberAvatar
                  displayName={column.name}
                  photoUrl={memberPhotoUrls[column.id]}
                  small
                />
                <span className="memberDayHeaderText">
                  <strong>{column.name}</strong>
                  {column.department ? <span>{column.department}</span> : null}
                  <small>{column.events.length}件</small>
                </span>
              </div>
            ))}
            </div>
            <div className="memberDayTimelineRow" role="row">
            <div className="memberDayAllDayCorner" role="rowheader">終日</div>
            {columns.map((column) => (
              <div className="memberDayAllDay" role="cell" aria-label={`${column.name}の終日予定`} key={`allDay:${column.id}`}>
                {column.events.filter(isAllDayEvent).map((event) => (
                  <button
                    className="memberDayAllDayEvent memberColoredEvent"
                    key={event.eventId}
                    onClick={() => onEventSelect?.(event)}
                    style={getMemberColorStyle(column.id, memberColors)}
                    type="button"
                  >
                    <span>終日</span>
                    <strong>{event.title}</strong>
                    {event.location ? <span>{event.location}</span> : null}
                  </button>
                ))}
              </div>
            ))}
            </div>
            <div className="memberDayTimelineRow" role="row">
            <div className="memberDayAxis" role="rowheader" aria-label="時刻" style={{ height: TOTAL_HEIGHT }}>
              {Array.from({ length: 25 }, (_, hour) => (
                <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
                  {String(hour).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            {columns.map((column, index) => (
              <div
                aria-label={`${column.name}の時間別予定`}
                className="memberDayColumn"
                role="cell"
                key={`column:${column.id}`}
                style={{ height: TOTAL_HEIGHT }}
              >
                {timedColumns[index].map((segment) => {
                  const event = segment.event;
                  const dayStart = startOfDay(day).getTime();
                  const dayEnd = addDays(startOfDay(day), 1).getTime();
                  const continuation = [
                    Date.parse(event.start) < dayStart ? "前日から継続" : "",
                    Date.parse(event.end) > dayEnd ? "翌日へ継続" : "",
                  ].filter(Boolean).join("・");
                  const slotStyle = {
                    top: segment.displayStart * HOUR_HEIGHT / 60,
                    height: Math.max(MIN_EVENT_HEIGHT, (segment.displayEnd - segment.displayStart) * HOUR_HEIGHT / 60),
                    left: `${segment.column / segment.columnCount * 100}%`,
                    width: `${100 / segment.columnCount}%`,
                  };
                  return (
                    <div className="memberDayEventSlot" key={event.eventId} style={slotStyle}>
                      <button
                        className={`memberDayEvent memberColoredEvent${segment.displayEnd - segment.displayStart < 30
                          ? " memberDayEventShort" : segment.displayEnd - segment.displayStart < 60 ? " memberDayEventBrief" : ""}`}
                        title={`${minuteLabel(segment.startMinutes)}–${minuteLabel(segment.endMinutes)} ${event.title}${event.location ? ` / ${event.location}` : ""}${continuation ? ` / ${continuation}` : ""}`}
                        onClick={() => onEventSelect?.(event)}
                        style={getMemberColorStyle(column.id, memberColors)}
                        type="button"
                      >
                        <time>{minuteLabel(segment.startMinutes)}–{minuteLabel(segment.endMinutes)}</time>
                        <strong>{event.title}</strong>
                        {event.location ? <span className="memberDayLocation">{event.location}</span> : null}
                        {continuation ? (
                          <span className="memberDayContinuation">{continuation}</span>
                        ) : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function buildColumns(members: PublicSalesMember[], events: NormalizedEvent[]): MemberColumn[] {
  const byId = new Map<string, MemberColumn>();
  for (const member of members) {
    byId.set(member.id, { id: member.id, name: member.displayName, department: member.department, events: [] });
  }
  const extras = new Map<string, MemberColumn>();
  for (const event of events) {
    let column = byId.get(event.ownerUserId) ?? extras.get(event.ownerUserId);
    if (!column) {
      column = { id: event.ownerUserId, name: event.ownerName, department: "", events: [] };
      extras.set(event.ownerUserId, column);
    }
    column.events.push(event);
  }
  return [...byId.values(), ...[...extras.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id))];
}

function layoutDisplaySegments(segments: TimedEventSegment[]): DisplaySegment[] {
  const displaySegments = segments.map((segment) => {
    const displayStart = Math.min(segment.startMinutes, 1440 - MIN_EVENT_MINUTES);
    return {
      ...segment,
      displayStart,
      displayEnd: Math.min(1440, Math.max(segment.endMinutes, displayStart + MIN_EVENT_MINUTES)),
    };
  }).sort((a, b) => a.displayStart - b.displayStart || a.startMinutes - b.startMinutes);

  let cluster: DisplaySegment[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    for (const segment of cluster) {
      let lane = laneEnds.findIndex((end) => end <= segment.displayStart);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = segment.displayEnd;
      segment.column = lane;
    }
    for (const segment of cluster) segment.columnCount = laneEnds.length;
    cluster = [];
    clusterEnd = -1;
  };

  for (const segment of displaySegments) {
    if (cluster.length > 0 && segment.displayStart >= clusterEnd) flush();
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.displayEnd);
  }
  if (cluster.length > 0) flush();
  return displaySegments;
}

function minuteLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
