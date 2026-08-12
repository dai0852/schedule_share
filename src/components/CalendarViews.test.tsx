// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { CalendarSource, NormalizedEvent } from "@/domain/schedule";
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
