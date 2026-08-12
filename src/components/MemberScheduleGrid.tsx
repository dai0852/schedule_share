import { addDays, format, isSameDay, startOfDay } from "date-fns";
import { ja } from "date-fns/locale";
import type { CSSProperties } from "react";

import { eventsForDay, isAllDayEvent, toDayKey } from "@/domain/calendar";
import type { PublicSalesMember } from "@/domain/member";
import { CALENDAR_SOURCE_LABELS, type NormalizedEvent } from "@/domain/schedule";

export function MemberScheduleGrid({
  days,
  events,
  members,
}: {
  days: Date[];
  events: NormalizedEvent[];
  members: PublicSalesMember[];
}) {
  const gridStyle = { "--calendar-columns": days.length } as CSSProperties;

  return (
    <div
      className="calendarScroller memberScheduleScroller"
      role="region"
      aria-label="担当者予定表の横スクロール領域"
      tabIndex={0}
    >
      <div
        className="memberScheduleGrid"
        role="table"
        aria-label="担当者予定表"
        aria-rowcount={members.length + 1}
        aria-colcount={days.length + 1}
        style={gridStyle}
      >
        <div className="memberScheduleRow memberScheduleHeader" role="row">
          <div className="memberScheduleCorner" role="columnheader">担当者</div>
          {days.map((day) => (
            <div
              className={`memberScheduleDayHeader ${isSameDay(day, new Date()) ? "today" : ""}`}
              key={toDayKey(day)}
              role="columnheader"
            >
              <span>{format(day, "E", { locale: ja })}</span>
              <strong>{format(day, "d")}</strong>
            </div>
          ))}
        </div>

        {members.map((member) => {
          const memberEvents = events.filter((event) => event.ownerUserId === member.id);
          return (
            <div className="memberScheduleRow" key={member.id} role="row">
              <div className="memberScheduleMember" role="rowheader">
                <span className="memberAvatar" aria-hidden="true">
                  {member.displayName.trim().slice(0, 1)}
                </span>
                <span>
                  <strong>{member.displayName}</strong>
                  <small>{member.department}</small>
                </span>
              </div>
              {days.map((day) => (
                <MemberDayCell
                  day={day}
                  events={memberEvents}
                  key={toDayKey(day)}
                  memberName={member.displayName}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MemberDayCell({
  day,
  events,
  memberName,
}: {
  day: Date;
  events: NormalizedEvent[];
  memberName: string;
}) {
  const dayEvents = eventsForDay(events, day)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const allDayEvents = dayEvents.filter(isAllDayEvent);
  const timedGroups = groupOverlappingEvents(dayEvents.filter((event) => !isAllDayEvent(event)), day);

  return (
    <div
      className="memberScheduleCell"
      role="cell"
      aria-label={`${memberName} ${format(day, "M月d日", { locale: ja })}`}
    >
      {allDayEvents.map((event) => (
        <MemberEventCard day={day} event={event} key={event.eventId} />
      ))}
      {timedGroups.map((group) => {
        const groupStyle = { "--member-overlap-columns": group.lanes.length } as CSSProperties;
        const startLabel = format(new Date(group.startMs), "HH:mm");
        const eventCount = group.lanes.reduce((count, lane) => count + lane.length, 0);
        const positionedEvents = group.lanes
          .flatMap((lane, laneIndex) => lane.map((interval) => ({ ...interval, laneIndex })))
          .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
        const groupLabel = group.lanes.length > 1
          ? `${startLabel}から重なる予定 ${eventCount}件`
          : `${startLabel}の予定 ${eventCount}件`;

        return (
          <div
            aria-label={groupLabel}
            className="memberScheduleEventGroup"
            key={`${group.startMs}:${group.lanes[0][0].event.eventId}`}
            role="group"
            style={groupStyle}
          >
            {positionedEvents.map(({ event, laneIndex }) => (
              <div
                className="memberScheduleEventSlot"
                key={event.eventId}
                style={{ gridColumn: laneIndex + 1 }}
              >
                <MemberEventCard day={day} event={event} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

interface TimedEventInterval {
  event: NormalizedEvent;
  startMs: number;
  endMs: number;
}

interface TimedEventGroup {
  startMs: number;
  endMs: number;
  lanes: TimedEventInterval[][];
}

function groupOverlappingEvents(events: NormalizedEvent[], day: Date): TimedEventGroup[] {
  const intervals = events
    .map((event) => ({ event, ...eventIntervalForDay(event, day) }))
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const groups: TimedEventGroup[] = [];

  for (const interval of intervals) {
    const currentGroup = groups.at(-1);
    if (!currentGroup || interval.startMs >= currentGroup.endMs) {
      groups.push({
        startMs: interval.startMs,
        endMs: interval.endMs,
        lanes: [[interval]],
      });
      continue;
    }

    currentGroup.endMs = Math.max(currentGroup.endMs, interval.endMs);
    const availableLane = currentGroup.lanes.find(
      (lane) => lane[lane.length - 1].endMs <= interval.startMs,
    );
    if (availableLane) availableLane.push(interval);
    else currentGroup.lanes.push([interval]);
  }

  return groups;
}

function MemberEventCard({ day, event }: { day: Date; event: NormalizedEvent }) {
  return (
    <article
      className={`memberScheduleEvent ${event.source}`}
      title={`${event.title} / ${event.ownerName}`}
    >
      <span className="memberScheduleEventMeta">
        <time>
          {isAllDayEvent(event)
            ? "終日"
            : eventTimeForDay(event, day)}
        </time>
        <span aria-label={`予定元: ${CALENDAR_SOURCE_LABELS[event.source]}`}>
          {CALENDAR_SOURCE_LABELS[event.source]}
        </span>
      </span>
      <strong>{event.title}</strong>
      {event.location ? <span className="memberScheduleLocation">{event.location}</span> : null}
    </article>
  );
}

function eventTimeForDay(event: NormalizedEvent, day: Date): string {
  const { startMs, endMs } = eventIntervalForDay(event, day);
  const dayEndMs = addDays(startOfDay(day), 1).getTime();
  const endLabel = endMs === dayEndMs ? "24:00" : format(new Date(endMs), "HH:mm");
  return `${format(new Date(startMs), "HH:mm")}–${endLabel}`;
}

function eventIntervalForDay(
  event: NormalizedEvent,
  day: Date,
): { startMs: number; endMs: number } {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return {
    startMs: Math.max(Date.parse(event.start), dayStart.getTime()),
    endMs: Math.min(Date.parse(event.end), dayEnd.getTime()),
  };
}
