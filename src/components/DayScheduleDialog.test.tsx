// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemberColorMap } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";
import { DayScheduleDialog } from "./DayScheduleDialog";

const event: NormalizedEvent = {
  eventId: "google:member-1:one", source: "google", sourceEventId: "one", ownerUserId: "member-1", ownerName: "佐藤",
  calendarId: "primary", title: "顧客訪問", location: "会議室", start: "2026-08-11T09:00:00+09:00", end: "2026-08-11T10:00:00+09:00",
  isOnlineMeeting: false, visibility: "team", updatedAt: "2026-08-10T00:00:00Z",
};

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  // jsdom has the dialog element but does not implement its browser methods.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup();
  for (const [key, descriptor] of [["showModal", originalShowModal], ["close", originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
  }
});

function Harness({ onSelect = vi.fn(), layout = "agenda" }: {
  onSelect?: (event: NormalizedEvent) => void;
  layout?: "agenda" | "timeline";
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>予定を開く</button>
    {open ? <DayScheduleDialog day={new Date("2026-08-11T00:00:00+09:00")} events={[event]}
      layout={layout}
      members={[{ id: "member-1", displayName: "佐藤", department: "営業" },
        { id: "member-2", displayName: "田中", department: "営業" }]}
      memberColors={createMemberColorMap(["member-1", "member-2"])}
      onClose={() => setOpen(false)} onEventSelect={onSelect} /> : null}
  </>;
}

describe("日付の予定ポップアップ", () => {
  it("長押しから指を離したclickで担当者欄を開かず、新しいタップは受け付ける", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "予定を開く" }));
    const summary = screen.getByLabelText("佐藤の予定1件");
    const details = summary.closest("details")!;
    fireEvent.click(summary, { detail: 1 });
    expect(details).not.toHaveAttribute("open");
    fireEvent.pointerDown(summary);
    fireEvent.click(summary, { detail: 1 });
    expect(details).toHaveAttribute("open");
  });

  it("担当者ごとの一覧から詳細を確認でき、閉じると背景スクロールとフォーカスを戻す", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "予定を開く" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(dialog).getByRole("button", { name: "日付の予定を閉じる" })).toHaveFocus();
    fireEvent.click(within(dialog).getByLabelText("佐藤の予定1件"));
    fireEvent.click(within(dialog).getByRole("button", { name: /顧客訪問/ }));
    expect(onSelect).toHaveBeenCalledWith(event);
    fireEvent.click(within(dialog).getByRole("button", { name: "日付の予定を閉じる" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });

  it("Escapeのcancelと外側クリックで閉じられる", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "予定を開く" }));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "予定を開く" }));
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("timelineレイアウトは担当者全員の時間割と実時間の予定を表示する", () => {
    render(<Harness layout="timeline" />);
    fireEvent.click(screen.getByRole("button", { name: "予定を開く" }));
    const dialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(dialog).toHaveClass("desktopDayScheduleDialog");
    const timeline = within(dialog).getByRole("region", { name: "担当者別の日別スケジュール" });
    const scroller = within(timeline).getByRole("region", { name: "日別スケジュールのスクロール領域" });
    const table = within(scroller).getByRole("table", { name: "担当者別の時間割" });
    expect(within(table).getByLabelText("佐藤の時間別予定")).toBeInTheDocument();
    expect(within(table).getByLabelText("田中の時間別予定")).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: /09:00.*10:00.*顧客訪問/ })).toBeInTheDocument();
  });

  it("モバイルpopupはタブを持たず担当者ごとの予定一覧を表示する", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "予定を開く" }));
    const dialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(dialog).not.toHaveClass("desktopDayScheduleDialog");
    expect(within(dialog).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("table")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "選択日の予定" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("佐藤の予定1件")).toBeInTheDocument();
  });
});
