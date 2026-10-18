import { describe, expect, it } from "vitest";
import { createMemberColorMap, extendMemberColorMap, getMemberColorStyle } from "@/domain/memberColor";

describe("担当者の配色", () => {
  it("担当者一覧が取れず月ごとの担当者が変わっても、既知の担当者の色を保持する", () => {
    const firstMonth = createMemberColorMap(["member-b", "member-c"]);
    const secondMonth = extendMemberColorMap(firstMonth, ["member-a", "member-b"]);
    expect(secondMonth["member-b"]).toEqual(firstMonth["member-b"]);
    expect(secondMonth["member-c"]).toEqual(firstMonth["member-c"]);
    expect(secondMonth["member-a"]).not.toEqual(firstMonth["member-b"]);
    expect(extendMemberColorMap(secondMonth, ["member-b"])).toBe(secondMonth);
  });

  it("登録上限1000人でも色が重複せず、担当者一覧の順序や重複IDに左右されない", () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => `member-${index}`);
    const colors = createMemberColorMap(ids);
    expect(new Set(Object.values(colors).map((style) => String((style as Record<string, unknown>)["--member-color"]))).size).toBe(1_000);
    expect(createMemberColorMap([...ids].reverse().concat(ids[0]))).toEqual(colors);
  });

  it("同じIDは呼び出し順・担当者の選択順に関係なく同じ配色になる", () => {
    const before = getMemberColorStyle("member-1");
    getMemberColorStyle("member-2");
    expect(getMemberColorStyle("member-1")).toEqual(before);
    expect(getMemberColorStyle("member-2")).not.toEqual(before);
  });
});
