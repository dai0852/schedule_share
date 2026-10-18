// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublicSalesMember } from "@/domain/member";
import type { NormalizedEvent } from "@/domain/schedule";
import { DayAgenda } from "./DayAgenda";

const day = new Date("2026-08-11T00:00:00+09:00");

function event(id: string, changes: Partial<NormalizedEvent> = {}): NormalizedEvent {
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

function openMember(name: string): HTMLDetailsElement {
  const summary = screen.getByText(name, { selector: ".dayAgendaMemberSummary .dayAgendaOwner" });
  const details = summary.closest("details") as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary.closest("summary")!);
  expect(details).toHaveAttribute("open");
  return details;
}

afterEach(cleanup);

describe("DayAgenda", () => {
  it("担当者は初期閉じで、開くと終日を先頭に重複・同時刻の全件を時刻順に表示する", () => {
    const late = event("遅い予定", { start: "2026-08-11T13:00:00+09:00", end: "2026-08-11T14:00:00+09:00" });
    const first = event("早い予定");
    const overlap = event("重複予定", { start: "2026-08-11T09:00:00+09:00", end: "2026-08-11T11:00:00+09:00" });
    const allDay = event("終日予定", { start: "2026-08-11", end: "2026-08-12" });

    render(<DayAgenda day={day} events={[late, first, overlap, allDay]} />);

    const agenda = screen.getByRole("region", { name: "選択日の予定" });
    expect(within(agenda).getByRole("heading", { name: "8月11日（火）の予定" })).toBeVisible();
    expect(agenda.querySelector(".dayAgendaHeader")).toHaveTextContent("4件");
    const details = agenda.querySelector("details") as HTMLDetailsElement;
    expect(details).not.toHaveAttribute("open");
    expect(agenda.querySelectorAll("details")).toHaveLength(1);
    expect(details.querySelector("summary")).toHaveTextContent("佐藤4件");
    openMember("佐藤");
    expect(within(details).getAllByRole("button").map((button) => button.textContent))
      .toEqual([
        "終日佐藤終日予定会議室A",
        "09:00–10:00佐藤早い予定会議室A",
        "09:00–11:00佐藤重複予定会議室A",
        "13:00–14:00佐藤遅い予定会議室A",
      ]);
    fireEvent.click(details.querySelector("summary")!);
    expect(details).not.toHaveAttribute("open");
  });

  it("members順で担当者を並べ、一覧外は名前順に追加し、同名の別IDも分ける", () => {
    const members: PublicSalesMember[] = [
      { id: "member-2", displayName: "田中", department: "営業" },
      { id: "member-1", displayName: "佐藤", department: "営業" },
    ];
    const events = [
      event("佐藤の朝"),
      event("田中の午後", { eventId: "microsoft:member-2:a", ownerUserId: "member-2", ownerName: "田中", source: "microsoft", start: "2026-08-11T13:00:00+09:00" }),
      event("鈴木の予定", { eventId: "google:member-3:a", ownerUserId: "member-3", ownerName: "鈴木" }),
      event("阿部の予定", { eventId: "google:member-4:a", ownerUserId: "member-4", ownerName: "阿部" }),
      event("別の佐藤", { eventId: "google:member-5:a", ownerUserId: "member-5", ownerName: "佐藤" }),
    ];

    const { container } = render(<DayAgenda day={day} events={events} members={members} />);
    expect([...container.querySelectorAll(".dayAgendaMemberSummary .dayAgendaOwner")].map((node) => node.textContent))
      .toEqual(["田中", "佐藤", "阿部", "佐藤", "鈴木"]);
    expect([...container.querySelectorAll(".dayAgendaMemberSummary")].map((node) => node.textContent))
      .toEqual(["田中1件", "佐藤1件", "阿部1件", "佐藤1件", "鈴木1件"]);
    const summaryColors = [...container.querySelectorAll<HTMLElement>(".dayAgendaMemberSummary")]
      .map((summary) => summary.style.getPropertyValue("--member-color"));
    expect(new Set(summaryColors).size).toBe(5);
    for (const details of container.querySelectorAll("details")) {
      expect(details).not.toHaveAttribute("open");
      expect(details.querySelectorAll(".dayAgendaEvent")).toHaveLength(1);
    }
  });

  it("Google・Microsoft・teamsを同一担当にまとめ、summaryとカードに共通の担当者色を使う", () => {
    const google = event("Google側");
    const microsoft = event("Microsoft側", { eventId: "microsoft:member-1:other", sourceEventId: "other", source: "microsoft", calendarId: "outlook", location: "" });
    const teams = event("旧Teams側", { eventId: "teams:member-1:legacy", sourceEventId: "legacy", source: "teams", calendarId: "outlook" });
    const memberColors = {
      "member-1": { "--member-color": "#123456", "--member-bg": "#abcdef", "--member-text": "#111111" },
    } as ComponentProps<typeof DayAgenda>["memberColors"];

    const { container } = render(<DayAgenda day={day} events={[google, microsoft, teams]} memberColors={memberColors} />);
    expect(container.querySelectorAll("details")).toHaveLength(1);
    const details = openMember("佐藤");
    const summary = details.querySelector("summary") as HTMLElement;
    const buttons = within(details).getAllByRole("button");
    expect(summary).toHaveStyle("--member-color: #123456");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button).toHaveClass("dayAgendaEvent", "memberColoredEvent");
      expect(button).toHaveStyle("--member-color: #123456");
    }
    expect(screen.queryByText(/^(Google|Microsoft|Teams)$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/予定元/)).not.toBeInTheDocument();
  });

  it("日またぎを当日の時間に切り出し、継続方向と終日の排他的終了を示す", () => {
    const crossDay = event("夜間対応", { start: "2026-08-10T23:00:00+09:00", end: "2026-08-12T01:00:00+09:00" });
    const untilMidnight = event("深夜終了", { start: "2026-08-11T22:00:00+09:00", end: "2026-08-12T00:00:00+09:00" });
    const allDay = event("出張", { start: "2026-08-10", end: "2026-08-12" });
    const endingToday = event("前日まで", { start: "2026-08-09", end: "2026-08-11" });

    const { rerender } = render(<DayAgenda day={day} events={[crossDay, untilMidnight, allDay, endingToday]} />);
    openMember("佐藤");
    expect(screen.getByRole("button", { name: /出張/ })).toHaveTextContent("終日 · 8月10日〜8月11日");
    expect(screen.getByRole("button", { name: /夜間対応/ }))
      .toHaveTextContent("00:00–24:00佐藤夜間対応会議室A前日から継続・翌日へ継続");
    expect(screen.getByRole("button", { name: /深夜終了/ }))
      .toHaveTextContent("22:00–24:00佐藤深夜終了会議室A");
    expect(screen.getByRole("button", { name: /深夜終了/ })).not.toHaveTextContent("翌日へ継続");
    expect(screen.queryByRole("button", { name: /前日まで/ })).not.toBeInTheDocument();

    rerender(<DayAgenda day={new Date("2026-08-12T00:00:00+09:00")} events={[crossDay, allDay]} />);
    openMember("佐藤");
    expect(screen.getByRole("button", { name: /夜間対応/ }))
      .toHaveTextContent("00:00–01:00佐藤夜間対応会議室A前日から継続");
    expect(screen.queryByRole("button", { name: /出張/ })).not.toBeInTheDocument();
  });

  it("空状態を示し、開いた予定カードから元の予定を渡す", () => {
    const selected = event("訪問");
    const onEventSelect = vi.fn();
    const { rerender } = render(<DayAgenda day={day} events={[]} onEventSelect={onEventSelect} />);
    expect(screen.getByText("この日の予定はありません。")).toBeVisible();
    expect(document.querySelector("details")).toBeNull();

    rerender(<DayAgenda day={day} events={[selected]} onEventSelect={onEventSelect} />);
    openMember("佐藤");
    fireEvent.click(screen.getByRole("button", { name: /訪問/ }));
    expect(onEventSelect).toHaveBeenCalledTimes(1);
    expect(onEventSelect).toHaveBeenCalledWith(selected);
  });
});
