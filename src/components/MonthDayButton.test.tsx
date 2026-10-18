// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonthDayButton } from "./MonthDayButton";

function pointer(target: HTMLElement, type: string, changes: { pointerType?: string; clientX?: number; clientY?: number } = {}) {
  const event = new MouseEvent(type === "pointerleave" ? "pointerout" : type, { bubbles: true, clientX: changes.clientX ?? 20, clientY: changes.clientY ?? 20 });
  Object.defineProperties(event, {
    pointerType: { value: changes.pointerType ?? "touch" },
    pointerId: { value: 1 }, isPrimary: { value: true },
  });
  fireEvent(target, event);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("月の日付の長押し", () => {
  it("500ms長押しすると一度だけ開き、離した後のclickで通常選択しない", () => {
    const onPreview = vi.fn();
    const onSelect = vi.fn();
    render(<MonthDayButton label="8月11日" selected today={false} enablePreview onPreview={onPreview} onSelect={onSelect}>11</MonthDayButton>);
    const button = screen.getByRole("button", { name: "8月11日" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    pointer(button, "pointerdown");
    act(() => vi.advanceTimersByTime(499));
    expect(onPreview).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    pointer(button, "pointerup");
    fireEvent.click(button);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    pointer(button, "pointerdown");
    pointer(button, "pointerup");
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it.each(["pointerup", "pointercancel", "pointerleave", "pointermove"])("%sで長押しを中止し、スクロールを誤検出しない", (type) => {
    const onPreview = vi.fn();
    render(<MonthDayButton label="8月11日" selected={false} today={false} enablePreview onPreview={onPreview} onSelect={vi.fn()}>11</MonthDayButton>);
    const button = screen.getByRole("button");
    pointer(button, "pointerdown");
    act(() => vi.advanceTimersByTime(200));
    pointer(button, type, { clientY: 40 });
    act(() => vi.advanceTimersByTime(500));
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("マウス長押しは無効、キーボードではShift+F10で開ける", () => {
    const onPreview = vi.fn();
    render(<MonthDayButton label="8月11日" selected={false} today={false} enablePreview onPreview={onPreview} onSelect={vi.fn()}>11</MonthDayButton>);
    const button = screen.getByRole("button");
    pointer(button, "pointerdown", { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(600));
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "F10", shiftKey: true });
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it("画面の切替やunmount後にタイマーが残らない", () => {
    const onPreview = vi.fn();
    const { unmount } = render(<MonthDayButton label="8月11日" selected={false} today={false} enablePreview onPreview={onPreview} onSelect={vi.fn()}>11</MonthDayButton>);
    pointer(screen.getByRole("button"), "pointerdown");
    unmount();
    act(() => vi.advanceTimersByTime(500));
    expect(onPreview).not.toHaveBeenCalled();
  });
});
