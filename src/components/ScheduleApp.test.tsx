// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleApp } from "./ScheduleApp";

const firebaseMocks = vi.hoisted(() => ({
  getClientAuth: vi.fn(() => ({ name: "test-auth" })),
  getMicrosoftProvider: vi.fn(() => ({ providerId: "microsoft.com" })),
  hasFirebaseClientConfig: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: firebaseMocks.getClientAuth,
  getMicrosoftProvider: firebaseMocks.getMicrosoftProvider,
  hasFirebaseClientConfig: firebaseMocks.hasFirebaseClientConfig,
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: firebaseMocks.onAuthStateChanged,
  signInWithPopup: firebaseMocks.signInWithPopup,
  signOut: firebaseMocks.signOut,
}));

describe("ScheduleApp calendar navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T12:00:00+09:00"));
    firebaseMocks.hasFirebaseClientConfig.mockReturnValue(false);
    firebaseMocks.onAuthStateChanged.mockReset();
    firebaseMocks.signInWithPopup.mockReset();
    firebaseMocks.signOut.mockReset();
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
    cleanup();
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

  it("waits for Firebase authentication and does not fetch events before sign-in", async () => {
    firebaseMocks.hasFirebaseClientConfig.mockReturnValue(true);
    let handleUser: ((user: null) => void) | undefined;
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return vi.fn();
    });

    render(<ScheduleApp initialMembers={[]} />);

    expect(screen.getByText("認証を確認しています…")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Microsoftでログイン" })).not.toBeInTheDocument();

    await act(async () => {
      handleUser?.(null);
    });

    expect(screen.getByRole("button", { name: "Microsoftでログイン" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a safe message when Microsoft sign-in fails", async () => {
    vi.useRealTimers();
    firebaseMocks.hasFirebaseClientConfig.mockReturnValue(true);
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(null);
      return vi.fn();
    });
    firebaseMocks.signInWithPopup.mockRejectedValue(new Error("internal provider details"));

    render(<ScheduleApp initialMembers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Microsoftでログイン" }));

    await waitFor(() => {
      expect(screen.getByText("Microsoft 365でのログインに失敗しました。")).toBeInTheDocument();
    });
    expect(screen.queryByText("internal provider details")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
