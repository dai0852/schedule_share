import { describe, expect, it } from "vitest";
import { getMemberColorStyle } from "@/domain/memberColor";

describe("担当者の配色", () => {
  it("同じIDは呼び出し順・担当者の選択順に関係なく同じ配色になる", () => {
    const before = getMemberColorStyle("member-1");
    getMemberColorStyle("member-2");
    expect(getMemberColorStyle("member-1")).toEqual(before);
    expect(getMemberColorStyle("member-2")).not.toEqual(before);
  });
});
