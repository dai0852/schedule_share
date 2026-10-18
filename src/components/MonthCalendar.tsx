import { addDays, format, isSameDay, isSameMonth, startOfDay } from "date-fns";
import { ja } from "date-fns/locale";
import { eventsForDay, isAllDayEvent, toDayKey } from "@/domain/calendar";
import { createMemberColorMap, getMemberColorStyle, type MemberColorMap } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";
import { MonthDayButton } from "@/components/MonthDayButton";

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const MAX_VISIBLE_EVENTS = 3;

export function MonthCalendar({
  days, displayedDate, selectedDate, events, onDaySelect, onEventSelect,
  memberColors, enableDayPreview = false, onDayPreview,
  dayClickOpensDialog = false,
}: {
  days: Date[];
  displayedDate?: Date;
  selectedDate: Date;
  events: NormalizedEvent[];
  onDaySelect?: (day: Date) => void;
  onEventSelect?: (event: NormalizedEvent) => void;
  memberColors?: MemberColorMap;
  enableDayPreview?: boolean;
  onDayPreview?: (day: Date) => void;
  dayClickOpensDialog?: boolean;
}) {
  const colors = memberColors ?? createMemberColorMap(events.map((event) => event.ownerUserId));
  return (
    <div className="calendarScroller monthScroller" aria-label="月カレンダー">
      <div className="monthGrid">
        {WEEKDAYS.map((day) => <div className="monthWeekday" key={day}>{day}</div>)}
        {days.map((day) => {
          const dayEvents = eventsForDay(events, day).sort((a, b) =>
            Number(isAllDayEvent(b)) - Number(isAllDayEvent(a)) || Date.parse(a.start) - Date.parse(b.start));
          const owners = [...new Map(dayEvents.map((event) => [event.ownerUserId, event])).values()];
          const selected = isSameDay(day, selectedDate);
          const className = [
            "monthDay",
            !isSameMonth(day, displayedDate ?? selectedDate) ? "outsideMonth" : "",
            isSameDay(day, new Date()) ? "today" : "",
            selected ? "selected" : "",
          ].filter(Boolean).join(" ");
          return (
            <section className={className} key={toDayKey(day)}>
              <MonthDayButton
                label={`${format(day, "yyyy年M月d日", { locale: ja })}、予定${dayEvents.length}件`}
                selected={selected}
                today={isSameDay(day, new Date())}
                onSelect={() => onDaySelect?.(day)}
                onPreview={onDayPreview ? () => onDayPreview(day) : undefined}
                enablePreview={enableDayPreview}
                opensDialog={dayClickOpensDialog}
              >
                <time dateTime={toDayKey(day)}>{format(day, "d")}</time>
                {dayEvents.length > 0 ? (
                  <span className="monthDaySummary" aria-hidden="true">
                    <span className="monthOwnerDots">
                      {owners.slice(0, 3).map((event) => (
                        <span className="memberColorDot" style={getMemberColorStyle(event.ownerUserId, colors)} key={event.ownerUserId} />
                      ))}
                    </span>
                    <span className="monthDayCount">{dayEvents.length}件</span>
                  </span>
                ) : null}
              </MonthDayButton>
              <div className="monthDayEvents">
                {dayEvents.slice(0, MAX_VISIBLE_EVENTS).map((event) => (
                  <button
                    aria-label={`${event.title}の予定詳細を開く`}
                    className="monthEvent memberColoredEvent"
                    style={getMemberColorStyle(event.ownerUserId, colors)}
                    key={event.eventId}
                    onClick={() => onEventSelect?.(event)}
                    type="button"
                  >
                    <span>{monthEventTimeLabel(event, day)} {event.ownerName}</span>
                    <strong>{event.title}</strong>
                  </button>
                ))}
                {dayEvents.length > MAX_VISIBLE_EVENTS ? (
                  <button className="moreEvents" type="button" onClick={() => onDaySelect?.(day)}
                    aria-haspopup={dayClickOpensDialog ? "dialog" : undefined}
                    aria-label={`${format(day, "M月d日")}の予定をすべて表示`}>
                    ほか{dayEvents.length - MAX_VISIBLE_EVENTS}件
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function monthEventTimeLabel(event: NormalizedEvent, day: Date): string {
  if (isAllDayEvent(event)) return "終日";
  const start = Date.parse(event.start);
  const before = start < startOfDay(day).getTime();
  const after = Date.parse(event.end) > addDays(startOfDay(day), 1).getTime();
  return `${before ? "00:00" : format(new Date(start), "HH:mm")}${before ? " 前日から継続" : ""}${after ? " 翌日へ継続" : ""}`;
}
