import { useCallback, useEffect, useRef, type ReactNode } from "react";

export function MonthDayButton({
  label, selected, today, children, onSelect, onPreview, enablePreview = false,
}: {
  label: string;
  selected: boolean;
  today: boolean;
  children: ReactNode;
  onSelect: () => void;
  onPreview?: () => void;
  enablePreview?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const previewed = useRef(false);
  const cancelPress = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress, enablePreview, onPreview]);

  return (
    <button
      className="monthDaySelect"
      aria-label={label}
      aria-pressed={selected}
      aria-current={today ? "date" : undefined}
      aria-haspopup={enablePreview ? "dialog" : undefined}
      onPointerDown={(event) => {
        cancelPress();
        previewed.current = false;
        if (!enablePreview || !onPreview || event.isPrimary === false
          || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
        origin.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        timer.current = setTimeout(() => {
          timer.current = null;
          previewed.current = true;
          onPreview();
        }, 500);
      }}
      onPointerMove={(event) => {
        const start = origin.current;
        if (start && (event.pointerId !== start.pointerId
          || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(event) => { if (enablePreview) event.preventDefault(); }}
      onKeyDown={(event) => {
        if (enablePreview && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
          event.preventDefault();
          onPreview?.();
        }
      }}
      onClick={(event) => {
        if (previewed.current) {
          previewed.current = false;
          event.preventDefault();
          return;
        }
        onSelect();
      }}
      type="button"
    >
      {children}
    </button>
  );
}
