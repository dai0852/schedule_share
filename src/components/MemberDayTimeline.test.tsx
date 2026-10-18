// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublicSalesMember } from "@/domain/member";
import { createMemberColorMap } from "@/domain/memberColor";
import type { NormalizedEvent } from "@/domain/schedule";
import { MemberDayTimeline } from "./MemberDayTimeline";

const day = new Date("2026-08-11T00:00:00+09:00");
const members: PublicSalesMember[] = [
  { id: "member-2", displayName: "田中", department: "営業二課" },
  { id: "member-1", displayName: "佐藤", department: "営業一課" },
];
const memberColors = createMemberColorMap(["member-1", "member-2", "member-3"]);

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

afterEach(cleanup);

describe("MemberDayTimeline", () => {
  it("担当者列を指定順に並べ、予定のない担当者も残し、一覧外を名前順に追加する", () => {
    const extra = event("鈴木予定", { eventId: "google:member-3:a", ownerUserId: "member-3", ownerName: "鈴木" });
    const { container } = render(
      <MemberDayTimeline day={day} events={[extra, event("佐藤予定")]} members={members} memberColors={memberColors} />,
    );

    expect(screen.getByRole("region", { name: "担当者別の日別スケジュール" }))
      .toHaveTextContent("8月11日（火）のスケジュール2件");
    expect([...container.querySelectorAll(".memberDayHeader strong")].map((node) => node.textContent))
      .toEqual(["田中", "佐藤", "鈴木"]);
    expect([...container.querySelectorAll(".memberDayHeader small")].map((node) => node.textContent))
      .toEqual(["0件", "1件", "1件"]);
    expect(container.querySelectorAll(".memberDayColumn")).toHaveLength(3);
    expect(container.querySelector(".memberDayColumn")?.querySelector("button")).toBeNull();
    expect(screen.getByRole("table", { name: "担当者別の時間割" }))
      .toHaveStyle("--timeline-columns: 3; --timeline-height: 1920px; --timeline-hour-height: 80px");
  });

  it("担当者ごとに重複レーンを独立計算し、異なる予定元も全件保持する", () => {
    const google = event("午前相談");
    const microsoft = event("別予定", { eventId: "microsoft:member-1:b", source: "microsoft", start: "2026-08-11T09:30:00+09:00", end: "2026-08-11T10:30:00+09:00" });
    const teams = event("田中予定", { eventId: "teams:member-2:c", source: "teams", ownerUserId: "member-2", ownerName: "田中" });
    const { container } = render(
      <MemberDayTimeline day={day} events={[microsoft, google, teams]} members={members} memberColors={memberColors} />,
    );

    const columns = container.querySelectorAll(".memberDayColumn");
    const tanakaSlot = columns[0].querySelector(".memberDayEventSlot") as HTMLElement;
    const satoSlots = columns[1].querySelectorAll<HTMLElement>(".memberDayEventSlot");
    expect(tanakaSlot).toHaveStyle("left: 0%; width: 100%");
    expect(satoSlots).toHaveLength(2);
    expect(satoSlots[0]).toHaveStyle("left: 0%; width: 50%");
    expect(satoSlots[1]).toHaveStyle("left: 50%; width: 50%");
    expect(within(columns[1] as HTMLElement).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByText(/^(Google|Microsoft|Teams)$/)).not.toBeInTheDocument();
  });

  it("短い連続予定も32px以上の別レーンで時刻と件名を読め、元の予定を詳細へ渡す", () => {
    const first = event("短いA", { start: "2026-08-11T09:00:00+09:00", end: "2026-08-11T09:01:00+09:00" });
    const second = event("短いB", { eventId: "microsoft:member-1:b", source: "microsoft", start: "2026-08-11T09:01:00+09:00", end: "2026-08-11T09:02:00+09:00" });
    const onEventSelect = vi.fn();
    const { container } = render(
      <MemberDayTimeline day={day} events={[first, second]} members={[members[1]]} memberColors={memberColors} onEventSelect={onEventSelect} />,
    );

    const slots = container.querySelectorAll<HTMLElement>(".memberDayEventSlot");
    expect(slots).toHaveLength(2);
    expect(parseFloat(slots[0].style.height)).toBeGreaterThanOrEqual(32);
    expect(parseFloat(slots[1].style.height)).toBeGreaterThanOrEqual(32);
    expect(slots[0].style.left).not.toBe(slots[1].style.left);
    expect(screen.getByRole("button", { name: /短いA/ })).toHaveTextContent("09:00–09:01");
    fireEvent.click(screen.getByRole("button", { name: /短いB/ }));
    expect(onEventSelect).toHaveBeenCalledWith(second);
  });

  it("終日を別枠に置き、日またぎを当日の00:00〜24:00へ切り出す", () => {
    const allDay = event("出張", { start: "2026-08-10", end: "2026-08-12" });
    const endingToday = event("前日まで", { start: "2026-08-09", end: "2026-08-11" });
    const crossDay = event("夜間対応", { start: "2026-08-10T23:59:00+09:00", end: "2026-08-12T01:00:00+09:00" });
    const onEventSelect = vi.fn();
    const { container, rerender } = render(
      <MemberDayTimeline day={day} events={[allDay, endingToday, crossDay]} members={[members[1]]} memberColors={memberColors} onEventSelect={onEventSelect} />,
    );

    expect(container.querySelectorAll(".memberDayAllDayEvent")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /出張/ })).toHaveTextContent("終日出張会議室A");
    expect(screen.getByRole("button", { name: /夜間対応/ }))
      .toHaveTextContent("00:00–24:00夜間対応会議室A前日から継続・翌日へ継続");
    expect(screen.queryByRole("button", { name: /前日まで/ })).not.toBeInTheDocument();
    expect(container.querySelector(".memberDayAxis")?.textContent).toContain("24:00");
    fireEvent.click(screen.getByRole("button", { name: /出張/ }));
    expect(onEventSelect).toHaveBeenCalledWith(allDay);

    rerender(<MemberDayTimeline day={new Date("2026-08-12T00:00:00+09:00")} events={[allDay, crossDay]} members={[members[1]]} memberColors={memberColors} />);
    expect(screen.queryByRole("button", { name: /出張/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /夜間対応/ })).toHaveTextContent("00:00–01:00夜間対応会議室A前日から継続");
  });

  it("最初の時刻予定の1時間前へ初期スクロールし、読み込み後も合わせる", () => {
    const afternoon = event("午後予定", { start: "2026-08-11T13:30:00+09:00", end: "2026-08-11T14:00:00+09:00" });
    const morning = event("朝予定", { start: "2026-08-11T09:15:00+09:00", end: "2026-08-11T10:00:00+09:00" });
    const { rerender } = render(
      <MemberDayTimeline day={day} events={[]} members={[members[1]]} memberColors={memberColors} />,
    );
    const scroller = screen.getByRole("region", { name: "日別スケジュールのスクロール領域" });
    expect(scroller).toHaveAttribute("tabindex", "0");
    expect(scroller.scrollTop).toBe(8 * 80 - 12);
    rerender(<MemberDayTimeline day={day} events={[afternoon]} members={[members[1]]} memberColors={memberColors} />);
    expect(scroller.scrollTop).toBe(12 * 80 - 12);
    rerender(<MemberDayTimeline day={day} events={[afternoon, morning]} members={[members[1]]} memberColors={memberColors} />);
    expect(scroller.scrollTop).toBe(8 * 80 - 12);
  });

  it("担当者も予定もなければ空状態を示す", () => {
    render(<MemberDayTimeline day={day} events={[]} members={[]} memberColors={{}} />);
    expect(screen.getByText("この日の予定はありません。")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
