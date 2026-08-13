import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SalesMemberRecord } from "@/domain/member";
import type { SyncStatusRecord } from "@/server/memberStore";
import { GET as adminGet, POST as adminPost } from "../../app/api/admin/members/route";
import { DELETE as adminDelete, PATCH as adminPatch } from "../../app/api/admin/members/[memberId]/route";
import { GET as publicGet } from "../../app/api/members/route";

const mocks = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
  listMembers: vi.fn(),
  createMember: vi.fn(),
  updateMember: vi.fn(),
  deleteMember: vi.fn(),
  getSyncStatuses: vi.fn(),
  acquireSyncLock: vi.fn(),
  releaseSyncLock: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ requireAppUser: mocks.requireAppUser }));
vi.mock("@/server/memberStore", () => ({
  getMemberStore: () => ({
    listMembers: mocks.listMembers,
    createMember: mocks.createMember,
    updateMember: mocks.updateMember,
    deleteMember: mocks.deleteMember,
    getSyncStatuses: mocks.getSyncStatuses,
    acquireSyncLock: mocks.acquireSyncLock,
    releaseSyncLock: mocks.releaseSyncLock,
  }),
}));

const admin = { uid: "admin-1", email: "admin@example.com", role: "admin" as const };
const viewer = { uid: "viewer-1", email: "viewer@example.com", role: "viewer" as const };
const member: SalesMemberRecord = {
  id: "member-1",
  displayName: "佐藤 花子",
  department: "営業一課",
  microsoftEmail: "hanako@example.com",
  active: true,
  microsoftSyncEnabled: true,
  googleConnectionStatus: "connected",
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};
const rawStatus: SyncStatusRecord = {
  memberId: "member-1",
  provider: "google",
  status: "error",
  lastStartedAt: "2026-08-11T08:55:00.000Z",
  lastSucceededAt: null,
  lastErrorCode: "unknown_internal_code",
  lastErrorMessage: "Bearer secret-token user@example.com https://firestore.googleapis.com/internal",
  updatedAt: "2026-08-11T09:00:00.000Z",
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function patchContext(memberId = "member-1") {
  return { params: Promise.resolve({ memberId }) };
}

describe("member route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAppUser.mockResolvedValue(admin);
    mocks.listMembers.mockResolvedValue([member]);
    mocks.getSyncStatuses.mockResolvedValue([]);
    mocks.createMember.mockResolvedValue(member);
    mocks.updateMember.mockResolvedValue(member);
    mocks.deleteMember.mockResolvedValue(undefined);
    mocks.acquireSyncLock.mockResolvedValue({ ownerId: "admin-delete", fence: 1 });
    mocks.releaseSyncLock.mockResolvedValue(undefined);
  });

  it.each([
    ["admin GET", () => adminGet(request("/api/admin/members"))],
    ["admin POST", () => adminPost(request("/api/admin/members", { method: "POST", body: "{}" }))],
    ["admin PATCH", () => adminPatch(request("/api/admin/members/member-1", { method: "PATCH", body: "{}" }), patchContext())],
    ["admin DELETE", () => adminDelete(request("/api/admin/members/member-1", { method: "DELETE" }), patchContext())],
    ["public GET", () => publicGet(request("/api/members"))],
  ])("%sは未認証Responseをそのまま返し、storeを呼ばない", async (_name, invoke) => {
    const unauthorized = new Response("認証が必要です。", { status: 401 });
    mocks.requireAppUser.mockRejectedValue(unauthorized);

    const response = await invoke();

    expect(response).toBe(unauthorized);
    expect(mocks.listMembers).not.toHaveBeenCalled();
    expect(mocks.createMember).not.toHaveBeenCalled();
    expect(mocks.updateMember).not.toHaveBeenCalled();
    expect(mocks.deleteMember).not.toHaveBeenCalled();
    expect(mocks.getSyncStatuses).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", () => adminGet(request("/api/admin/members"))],
    ["POST", () => adminPost(request("/api/admin/members", { method: "POST", body: "{}" }))],
    ["PATCH", () => adminPatch(request("/api/admin/members/member-1", { method: "PATCH", body: "{}" }), patchContext())],
    ["DELETE", () => adminDelete(request("/api/admin/members/member-1", { method: "DELETE" }), patchContext())],
  ])("admin %sは非adminを403にし、storeを呼ばない", async (_method, invoke) => {
    mocks.requireAppUser.mockResolvedValue(viewer);

    const response = await invoke();

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "管理者権限が必要です。" });
    expect(mocks.listMembers).not.toHaveBeenCalled();
    expect(mocks.createMember).not.toHaveBeenCalled();
    expect(mocks.updateMember).not.toHaveBeenCalled();
    expect(mocks.deleteMember).not.toHaveBeenCalled();
    expect(mocks.getSyncStatuses).not.toHaveBeenCalled();
  });

  it("admin GETは同期エラーをredactして返す", async () => {
    mocks.getSyncStatuses.mockResolvedValue([rawStatus]);

    const response = await adminGet(request("/api/admin/members"));
    const json = await body(response);
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json).toEqual({
      members: [member],
      syncStatuses: [expect.objectContaining({
        memberId: "member-1",
        lastErrorCode: "unknown",
        lastErrorSummary: "同期に失敗しました。",
      })],
    });
    expect(serialized).not.toContain("lastErrorMessage");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("firestore.googleapis.com");
  });

  it("admin GETの内部エラーは固定500にする", async () => {
    mocks.listMembers.mockRejectedValue(new Error("Firestore internal"));
    const response = await adminGet(request("/api/admin/members"));
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "メンバー取得に失敗しました。" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["unknown field", JSON.stringify({ displayName: "佐藤", department: "営業", microsoftEmail: "a@example.com", token: "secret" })],
  ])("admin POSTは%sを400にする", async (_name, input) => {
    const response = await adminPost(request("/api/admin/members", { method: "POST", body: input }));
    expect(response.status).toBe(400);
    expect(mocks.createMember).not.toHaveBeenCalled();
  });

  it("admin POSTは重複を400にする", async () => {
    mocks.createMember.mockRejectedValue(new Error("同じMicrosoftメールアドレスのメンバーは既に登録されています。"));
    const response = await adminPost(request("/api/admin/members", {
      method: "POST",
      body: JSON.stringify({ displayName: "佐藤", department: "営業", microsoftEmail: "a@example.com" }),
    }));
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: "同じMicrosoftメールアドレスのメンバーは既に登録されています。" });
  });

  it("admin POSTは作成結果を201で返す", async () => {
    const input = { displayName: "佐藤", department: "営業", microsoftEmail: "a@example.com" };
    const response = await adminPost(request("/api/admin/members", { method: "POST", body: JSON.stringify(input) }));
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ member });
    expect(mocks.createMember).toHaveBeenCalledWith(input);
  });

  it("admin POSTの内部エラーは固定500にする", async () => {
    mocks.createMember.mockRejectedValue(new Error("Firestore internal"));
    const response = await adminPost(request("/api/admin/members", {
      method: "POST",
      body: JSON.stringify({ displayName: "佐藤", department: "営業", microsoftEmail: "a@example.com" }),
    }));
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "メンバー登録に失敗しました。" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["unknown field", JSON.stringify({ token: "secret" })],
  ])("admin PATCHは%sを400にする", async (_name, input) => {
    const response = await adminPatch(
      request("/api/admin/members/member-1", { method: "PATCH", body: input }),
      patchContext(),
    );
    expect(response.status).toBe(400);
    expect(mocks.updateMember).not.toHaveBeenCalled();
  });

  it("admin PATCHはmissing memberを404にする", async () => {
    mocks.updateMember.mockRejectedValue(new Error("指定されたメンバーが見つかりません。"));
    const response = await adminPatch(
      request("/api/admin/members/missing", { method: "PATCH", body: JSON.stringify({ active: false }) }),
      patchContext("missing"),
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({ error: "指定されたメンバーが見つかりません。" });
  });

  it("admin PATCHは更新結果を返す", async () => {
    const updated = { ...member, active: false };
    mocks.updateMember.mockResolvedValue(updated);
    const response = await adminPatch(
      request("/api/admin/members/member-1", { method: "PATCH", body: JSON.stringify({ active: false }) }),
      patchContext(),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ member: updated });
    expect(mocks.updateMember).toHaveBeenCalledWith("member-1", { active: false });
  });

  it("admin PATCHの内部エラーは固定500にする", async () => {
    mocks.updateMember.mockRejectedValue(new Error("Firestore internal"));
    const response = await adminPatch(
      request("/api/admin/members/member-1", { method: "PATCH", body: JSON.stringify({ active: false }) }),
      patchContext(),
    );
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "メンバー更新に失敗しました。" });
  });

  it("admin PATCHはMicrosoftメール変更を正規化して渡し、重複は400にする", async () => {
    const response = await adminPatch(
      request("/api/admin/members/member-1", {
        method: "PATCH",
        body: JSON.stringify({ microsoftEmail: " NEW@EXAMPLE.COM " }),
      }),
      patchContext(),
    );
    expect(response.status).toBe(200);
    expect(mocks.updateMember).toHaveBeenCalledWith("member-1", { microsoftEmail: "new@example.com" });

    mocks.updateMember.mockRejectedValueOnce(new Error("同じMicrosoftメールアドレスのメンバーは既に登録されています。"));
    const duplicate = await adminPatch(
      request("/api/admin/members/member-1", {
        method: "PATCH",
        body: JSON.stringify({ microsoftEmail: "duplicate@example.com" }),
      }),
      patchContext(),
    );
    expect(duplicate.status).toBe(400);
    expect(await body(duplicate)).toEqual({ error: "同じMicrosoftメールアドレスのメンバーは既に登録されています。" });
  });

  it("admin DELETEは同期lock内で削除して204を返す", async () => {
    const response = await adminDelete(
      request("/api/admin/members/member-1", { method: "DELETE" }),
      patchContext(),
    );
    expect(response.status).toBe(204);
    expect(mocks.deleteMember).toHaveBeenCalledWith("member-1", expect.objectContaining({
      lease: { ownerId: "admin-delete", fence: 1 },
      now: expect.any(Function),
    }));
    expect(mocks.releaseSyncLock).toHaveBeenCalledWith({ ownerId: "admin-delete", fence: 1 });
  });

  it("admin DELETEは同期中を409、missingを404、未知例外を固定500にする", async () => {
    mocks.acquireSyncLock.mockResolvedValueOnce(null);
    const locked = await adminDelete(request("/api/admin/members/member-1", { method: "DELETE" }), patchContext());
    expect(locked.status).toBe(409);
    expect(mocks.deleteMember).not.toHaveBeenCalled();

    mocks.acquireSyncLock.mockResolvedValueOnce({ ownerId: "delete-2", fence: 2 });
    mocks.deleteMember.mockRejectedValueOnce(new Error("指定されたメンバーが見つかりません。"));
    const missing = await adminDelete(request("/api/admin/members/missing", { method: "DELETE" }), patchContext("missing"));
    expect(missing.status).toBe(404);

    mocks.acquireSyncLock.mockResolvedValueOnce({ ownerId: "delete-3", fence: 3 });
    mocks.deleteMember.mockRejectedValueOnce(new Error("Bearer secret-token"));
    const failed = await adminDelete(request("/api/admin/members/member-1", { method: "DELETE" }), patchContext());
    expect(failed.status).toBe(500);
    expect(await body(failed)).toEqual({ error: "メンバー削除に失敗しました。" });
  });

  it("public GETはactive memberの公開3項目だけを返す", async () => {
    mocks.requireAppUser.mockResolvedValue(viewer);
    mocks.listMembers.mockResolvedValue([member, {
      ...member,
      id: "member-2",
      microsoftEmail: "inactive@example.com",
      active: false,
    }]);
    const response = await publicGet(request("/api/members"));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      members: [{ id: "member-1", displayName: "佐藤 花子", department: "営業一課" }],
    });
  });

  it("public GETの内部エラーは固定500にする", async () => {
    mocks.listMembers.mockRejectedValue(new Error("Firestore internal"));
    const response = await publicGet(request("/api/members"));
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "メンバー取得に失敗しました。" });
  });
});
