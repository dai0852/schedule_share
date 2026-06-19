import { describe, expect, it } from "vitest";
import { canManage, getRoleCapabilities, isAllowedCorporateEmail } from "./access";

describe("access rules", () => {
  it("allows only configured corporate Microsoft account domains", () => {
    expect(isAllowedCorporateEmail("user@example.co.jp", ["example.co.jp"])).toBe(true);
    expect(isAllowedCorporateEmail("user@other.example", ["example.co.jp"])).toBe(false);
    expect(isAllowedCorporateEmail(null, ["example.co.jp"])).toBe(false);
  });

  it("limits management actions to admins", () => {
    expect(canManage({ uid: "1", email: "a@example.co.jp", role: "admin" })).toBe(true);
    expect(canManage({ uid: "2", email: "b@example.co.jp", role: "sales_member" })).toBe(false);
    expect(canManage({ uid: "3", email: "c@example.co.jp", role: "viewer" })).toBe(false);
  });

  it("keeps the MVP read-only for every role", () => {
    expect(getRoleCapabilities("admin").canEditSourceEvents).toBe(false);
    expect(getRoleCapabilities("sales_member").canEditSourceEvents).toBe(false);
    expect(getRoleCapabilities("viewer").canViewTeamSchedule).toBe(true);
  });
});
