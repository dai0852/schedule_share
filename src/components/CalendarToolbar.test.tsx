// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CalendarToolbar } from "./CalendarToolbar";

describe("CalendarToolbar", () => {
  it("表示切替は担当と月だけを表示する", () => {
    render(
      <CalendarToolbar
        title="2026年8月10日 – 8月16日"
        mode="members"
        eventCount={9}
        onToday={vi.fn()}
        onMove={vi.fn()}
        onModeChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "担当" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "月" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "日" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "週" })).not.toBeInTheDocument();
  });
});
