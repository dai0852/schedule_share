import { format, isSameDay } from "date-fns";
import { ja } from "date-fns/locale";
import type { CSSProperties } from "react";
import {
  eventsForDay,
  isAllDayEvent,
  layoutTimedEvents,
  toDayKey,
} from "@/domain/calendar";
import { CALENDAR_SOURCE_LABELS, type NormalizedEvent } from "@/domain/schedule";

const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function TimeGridCalendar({
  days,
  events,
}: {
  days: Date[];
  events: NormalizedEvent[];
}) {
  const segments = layoutTimedEvents(events, days);
  const allDayEvents = events.filter(isAllDayEvent);
  const gridStyle = { "--calendar-columns": days.length } as CSSProperties;

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
              <EventCard key={event.eventId} event={event} compact />
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
                    <EventCard event={segment.event} />
                  </div>
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
    <article
      className={`calendarEventCard ${event.source}`}
      title={`${event.title} / ${event.ownerName}`}
    >
      <span className="eventSourceLabel" aria-label={`予定元: ${CALENDAR_SOURCE_LABELS[event.source]}`}>
        {CALENDAR_SOURCE_LABELS[event.source]}
      </span>
      {!compact ? (
        <time>
          {format(new Date(event.start), "HH:mm")}–{format(new Date(event.end), "HH:mm")}
        </time>
      ) : null}
      <strong>{event.title}</strong>
      <span>
        {event.ownerName}
        {event.location ? ` / ${event.location}` : ""}
      </span>
    </article>
  );
}
