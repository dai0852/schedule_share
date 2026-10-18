import { addDays, format, startOfDay } from "date-fns";
import { ja } from "date-fns/locale";

import { eventsForDay, isAllDayEvent } from "@/domain/calendar";
import { getMemberColorStyle } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";

export function DayAgenda({
  day,
  events,
  onEventSelect,
}: {
  day: Date;
  events: NormalizedEvent[];
  onEventSelect?: (event: NormalizedEvent) => void;
}) {
  const dayEvents = eventsForDay(events, day).sort((a, b) => {
    const allDayOrder = Number(isAllDayEvent(b)) - Number(isAllDayEvent(a));
    return allDayOrder || Date.parse(a.start) - Date.parse(b.start);
  });

  return (
    <section aria-label="選択日の予定" className="dayAgenda">
      <div className="dayAgendaHeader">
        <h2>{format(day, "M月d日（E）の予定", { locale: ja })}</h2>
        <span>{dayEvents.length}件</span>
      </div>
      {dayEvents.length === 0 ? (
        <p className="dayAgendaEmpty">この日の予定はありません。</p>
      ) : (
        <ul className="dayAgendaList">
          {dayEvents.map((event) => {
            const { time, continuation } = getEventTimeForDay(event, day);
            return (
              <li key={event.eventId}>
                <button
                  className="dayAgendaEvent memberColoredEvent"
                  onClick={() => onEventSelect?.(event)}
                  style={getMemberColorStyle(event.ownerUserId)}
                  type="button"
                >
                  <span className="dayAgendaTime">{time}</span>
                  <span className="dayAgendaContent">
                    <span className="dayAgendaOwner">{event.ownerName}</span>
                    <strong>{event.title}</strong>
                    {event.location ? (
                      <span className="dayAgendaLocation">{event.location}</span>
                    ) : null}
                    {continuation ? (
                      <span className="dayAgendaContinuation">{continuation}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function getEventTimeForDay(event: NormalizedEvent, day: Date): {
  time: string;
  continuation: string;
} {
  if (isAllDayEvent(event)) {
    const start = new Date(`${event.start}T00:00:00`);
    const lastDay = addDays(new Date(`${event.end}T00:00:00`), -1);
    const range = start.getTime() < lastDay.getTime()
      ? ` · ${format(start, "M月d日")}〜${format(lastDay, "M月d日")}`
      : "";
    return { time: `終日${range}`, continuation: "" };
  }

  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();
  const startLabel = start < dayStart ? "00:00" : format(start, "HH:mm");
  const endLabel = end >= dayEnd ? "24:00" : format(end, "HH:mm");
  const continuation = [
    start < dayStart ? "前日から継続" : "",
    end > dayEnd ? "翌日へ継続" : "",
  ].filter(Boolean).join("・");

  return { time: `${startLabel}–${endLabel}`, continuation };
}
