"use client";

import { format, isSameDay } from "date-fns";
import { ja } from "date-fns/locale";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { isAllDayEvent } from "@/domain/calendar";
import { CALENDAR_SOURCE_LABELS, type NormalizedEvent } from "@/domain/schedule";

export function EventDetailsDialog({
  event,
  onClose,
}: {
  event: NormalizedEvent | null;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (event) closeButtonRef.current?.focus();
  }, [event]);

  if (!event) return null;

  return (
    <div
      className="eventDetailsBackdrop"
      onClick={(clickEvent) => {
        if (clickEvent.target === clickEvent.currentTarget) onClose();
      }}
    >
      <section
        aria-label="予定の詳細"
        aria-modal="true"
        className={`eventDetailsDialog ${event.source}`}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Escape") onClose();
        }}
        role="dialog"
      >
        <div className="eventDetailsHeader">
          <p className="eyebrow">予定の詳細</p>
          <button
            aria-label="予定詳細を閉じる"
            className="eventDetailsCloseButton"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <h2 id="event-details-title">{event.title}</h2>
        <dl className="eventDetailsList">
          <div>
            <dt>日時</dt>
            <dd>{eventDateTimeLabel(event)}</dd>
          </div>
          <div>
            <dt>担当者</dt>
            <dd>{event.ownerName}</dd>
          </div>
          <div>
            <dt>予定元</dt>
            <dd>{CALENDAR_SOURCE_LABELS[event.source]}</dd>
          </div>
          {event.location ? (
            <div>
              <dt>場所</dt>
              <dd>{event.location}</dd>
            </div>
          ) : null}
        </dl>
      </section>
    </div>
  );
}

function eventDateTimeLabel(event: NormalizedEvent): string {
  const start = new Date(event.start);
  if (isAllDayEvent(event)) return `${format(start, "yyyy年M月d日", { locale: ja })} 終日`;

  const end = new Date(event.end);
  if (isSameDay(start, end)) {
    return `${format(start, "yyyy年M月d日 HH:mm", { locale: ja })}〜${format(end, "HH:mm", { locale: ja })}`;
  }
  return `${format(start, "yyyy年M月d日 HH:mm", { locale: ja })}〜${format(end, "yyyy年M月d日 HH:mm", { locale: ja })}`;
}
