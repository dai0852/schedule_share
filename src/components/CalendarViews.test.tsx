// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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

    for (const label of ["Google", "Microsoft", "Teams"]) {
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByLabelText(`予定元: ${label}`)).toBeInTheDocument();
    }
  });

  it("月表示でも各予定元を色だけでなく可視テキストとaria-labelで示す", () => {
    render(<MonthCalendar days={[day]} selectedDate={day} events={events} />);

    for (const label of ["Google", "Microsoft", "Teams"]) {
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByLabelText(`予定元: ${label}`)).toBeInTheDocument();
    }
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
      .toHaveTextContent("09:00–10:00Googlegoogle予定");
    expect(screen.getByRole("cell", { name: "田中 8月12日" }))
      .toHaveTextContent("終日Google終日研修");
    expect(screen.getByRole("cell", { name: "佐藤 8月12日" })).toBeEmptyDOMElement();
  });

  it("日をまたぐ予定の表示時刻を各日セルの範囲へ切り出す", () => {
    const crossDayEvent: NormalizedEvent = {
      ...sourceEvent("teams", 0),
      eventId: "teams:member-1:cross-day",
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
});
