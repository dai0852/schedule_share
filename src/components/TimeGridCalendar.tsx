import { format, isSameDay } from "date-fns";
import { ja } from "date-fns/locale";
import type { CSSProperties } from "react";
import {
  eventsForDay,
  isAllDayEvent,
  layoutTimedEvents,
  toDayKey,
} from "@/domain/calendar";
import { getCompactEventLocation } from "@/domain/eventPresentation";
import { createMemberColorMap, getMemberColorStyle, type MemberColorMap } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";

const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function TimeGridCalendar({
  days,
  events,
  memberColors,
  onEventSelect,
}: {
  days: Date[];
  events: NormalizedEvent[];
  memberColors?: MemberColorMap;
  onEventSelect?: (event: NormalizedEvent) => void;
}) {
  const segments = layoutTimedEvents(events, days);
  const allDayEvents = events.filter(isAllDayEvent);
  const gridStyle = { "--calendar-columns": days.length } as CSSProperties;
  const colors = memberColors ?? createMemberColorMap(events.map((event) => event.ownerUserId));

  return (
    <div className="calendarScroller timeGridScroller">
      <div className="timeGrid" style={gridStyle}>
        <div className="timeGridHeaderCorner" />
        {days.map((day) => (
          <div
            className={`timeGridDayHeader ${isSameDay(day, new Date()) ? "today" : ""}`}
            key={toDayKey(day)}
          >
            {format(day, "E d", { locale: ja })}
          </div>
        ))}

        <div className="allDayLabel">終日</div>
        {days.map((day) => (
          <div className="allDayCell" key={toDayKey(day)}>
            {eventsForDay(allDayEvents, day).map((event) => (
              <EventCard key={event.eventId} event={event} compact memberColors={colors} onEventSelect={onEventSelect} />
            ))}
          </div>
        ))}

        <div className="hourLabels" style={{ height: 24 * HOUR_HEIGHT }}>
          {HOURS.map((hour) => (
            <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
              {`${hour}:00`}
            </span>
          ))}
        </div>
        {days.map((day) => {
          const dayKey = toDayKey(day);
          return (
            <div className="timeGridDay" key={dayKey} style={{ height: 24 * HOUR_HEIGHT }}>
              {HOURS.map((hour) => (
                <div className="hourLine" key={hour} style={{ top: hour * HOUR_HEIGHT }} />
              ))}
              {segments
                .filter((segment) => segment.dayKey === dayKey)
                .map((segment) => (
                  <div
                    key={`${segment.event.eventId}:${segment.dayKey}`}
                    className="timedEvent"
                    style={{
                      top: (segment.startMinutes / 60) * HOUR_HEIGHT,
                      height: Math.max(
                        ((segment.endMinutes - segment.startMinutes) / 60) * HOUR_HEIGHT,
                        22,
                      ),
                      left: `${(segment.column / segment.columnCount) * 100}%`,
                      width: `${100 / segment.columnCount}%`,
                    }}
                  >
                    <EventCard event={segment.event} memberColors={colors} onEventSelect={onEventSelect} />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventCard({
  event,
  compact = false,
  memberColors,
  onEventSelect,
}: {
  event: NormalizedEvent;
  compact?: boolean;
  memberColors: MemberColorMap;
  onEventSelect?: (event: NormalizedEvent) => void;
}) {
  const location = getCompactEventLocation(event.location);
  return (
    <button
      aria-label={`${event.title}の予定詳細を開く`}
      className="calendarEventCard memberColoredEvent"
      onClick={() => onEventSelect?.(event)}
      style={getMemberColorStyle(event.ownerUserId, memberColors)}
      type="button"
    >
      {!compact ? (
        <time>
          {format(new Date(event.start), "HH:mm")}–{format(new Date(event.end), "HH:mm")}
        </time>
      ) : null}
      <strong>{event.title}</strong>
      <span>
        {event.ownerName}
        {location ? ` / ${location}` : ""}
      </span>
    </button>
  );
}
