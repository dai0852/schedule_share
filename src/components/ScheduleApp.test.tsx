// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleApp } from "./ScheduleApp";

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: vi.fn(),
  getMicrosoftProvider: vi.fn(),
  hasFirebaseClientConfig: () => false,
}));

describe("ScheduleApp calendar navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T12:00:00+09:00"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ events: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fetches the active week, month, and next month ranges", async () => {
    render(<ScheduleApp initialMembers={[]} />);
    await act(async () => {});

    const fetchMock = vi.mocked(fetch);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      "start=2026-06-14T15%3A00%3A00.000Z",
    );
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      "end=2026-06-21T15%3A00%3A00.000Z",
    );

    fireEvent.click(screen.getByRole("button", { name: "月" }));
    await act(async () => {});
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      "start=2026-05-31T15%3A00%3A00.000Z",
    );

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    await act(async () => {});
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      "start=2026-06-28T15%3A00%3A00.000Z",
    );
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      "end=2026-08-02T15%3A00%3A00.000Z",
    );
  });
});
