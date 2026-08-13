import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../app/api/members/[memberId]/photo/route";

const mocks = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
  getActiveMemberById: vi.fn(),
  getMicrosoftProfilePhotoAccessToken: vi.fn(),
  fetchMicrosoftProfilePhoto: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ requireAppUser: mocks.requireAppUser }));
vi.mock("@/server/memberStore", () => ({
  getMemberStore: () => ({ getActiveMemberById: mocks.getActiveMemberById }),
}));
vi.mock("@/integrations/microsoftGraph", () => ({
  getMicrosoftProfilePhotoAccessToken: mocks.getMicrosoftProfilePhotoAccessToken,
  fetchMicrosoftProfilePhoto: mocks.fetchMicrosoftProfilePhoto,
}));

const member = {
  id: "member-1",
  displayName: "栗原 大",
  department: "営業部",
  microsoftEmail: "kurihara@studio-csa.com",
  active: true,
  microsoftSyncEnabled: true,
  googleConnectionStatus: "connected" as const,
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};

function request() {
  return new Request("https://app.example.com/api/members/member-1/photo", {
    headers: { authorization: "Bearer firebase-id-token" },
  });
}

function context(memberId = "member-1") {
  return { params: Promise.resolve({ memberId }) };
}

describe("member profile photo route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAppUser.mockResolvedValue({ uid: "viewer", email: "viewer@example.com", role: "viewer" });
    mocks.getActiveMemberById.mockResolvedValue(member);
    mocks.getMicrosoftProfilePhotoAccessToken.mockResolvedValue("graph-app-token");
    mocks.fetchMicrosoftProfilePhoto.mockResolvedValue({
      contentType: "image/jpeg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });
  });

  it("認証済み利用者へactiveメンバーの写真だけをprivate cacheで返す", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(mocks.getActiveMemberById).toHaveBeenCalledWith("member-1");
    expect(mocks.fetchMicrosoftProfilePhoto).toHaveBeenCalledWith({
      accessToken: "graph-app-token",
      userPrincipalName: "kurihara@studio-csa.com",
    });
  });

  it("未認証Responseを返し、FirestoreとMicrosoftを呼ばない", async () => {
    const unauthorized = new Response("認証が必要です。", { status: 401 });
    mocks.requireAppUser.mockRejectedValue(unauthorized);

    await expect(GET(request(), context())).resolves.toBe(unauthorized);
    expect(mocks.getActiveMemberById).not.toHaveBeenCalled();
    expect(mocks.getMicrosoftProfilePhotoAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ["missing member", null, { contentType: "image/jpeg", bytes: new Uint8Array([1]) }],
    ["missing photo", member, null],
  ])("%sは404で扱い、秘密情報を返さない", async (_name, activeMember, photo) => {
    mocks.getActiveMemberById.mockResolvedValue(activeMember);
    mocks.fetchMicrosoftProfilePhoto.mockResolvedValue(photo);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toContain("private");
    if (!activeMember) expect(mocks.getMicrosoftProfilePhotoAccessToken).not.toHaveBeenCalled();
  });

  it("GraphやFirestoreの例外内容を公開せず固定502にする", async () => {
    mocks.fetchMicrosoftProfilePhoto.mockRejectedValue(
      new Error("Bearer raw-token kurihara@studio-csa.com https://graph.microsoft.com/internal"),
    );

    const response = await GET(request(), context());

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
