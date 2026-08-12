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
                <div
                  className="memberScheduleCell"
                  key={toDayKey(day)}
                  role="cell"
                  aria-label={`${member.displayName} ${format(day, "M月d日", { locale: ja })}`}
                >
                  {eventsForDay(memberEvents, day)
                    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
                    .map((event) => <MemberEventCard day={day} event={event} key={event.eventId} />)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const clippedStart = new Date(Math.max(Date.parse(event.start), dayStart.getTime()));
  const clippedEnd = new Date(Math.min(Date.parse(event.end), dayEnd.getTime()));
  const endLabel = clippedEnd.getTime() === dayEnd.getTime() ? "24:00" : format(clippedEnd, "HH:mm");
  return `${format(clippedStart, "HH:mm")}–${endLabel}`;
}
