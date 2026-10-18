// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "@/domain/schedule";
import { DayAgenda } from "./DayAgenda";

const day = new Date("2026-08-11T00:00:00+09:00");

function event(
  id: string,
  changes: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    eventId: `google:member-1:${id}`,
    source: "google",
    sourceEventId: id,
    ownerUserId: "member-1",
    ownerName: "佐藤",
    calendarId: "primary",
    title: id,
    location: "会議室A",
    start: "2026-08-11T09:00:00+09:00",
    end: "2026-08-11T10:00:00+09:00",
    isOnlineMeeting: false,
    visibility: "team",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...changes,
  };
}

afterEach(cleanup);

describe("DayAgenda", () => {
  it("終日を先頭にし、時刻順で重複・同時刻の全予定を並べる", () => {
    const late = event("遅い予定", {
      start: "2026-08-11T13:00:00+09:00",
      end: "2026-08-11T14:00:00+09:00",
    });
    const first = event("早い予定");
    const overlap = event("重複予定", {
      start: "2026-08-11T09:00:00+09:00",
      end: "2026-08-11T11:00:00+09:00",
    });
    const allDay = event("終日予定", { start: "2026-08-11", end: "2026-08-12" });

    render(<DayAgenda day={day} events={[late, first, overlap, allDay]} />);

    const agenda = screen.getByRole("region", { name: "選択日の予定" });
    expect(within(agenda).getByRole("heading", { name: "8月11日（火）の予定" })).toBeVisible();
    expect(agenda).toHaveTextContent("4件");
    expect(within(agenda).getAllByRole("button").map((button) => button.textContent))
      .toEqual([
        "終日佐藤終日予定会議室A",
        "09:00–10:00佐藤早い予定会議室A",
        "09:00–11:00佐藤重複予定会議室A",
        "13:00–14:00佐藤遅い予定会議室A",
      ]);
  });

  it("予定元が異なっても同一担当者の色を揃え、予定元ラベルを表示しない", () => {
    const google = event("Google側");
    const microsoft = event("Microsoft側", {
      eventId: "microsoft:member-1:other",
      sourceEventId: "other",
      source: "microsoft",
      calendarId: "outlook",
      location: "",
    });
    const teams = event("旧Teams側", {
      eventId: "teams:member-1:legacy",
      sourceEventId: "legacy",
      source: "teams",
      calendarId: "outlook",
    });

    render(<DayAgenda day={day} events={[google, microsoft, teams]} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.getAttribute("style")))
      .toEqual([buttons[0].getAttribute("style"), buttons[0].getAttribute("style"), buttons[0].getAttribute("style")]);
    for (const button of buttons) {
      expect(button).toHaveClass("dayAgendaEvent", "memberColoredEvent");
      expect(button).toHaveTextContent("佐藤");
    }
    expect(screen.queryByText(/^(Google|Microsoft|Teams)$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/予定元/)).not.toBeInTheDocument();
  });

  it("日またぎを選択日の時間に切り出し、継続方向と終日の排他的終了を示す", () => {
    const crossDay = event("夜間対応", {
      start: "2026-08-10T23:00:00+09:00",
      end: "2026-08-12T01:00:00+09:00",
    });
    const untilMidnight = event("深夜終了", {
      start: "2026-08-11T22:00:00+09:00",
      end: "2026-08-12T00:00:00+09:00",
    });
    const allDay = event("出張", {
      start: "2026-08-10",
      end: "2026-08-12",
    });
    const endingToday = event("前日まで", {
      start: "2026-08-09",
      end: "2026-08-11",
    });

    const { rerender } = render(
      <DayAgenda day={day} events={[crossDay, untilMidnight, allDay, endingToday]} />,
    );

    expect(screen.getByRole("button", { name: /出張/ }))
      .toHaveTextContent("終日 · 8月10日〜8月11日");
    expect(screen.getByRole("button", { name: /夜間対応/ }))
      .toHaveTextContent("00:00–24:00佐藤夜間対応会議室A前日から継続・翌日へ継続");
    expect(screen.getByRole("button", { name: /深夜終了/ }))
      .toHaveTextContent("22:00–24:00佐藤深夜終了会議室A");
    expect(screen.getByRole("button", { name: /深夜終了/ }))
      .not.toHaveTextContent("翌日へ継続");
    expect(screen.queryByRole("button", { name: /前日まで/ })).not.toBeInTheDocument();

    rerender(<DayAgenda day={new Date("2026-08-12T00:00:00+09:00")} events={[crossDay, allDay]} />);
    expect(screen.getByRole("button", { name: /夜間対応/ }))
      .toHaveTextContent("00:00–01:00佐藤夜間対応会議室A前日から継続");
    expect(screen.queryByRole("button", { name: /出張/ })).not.toBeInTheDocument();
  });

  it("空状態を示し、カードのクリックで元の予定を渡す", () => {
    const selected = event("訪問");
    const onEventSelect = vi.fn();
    const { rerender } = render(<DayAgenda day={day} events={[]} onEventSelect={onEventSelect} />);

    expect(screen.getByText("この日の予定はありません。")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(<DayAgenda day={day} events={[selected]} onEventSelect={onEventSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /訪問/ }));
    expect(onEventSelect).toHaveBeenCalledTimes(1);
    expect(onEventSelect).toHaveBeenCalledWith(selected);
  });
});
