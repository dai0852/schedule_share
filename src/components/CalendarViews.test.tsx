// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarSource, NormalizedEvent } from "@/domain/schedule";
import { MemberScheduleGrid } from "./MemberScheduleGrid";
import { MonthCalendar } from "./MonthCalendar";
import { TimeGridCalendar } from "./TimeGridCalendar";

const day = new Date("2026-08-11T00:00:00+09:00");

function sourceEvent(source: CalendarSource, index: number): NormalizedEvent {
  return {
    eventId: `${source}:member-1:event-${index}`,
    source,
    sourceEventId: `event-${index}`,
    ownerUserId: "member-1",
    ownerName: "佐藤",
    calendarId: source === "google" ? "primary" : "outlook",
    title: `${source}予定`,
    location: "",
    start: `2026-08-11T${String(9 + index).padStart(2, "0")}:00:00+09:00`,
    end: `2026-08-11T${String(10 + index).padStart(2, "0")}:00:00+09:00`,
    isOnlineMeeting: false,
    visibility: "team",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

const events = (["google", "microsoft", "teams"] as const)
  .map((source, index) => sourceEvent(source, index));

afterEach(cleanup);

describe("calendar source labels", () => {
  it("日・週のtime gridで各予定元を色だけでなく可視テキストとaria-labelで示す", () => {
    render(<TimeGridCalendar days={[day]} events={events} />);

    expect(screen.getByText("Google")).toBeVisible();
    expect(screen.getAllByText("Microsoft")).toHaveLength(2);
    expect(screen.queryByText("Teams")).not.toBeInTheDocument();
    expect(screen.getByLabelText("予定元: Google")).toBeInTheDocument();
    expect(screen.getAllByLabelText("予定元: Microsoft")).toHaveLength(2);
  });

  it("月表示では予定元に関係なく担当者名と同じ色で表示する", () => {
    render(<MonthCalendar days={[day]} selectedDate={day} events={events} />);

    const cards = screen.getAllByRole("button", { name: /の予定詳細を開く/ });
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.getAttribute("style")))
      .toEqual([cards[0].getAttribute("style"), cards[0].getAttribute("style"), cards[0].getAttribute("style")]);
    expect(screen.getAllByText("佐藤", { exact: false })).toHaveLength(3);
    expect(screen.queryByLabelText(/予定元:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Google|Microsoft|Teams)$/)).not.toBeInTheDocument();
  });
});

describe("予定カードの詳細表示", () => {
  it("月表示の予定カードから詳細表示を開ける", () => {
    const onEventSelect = vi.fn();
    const event = sourceEvent("google", 0);

    render(
      <MonthCalendar
        days={[day]}
        selectedDate={day}
        events={[event]}
        onEventSelect={onEventSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "google予定の予定詳細を開く" }));
    expect(onEventSelect).toHaveBeenCalledWith(event);
  });
});

describe("member schedule grid", () => {
  it("担当者を行・日付を列として予定の時刻と終日を正しいセルに表示する", () => {
    const members = [
      { id: "member-1", displayName: "佐藤", department: "営業一課" },
      { id: "member-2", displayName: "田中", department: "営業二課" },
    ];
    const allDayEvent: NormalizedEvent = {
      ...sourceEvent("google", 0),
      eventId: "google:member-2:all-day",
      sourceEventId: "all-day",
      ownerUserId: "member-2",
      ownerName: "田中",
      title: "終日研修",
      start: "2026-08-12",
      end: "2026-08-13",
    };

    render(
      <MemberScheduleGrid
        days={[day, new Date("2026-08-12T00:00:00+09:00")]}
        events={[sourceEvent("google", 0), allDayEvent]}
        members={members}
      />,
    );

    const scrollRegion = screen.getByRole("region", { name: "担当者予定表の横スクロール領域" });
    expect(scrollRegion).toHaveAttribute("tabindex", "0");
    const table = screen.getByRole("table", { name: "担当者予定表" });
    expect(table).toHaveAttribute("aria-rowcount", "3");
    expect(table).toHaveAttribute("aria-colcount", "3");
    expect(screen.getByRole("cell", { name: "佐藤 8月11日" }))
      .toHaveTextContent("09:00–10:00佐藤google予定");
    expect(screen.getByRole("cell", { name: "田中 8月12日" }))
      .toHaveTextContent("終日田中終日研修");
    expect(screen.getByRole("cell", { name: "佐藤 8月12日" })).toBeEmptyDOMElement();
  });

  it("日をまたぐ予定の表示時刻を各日セルの範囲へ切り出す", () => {
    const crossDayEvent: NormalizedEvent = {
      ...sourceEvent("microsoft", 0),
      eventId: "microsoft:member-1:cross-day",
      sourceEventId: "cross-day",
      title: "夜間対応",
      start: "2026-08-11T23:00:00+09:00",
      end: "2026-08-12T01:00:00+09:00",
    };

    render(
      <MemberScheduleGrid
        days={[day, new Date("2026-08-12T00:00:00+09:00")]}
        events={[crossDayEvent]}
        members={[{ id: "member-1", displayName: "佐藤", department: "営業一課" }]}
      />,
    );

    expect(screen.getByRole("cell", { name: "佐藤 8月11日" }))
      .toHaveTextContent("23:00–24:00");
    expect(screen.getByRole("cell", { name: "佐藤 8月12日" }))
      .toHaveTextContent("00:00–01:00");
  });

  it("重なるGoogle・複数のMicrosoft予定を必要最小限の横列に配置する", () => {
    const googleEvent: NormalizedEvent = {
      ...sourceEvent("google", 0),
      title: "Google長時間予定",
      start: "2026-08-11T10:00:00+09:00",
      end: "2026-08-11T12:00:00+09:00",
    };
    const microsoftFirstEvent: NormalizedEvent = {
      ...sourceEvent("microsoft", 1),
      title: "Microsoft前半予定",
      start: "2026-08-11T10:00:00+09:00",
      end: "2026-08-11T11:00:00+09:00",
    };
    const microsoftEvent: NormalizedEvent = {
      ...sourceEvent("microsoft", 2),
      title: "Microsoft後半予定",
      start: "2026-08-11T11:00:00+09:00",
      end: "2026-08-11T12:00:00+09:00",
    };

    render(
      <MemberScheduleGrid
        days={[day]}
        events={[googleEvent, microsoftFirstEvent, microsoftEvent]}
        members={[{ id: "member-1", displayName: "佐藤", department: "営業一課" }]}
      />,
    );

    const overlapGroup = screen.getByRole("group", { name: "10:00から重なる予定 3件" });
    expect(overlapGroup).toHaveStyle("--member-overlap-columns: 2");
    expect(overlapGroup.querySelectorAll("button")).toHaveLength(3);
  });

  it("連鎖して重なる予定もDOMでは開始時刻順に並べる", () => {
    const firstEvent: NormalizedEvent = {
      ...sourceEvent("google", 0),
      title: "最初の予定",
      start: "2026-08-11T09:00:00+09:00",
      end: "2026-08-11T10:00:00+09:00",
    };
    const longEvent: NormalizedEvent = {
      ...sourceEvent("microsoft", 1),
      title: "長時間の予定",
      start: "2026-08-11T09:30:00+09:00",
      end: "2026-08-11T11:00:00+09:00",
    };
    const lastEvent: NormalizedEvent = {
      ...sourceEvent("google", 2),
      title: "最後の予定",
      start: "2026-08-11T10:00:00+09:00",
      end: "2026-08-11T10:30:00+09:00",
    };

    render(
      <MemberScheduleGrid
        days={[day]}
        events={[lastEvent, longEvent, firstEvent]}
        members={[{ id: "member-1", displayName: "佐藤", department: "営業一課" }]}
      />,
    );

    const overlapGroup = screen.getByRole("group", { name: "09:00から重なる予定 3件" });
    expect([...overlapGroup.querySelectorAll("button")].map((button) => button.textContent))
      .toEqual(["09:00–10:00佐藤最初の予定", "09:30–11:00佐藤長時間の予定", "10:00–10:30佐藤最後の予定"]);
  });

  it("終了時刻と開始時刻が同じ連続予定は別の縦グループにする", () => {
    const firstEvent: NormalizedEvent = {
      ...sourceEvent("google", 0),
      start: "2026-08-11T09:00:00+09:00",
      end: "2026-08-11T10:00:00+09:00",
    };
    const nextEvent: NormalizedEvent = {
      ...sourceEvent("microsoft", 1),
      start: "2026-08-11T10:00:00+09:00",
      end: "2026-08-11T10:30:00+09:00",
    };

    render(
      <MemberScheduleGrid
        days={[day]}
        events={[firstEvent, nextEvent]}
        members={[{ id: "member-1", displayName: "佐藤", department: "営業一課" }]}
      />,
    );

    expect(screen.getByRole("group", { name: "09:00の予定 1件" }))
      .toHaveStyle("--member-overlap-columns: 1");
    expect(screen.getByRole("group", { name: "10:00の予定 1件" }))
      .toHaveStyle("--member-overlap-columns: 1");
  });
});


describe("月の日付選択", () => {
  it("日またぎの月カードは当日の開始時刻と継続方向を示す", () => {
    const crossDay = {
      ...sourceEvent("microsoft", 0),
      start: "2026-08-10T23:00:00+09:00",
      end: "2026-08-12T01:00:00+09:00",
    };
    render(<MonthCalendar days={[day]} selectedDate={day} events={[crossDay]} />);
    const card = screen.getByRole("button", { name: "microsoft予定の予定詳細を開く" });
    expect(card).toHaveTextContent("00:00 前日から継続 翌日へ継続 佐藤");
    expect(card).not.toHaveTextContent("23:00");
  });

  it("日付とほか件数から選択日を通知し、各日に最大3件表示する", () => {
    const onDaySelect = vi.fn();
    const fourEvents = [...events, { ...sourceEvent("google", 3), title: "4件目" }];
    render(<MonthCalendar days={[day]} selectedDate={day} events={fourEvents} onDaySelect={onDaySelect} />);
    const dayButton = screen.getByRole("button", { name: "2026年8月11日、予定4件" });
    expect(dayButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(dayButton);
    expect(onDaySelect).toHaveBeenLastCalledWith(day);
    expect(screen.getAllByRole("button", { name: /の予定詳細を開く/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "8月11日の予定をすべて表示" }));
    expect(onDaySelect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("4件目")).not.toBeInTheDocument();
  });
});
