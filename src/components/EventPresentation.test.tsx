// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemberColorMap } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";
import { DayAgenda } from "./DayAgenda";
import { EventDetailsDialog } from "./EventDetailsDialog";
import { MemberDayTimeline } from "./MemberDayTimeline";
import { MemberScheduleGrid } from "./MemberScheduleGrid";
import { TimeGridCalendar } from "./TimeGridCalendar";

const day = new Date("2026-08-11T00:00:00+09:00");
const members = [{ id: "member-1", displayName: "佐藤", department: "営業" }];
const memberColors = createMemberColorMap(["member-1"]);

function event(id: string, location: string): NormalizedEvent {
  return {
    eventId: `microsoft:member-1:${id}`,
    source: "microsoft",
    sourceEventId: id,
    ownerUserId: "member-1",
    ownerName: "佐藤",
    calendarId: "outlook",
    title: `${id}の打合せ`,
    location,
    start: "2026-08-11T09:00:00+09:00",
    end: "2026-08-11T10:00:00+09:00",
    isOnlineMeeting: false,
    visibility: "team",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("通常予定カードの簡素な表示", () => {
  const placeholder = event("サービス名", "Microsoft Teams 会議");
  const realPlace = event("実場所", "Microsoft東京本社");

  it("担当者別の選択日一覧では場所のplaceholderだけを隠し、元イベントを詳細へ渡す", () => {
    const onEventSelect = vi.fn();
    render(<DayAgenda day={day} events={[placeholder, realPlace]} onEventSelect={onEventSelect} />);
    fireEvent.click(screen.getByText("佐藤", { selector: ".dayAgendaMemberSummary .dayAgendaOwner" }).closest("summary")!);

    expect(screen.queryByText("Microsoft Teams 会議")).not.toBeInTheDocument();
    expect(screen.getByText("Microsoft東京本社")).toBeVisible();
    const card = screen.getByRole("button", { name: /サービス名の打合せ/ });
    expect(card).toHaveTextContent("サービス名の打合せ");
    fireEvent.click(card);
    expect(onEventSelect).toHaveBeenCalledWith(placeholder);
  });

  it("PC日別時間割では通常カードとtooltipからplaceholderを除き、実場所と元イベントを保つ", () => {
    const onEventSelect = vi.fn();
    render(<MemberDayTimeline day={day} events={[placeholder, realPlace]} members={members}
      memberColors={memberColors} onEventSelect={onEventSelect} />);

    expect(screen.queryByText("Microsoft Teams 会議")).not.toBeInTheDocument();
    expect(screen.getByText("Microsoft東京本社")).toBeVisible();
    const placeholderCard = screen.getByRole("button", { name: /サービス名の打合せ/ });
    const realCard = screen.getByRole("button", { name: /実場所の打合せ/ });
    expect(placeholderCard).toHaveAttribute("title", expect.not.stringContaining("Microsoft Teams 会議"));
    expect(realCard.getAttribute("title")).toContain("Microsoft東京本社");
    fireEvent.click(placeholderCard);
    expect(onEventSelect).toHaveBeenCalledWith(placeholder);
  });

  it("週の担当者表ではplaceholderを隠し、実場所と件名を表示して元イベントを渡す", () => {
    const onEventSelect = vi.fn();
    render(<MemberScheduleGrid days={[day]} events={[placeholder, realPlace]}
      members={members} memberColors={memberColors} onEventSelect={onEventSelect} />);

    expect(screen.queryByText("Microsoft Teams 会議")).not.toBeInTheDocument();
    expect(screen.getByText("Microsoft東京本社")).toBeVisible();
    const card = screen.getByRole("button", { name: /サービス名の打合せ/ });
    expect(card).toHaveTextContent("サービス名の打合せ");
    fireEvent.click(card);
    expect(onEventSelect).toHaveBeenCalledWith(placeholder);
  });

  it("旧time gridでもproviderラベルと場所placeholderを隠し、担当者色と元イベントを保つ", () => {
    const onEventSelect = vi.fn();
    render(<TimeGridCalendar days={[day]} events={[placeholder, realPlace]}
      memberColors={memberColors} onEventSelect={onEventSelect} />);

    expect(screen.queryByLabelText(/予定元:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Microsoft Teams 会議")).not.toBeInTheDocument();
    expect(screen.getByText(/Microsoft東京本社/)).toBeVisible();
    const card = screen.getByRole("button", { name: /サービス名の打合せ/ });
    expect(card).toHaveClass("memberColoredEvent");
    expect(card.style.getPropertyValue("--member-color")).not.toBe("");
    expect(card.style.getPropertyValue("--member-color"))
      .toBe(screen.getByRole("button", { name: /実場所の打合せ/ }).style.getPropertyValue("--member-color"));
    fireEvent.click(card);
    expect(onEventSelect).toHaveBeenCalledWith(placeholder);
  });

  it("詳細では元の予定元と場所をそのまま表示する", () => {
    render(<EventDetailsDialog event={placeholder} onClose={vi.fn()} memberColors={memberColors} />);
    const dialog = screen.getByRole("dialog", { name: "予定の詳細" });
    expect(within(dialog).getByText("Microsoft", { exact: true })).toBeVisible();
    expect(within(dialog).getByText("Microsoft Teams 会議")).toBeVisible();
  });
});
