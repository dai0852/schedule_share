import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { DayAgenda } from "@/components/DayAgenda";
import type { PublicSalesMember } from "@/domain/member";
import type { MemberColorMap } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";

export function DayScheduleDialog({ day, events, members, memberColors, onClose, onEventSelect }: {
  day: Date;
  events: NormalizedEvent[];
  members: PublicSalesMember[];
  memberColors: MemberColorMap;
  onClose: () => void;
  onEventSelect: (event: NormalizedEvent) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pressedInDialog = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      aria-label="日付の予定"
      className="dayScheduleDialog"
      ref={dialogRef}
      onPointerDownCapture={() => { pressedInDialog.current = true; }}
      onClickCapture={(event) => {
        // A long press began on the calendar. Its release must not activate the
        // summary/card that appears underneath the finger in the new dialog.
        if (!pressedInDialog.current && event.detail > 0) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="daySchedulePanel">
        <div className="dayScheduleDialogHeader">
          <strong>予定の確認</strong>
          <button aria-label="日付の予定を閉じる" className="eventDetailsCloseButton" onClick={onClose} ref={closeRef} type="button">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="dayScheduleDialogBody">
          <DayAgenda day={day} events={events} members={members} memberColors={memberColors} onEventSelect={onEventSelect} />
        </div>
      </div>
    </dialog>
  );
}
