import { addDays, format, startOfDay } from "date-fns";
import { ja } from "date-fns/locale";
import { ChevronDown } from "lucide-react";

import { eventsForDay, isAllDayEvent } from "@/domain/calendar";
import { getCompactEventLocation } from "@/domain/eventPresentation";
import type { PublicSalesMember } from "@/domain/member";
import {
  createMemberColorMap,
  getMemberColorStyle,
  type MemberColorMap,
} from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";

export function DayAgenda({
  day,
  events,
  memberColors,
  members,
  onEventSelect,
}: {
  day: Date;
  events: NormalizedEvent[];
  memberColors?: MemberColorMap;
  members?: PublicSalesMember[];
  onEventSelect?: (event: NormalizedEvent) => void;
}) {
  const colors = memberColors ?? createMemberColorMap(events.map((event) => event.ownerUserId));
  const dayEvents = eventsForDay(events, day).sort((a, b) => {
    const allDayOrder = Number(isAllDayEvent(b)) - Number(isAllDayEvent(a));
    return allDayOrder || Date.parse(a.start) - Date.parse(b.start);
  });
  const memberOrder = new Map<string, number>(members?.map((member, index) => [member.id, index]));
  const eventsByOwner = new Map<string, NormalizedEvent[]>();
  for (const event of dayEvents) {
    const ownerEvents = eventsByOwner.get(event.ownerUserId) ?? [];
    ownerEvents.push(event);
    eventsByOwner.set(event.ownerUserId, ownerEvents);
  }
  const ownerGroups = [...eventsByOwner].sort(([firstId, firstEvents], [secondId, secondEvents]) => {
    const firstOrder = memberOrder.get(firstId) ?? Number.POSITIVE_INFINITY;
    const secondOrder = memberOrder.get(secondId) ?? Number.POSITIVE_INFINITY;
    return (firstOrder === secondOrder ? 0 : firstOrder - secondOrder)
      || firstEvents[0].ownerName.localeCompare(secondEvents[0].ownerName, "ja")
      || firstId.localeCompare(secondId);
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
        <div className="dayAgendaMembers">
          {ownerGroups.map(([ownerUserId, ownerEvents]) => {
            const ownerStyle = getMemberColorStyle(ownerUserId, colors);
            return (
              <details className="dayAgendaMember" key={ownerUserId}>
                <summary className="dayAgendaMemberSummary" style={ownerStyle}
                  aria-label={`${ownerEvents[0].ownerName}の予定${ownerEvents.length}件`}>
                  <span aria-hidden="true" className="dayAgendaMemberDot" />
                  <span className="dayAgendaOwner">{ownerEvents[0].ownerName}</span>
                  <span className="dayAgendaMemberCount">{ownerEvents.length}件</span>
                  <ChevronDown aria-hidden="true" className="dayAgendaMemberChevron" size={18} />
                </summary>
                <ul className="dayAgendaList">
                  {ownerEvents.map((event) => {
                    const { time, continuation } = getEventTimeForDay(event, day);
                    const location = getCompactEventLocation(event.location);
                    return (
                      <li key={event.eventId}>
                        <button
                          className="dayAgendaEvent memberColoredEvent"
                          onClick={() => onEventSelect?.(event)}
                          style={ownerStyle}
                          type="button"
                        >
                          <span className="dayAgendaTime">{time}</span>
                          <span className="dayAgendaContent">
                            <span className="dayAgendaOwner">{event.ownerName}</span>
                            <strong>{event.title}</strong>
                            {location ? (
                              <span className="dayAgendaLocation">{location}</span>
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
              </details>
            );
          })}
        </div>
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
