import { format, isSameDay, isSameMonth } from "date-fns";
import { eventsForDay, isAllDayEvent, toDayKey } from "@/domain/calendar";
import { CALENDAR_SOURCE_LABELS, type NormalizedEvent } from "@/domain/schedule";

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const MAX_VISIBLE_EVENTS = 3;

export function MonthCalendar({
  days,
  selectedDate,
  events,
  onEventSelect,
}: {
  days: Date[];
  selectedDate: Date;
  events: NormalizedEvent[];
  onEventSelect?: (event: NormalizedEvent) => void;
}) {
  return (
    <div className="calendarScroller monthScroller">
      <div className="monthGrid">
        {WEEKDAYS.map((day) => (
          <div className="monthWeekday" key={day}>
            {day}
          </div>
        ))}
        {days.map((day) => {
          const dayEvents = eventsForDay(events, day);
          const className = [
            "monthDay",
            !isSameMonth(day, selectedDate) ? "outsideMonth" : "",
            isSameDay(day, new Date()) ? "today" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <section className={className} key={toDayKey(day)}>
              <time>{format(day, "d")}</time>
              {dayEvents.slice(0, MAX_VISIBLE_EVENTS).map((event) => (
                <button
                  aria-label={`${event.title}の予定詳細を開く`}
                  className={`monthEvent ${event.source}`}
                  key={event.eventId}
                  onClick={() => onEventSelect?.(event)}
                  type="button"
                >
                  <span
                    className="eventSourceLabel"
                    aria-label={`予定元: ${CALENDAR_SOURCE_LABELS[event.source]}`}
                  >
                    {CALENDAR_SOURCE_LABELS[event.source]}
                  </span>{" "}
                  {!isAllDayEvent(event) ? <span>{format(new Date(event.start), "HH:mm")}</span> : null}{" "}
                  {event.title}
                </button>
              ))}
              {dayEvents.length > MAX_VISIBLE_EVENTS ? (
                <span className="moreEvents">ほか{dayEvents.length - MAX_VISIBLE_EVENTS}件</span>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
