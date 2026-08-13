// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MemberAvatar } from "./MemberAvatar";

afterEach(cleanup);

describe("MemberAvatar", () => {
  it("写真読込前はイニシャル、読込後は写真を表示し、画像エラー時は戻す", () => {
    const { container } = render(
      <MemberAvatar displayName="栗原 大" photoUrl="blob:member-photo" />,
    );
    const image = container.querySelector("img");
    const initial = screen.getByText("栗");
    expect(image).not.toBeNull();
    expect(initial).not.toHaveClass("hidden");

    fireEvent.load(image as HTMLImageElement);
    expect(image).toHaveClass("loaded");
    expect(initial).toHaveClass("hidden");

    fireEvent.error(image as HTMLImageElement);
    expect(image).not.toHaveClass("loaded");
    expect(initial).not.toHaveClass("hidden");
  });
});
