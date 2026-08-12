import { describe, expect, it } from "vitest";
import { normalizeMicrosoftEmail, toPublicMember } from "./member";

describe("member domain", () => {
  it("normalizes the Microsoft email used for allow-list matching", () => {
    expect(normalizeMicrosoftEmail(" Sales@Example.CO.JP ")).toBe("sales@example.co.jp");
  });

  it("returns only viewer-safe member fields", () => {
    const publicMember = toPublicMember({
      id: "member-1",
      displayName: "田中",
      department: "営業部",
      microsoftEmail: "tanaka@example.co.jp",
      active: true,
      microsoftSyncEnabled: true,
      googleConnectionStatus: "connected",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(publicMember).toEqual({
      id: "member-1",
      displayName: "田中",
      department: "営業部",
    });
  });
});
