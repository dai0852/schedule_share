import { describe, expect, it } from "vitest";
import {
  filterEvents,
  mapGoogleEvent,
  mapMicrosoftEvent,
  sortEvents,
} from "./schedule";

describe("calendar event normalization", () => {
  it("maps a Google Calendar event without leaking body, attendees, or meeting URL", () => {
    const event = mapGoogleEvent(
      {
        id: "g-1",
        summary: "客先定例",
        location: "東京本社",
        description: "社外秘メモ",
        attendees: [{ email: "customer@example.com" }],
        hangoutLink: "https://meet.google.com/secret",
        start: { dateTime: "2026-06-19T10:00:00+09:00" },
        end: { dateTime: "2026-06-19T11:00:00+09:00" },
        updated: "2026-06-18T12:00:00Z",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );

    expect(event).toEqual({
      eventId: "google:g-1",
      source: "google",
      sourceEventId: "g-1",
      ownerUserId: "sales-a",
      ownerName: "田中",
      calendarId: "primary",
      title: "客先定例",
      location: "東京本社",
      start: "2026-06-19T10:00:00+09:00",
      end: "2026-06-19T11:00:00+09:00",
      isOnlineMeeting: true,
      visibility: "team",
      updatedAt: "2026-06-18T12:00:00Z",
    });
  });

  it("maps a Microsoft Graph event as Teams when online meeting metadata is present", () => {
    const event = mapMicrosoftEvent(
      {
        id: "m-1",
        subject: "Teams 商談",
        location: { displayName: "Microsoft Teams Meeting" },
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        body: { content: "secret", contentType: "html" },
        attendees: [{ emailAddress: { address: "x@example.com" } }],
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/secret" },
        start: { dateTime: "2026-06-19T13:00:00", timeZone: "Tokyo Standard Time" },
        end: { dateTime: "2026-06-19T14:00:00", timeZone: "Tokyo Standard Time" },
        lastModifiedDateTime: "2026-06-18T15:00:00Z",
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(event.source).toBe("teams");
    expect(event.isOnlineMeeting).toBe(true);
    expect(event.title).toBe("Teams 商談");
    expect(Object.keys(event)).not.toContain("body");
    expect(Object.keys(event)).not.toContain("attendees");
    expect(Object.keys(event)).not.toContain("joinUrl");
  });
});

describe("event filtering", () => {
  const events = [
    {
      eventId: "1",
      source: "google" as const,
      sourceEventId: "1",
      ownerUserId: "sales-a",
      ownerName: "田中",
      calendarId: "primary",
      title: "午前予定",
      location: "",
      start: "2026-06-19T09:00:00+09:00",
      end: "2026-06-19T10:00:00+09:00",
      isOnlineMeeting: false,
      visibility: "team" as const,
      updatedAt: "2026-06-18T00:00:00Z",
    },
    {
      eventId: "2",
      source: "teams" as const,
      sourceEventId: "2",
      ownerUserId: "sales-b",
      ownerName: "佐藤",
      calendarId: "outlook",
      title: "午後予定",
      location: "Teams",
      start: "2026-06-19T15:00:00+09:00",
      end: "2026-06-19T16:00:00+09:00",
      isOnlineMeeting: true,
      visibility: "team" as const,
      updatedAt: "2026-06-18T00:00:00Z",
    },
  ];

  it("filters by inclusive date window and owner without deduplicating overlaps", () => {
    expect(
      filterEvents(events, {
        start: "2026-06-19T00:00:00+09:00",
        end: "2026-06-20T00:00:00+09:00",
        ownerUserId: "sales-b",
      }),
    ).toHaveLength(1);
  });

  it("sorts by start time then owner name", () => {
    expect(sortEvents([...events]).map((event) => event.eventId)).toEqual(["1", "2"]);
  });
});
