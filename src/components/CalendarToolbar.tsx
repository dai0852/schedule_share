import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import type { ViewMode } from "@/domain/calendar";

interface CalendarToolbarProps {
  title: string;
  mode: ViewMode;
  eventCount: number;
  onToday: () => void;
  onMove: (amount: -1 | 1) => void;
  onModeChange: (mode: ViewMode) => void;
}

const MODE_LABELS: Record<ViewMode, string> = {
  members: "担当",
  day: "日",
  week: "週",
  month: "月",
};

export function CalendarToolbar({
  title,
  mode,
  eventCount,
  onToday,
  onMove,
  onModeChange,
}: CalendarToolbarProps) {
  return (
    <div className="calendarToolbar">
      <div className="calendarNavigation">
        <button className="secondaryButton compactButton" onClick={onToday}>
          今日
        </button>
        <button className="iconButton" aria-label="前の期間" onClick={() => onMove(-1)}>
          <ChevronLeft aria-hidden="true" size={18} />
        </button>
        <button className="iconButton" aria-label="次の期間" onClick={() => onMove(1)}>
          <ChevronRight aria-hidden="true" size={18} />
        </button>
        <h2>{title}</h2>
      </div>

      <div className="calendarToolbarActions">
        <div className="controlGroup calendarMode" aria-label="表示切替">
          {(["members", "day", "week", "month"] as const).map((viewMode) => (
            <button
              key={viewMode}
              className={mode === viewMode ? "active" : ""}
              aria-pressed={mode === viewMode}
              onClick={() => onModeChange(viewMode)}
            >
              {MODE_LABELS[viewMode]}
            </button>
          ))}
        </div>
        <div className="countBadge">
          <Calendar aria-hidden="true" size={16} />
          {eventCount}件
        </div>
      </div>
    </div>
  );
}
