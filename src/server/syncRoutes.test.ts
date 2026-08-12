import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/domain/access";
import * as adminRoute from "../../app/api/admin/sync/route";
import * as internalRoute from "../../app/api/internal/sync/calendars/route";

const mocks = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
  syncAllCalendars: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ requireAppUser: mocks.requireAppUser }));
vi.mock("@/server/calendarSync", () => ({ syncAllCalendars: mocks.syncAllCalendars }));

const admin: AppUser = { uid: "admin-1", email: "admin@example.com", role: "admin" };
const viewer: AppUser = { uid: "viewer-1", email: "viewer@example.com", role: "viewer" };
const configuredSecret = "0123456789abcdef0123456789abcdef";
const completed = {
  status: "completed" as const,
  members: 2,
  succeededProviders: 3,
  failedProviders: 0,
  skippedProviders: 1,
};

function request(path: string, headers: HeadersInit = {}): Request {
  return new Request(`http://localhost${path}`, { method: "POST", headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
}

describe("scheduled and manual sync routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SYNC_JOB_SECRET", configuredSecret);
    mocks.requireAppUser.mockResolvedValue(admin);
    mocks.syncAllCalendars.mockResolvedValue(completed);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("internal endpointはPOSTだけを公開する", () => {
    expect(internalRoute.POST).toBeTypeOf("function");
    expect("GET" in internalRoute).toBe(false);
    expect("PUT" in internalRoute).toBe(false);
  });

  it.each([
    ["missing", {}],
    ["wrong", { "x-sync-secret": "fedcba9876543210fedcba9876543210" }],
    ["length mismatch", { "x-sync-secret": `${configuredSecret}x` }],
    ["non-ASCII", { "x-sync-secret": `${configuredSecret.slice(0, -1)}é` }],
    ["oversize", { "x-sync-secret": "a".repeat(257) }],
  ])("internal endpointは%s secretを固定401で拒否する", async (_name, headers) => {
    const response = await internalRoute.POST(request("/api/internal/sync/calendars", headers));

    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: "同期認証に失敗しました。" });
    expectNoStore(response);
    expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
  });

  it("internal endpointは複数secret headerを拒否する", async () => {
    const headers = new Headers();
    headers.append("x-sync-secret", configuredSecret);
    headers.append("x-sync-secret", configuredSecret);

    const response = await internalRoute.POST(request("/api/internal/sync/calendars", headers));

    expect(response.status).toBe(401);
    expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "short", "a".repeat(257), `${configuredSecret.slice(0, -1)}あ`])(
    "internal endpointは不正なserver secret設定を固定500で拒否する: %s",
    async (configured) => {
      vi.stubEnv("SYNC_JOB_SECRET", configured);

      const response = await internalRoute.POST(request("/api/internal/sync/calendars", {
        "x-sync-secret": configuredSecret,
      }));

      expect(response.status).toBe(500);
      expect(await body(response)).toEqual({ error: "同期ジョブの設定が不足しています。" });
      expectNoStore(response);
      expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
    },
  );

  it("internal endpointは同期を1回実行し安全な集計だけを返す", async () => {
    mocks.syncAllCalendars.mockResolvedValue({
      ...completed,
      memberEmail: "raw@example.com",
      events: [{ title: "秘密予定" }],
      rawError: "Bearer raw-token",
    });

    const response = await internalRoute.POST(request("/api/internal/sync/calendars", {
      "x-sync-secret": configuredSecret,
    }));
    const json = await body(response);
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json).toEqual(completed);
    expect(mocks.syncAllCalendars).toHaveBeenCalledTimes(1);
    expect(mocks.syncAllCalendars).toHaveBeenCalledWith();
    expect(serialized).not.toContain("raw@example.com");
    expect(serialized).not.toContain("秘密予定");
    expect(serialized).not.toContain("raw-token");
    expectNoStore(response);
  });

  it.each([
    ["locked", { ...completed, status: "locked" as const, members: 0 }],
    ["partial", { ...completed, failedProviders: 1, succeededProviders: 2 }],
  ])("internal endpointは%sを200で返しschedulerの再試行stormを避ける", async (_name, summary) => {
    mocks.syncAllCalendars.mockResolvedValue(summary);

    const response = await internalRoute.POST(request("/api/internal/sync/calendars", {
      "x-sync-secret": configuredSecret,
    }));

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(summary);
  });

  it("internal endpointは未知の例外を固定500へ変換する", async () => {
    mocks.syncAllCalendars.mockRejectedValue(new Error("Bearer raw-token raw@example.com"));

    const response = await internalRoute.POST(request("/api/internal/sync/calendars", {
      "x-sync-secret": configuredSecret,
    }));

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "カレンダー同期を開始できませんでした。" });
    expectNoStore(response);
  });

  it("internal endpointは同期が投げたResponseも固定500へ変換しheaderを漏らさない", async () => {
    mocks.syncAllCalendars.mockRejectedValue(new Response("Bearer raw-token", {
      status: 418,
      headers: { location: "https://evil.example.com", "set-cookie": "secret=raw-token" },
    }));

    const response = await internalRoute.POST(request("/api/internal/sync/calendars", {
      "x-sync-secret": configuredSecret,
    }));

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "カレンダー同期を開始できませんでした。" });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expectNoStore(response);
  });

  it("internal endpointは不正な同期集計を固定500にし値を漏らさない", async () => {
    mocks.syncAllCalendars.mockResolvedValue({
      ...completed,
      status: "Bearer raw-token",
      failedProviders: -1,
    });

    const response = await internalRoute.POST(request("/api/internal/sync/calendars", {
      "x-sync-secret": configuredSecret,
    }));

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "カレンダー同期を開始できませんでした。" });
  });

  it("admin endpointはPOSTだけを公開する", () => {
    expect(adminRoute.POST).toBeTypeOf("function");
    expect("GET" in adminRoute).toBe(false);
    expect("PUT" in adminRoute).toBe(false);
  });

  it("admin endpointは未認証Responseを返し同期を呼ばない", async () => {
    const unauthorized = new Response("認証が必要です。", { status: 401 });
    mocks.requireAppUser.mockRejectedValue(unauthorized);

    const response = await adminRoute.POST(request("/api/admin/sync"));

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("認証が必要です。");
    expectNoStore(response);
    expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
  });

  it("admin endpointは非adminを固定403にし同期を呼ばない", async () => {
    mocks.requireAppUser.mockResolvedValue(viewer);

    const response = await adminRoute.POST(request("/api/admin/sync", {
      authorization: "Bearer viewer-token",
    }));

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "管理者権限が必要です。" });
    expectNoStore(response);
    expect(mocks.syncAllCalendars).not.toHaveBeenCalled();
  });

  it("admin endpointはBearer requestを認証して同期を1回実行する", async () => {
    const syncRequest = request("/api/admin/sync", { authorization: "Bearer admin-token" });

    const response = await adminRoute.POST(syncRequest);

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(completed);
    expect(mocks.requireAppUser).toHaveBeenCalledWith(syncRequest);
    expect(mocks.syncAllCalendars).toHaveBeenCalledTimes(1);
    expectNoStore(response);
  });

  it.each([
    ["locked", { ...completed, status: "locked" as const, members: 0 }],
    ["partial", { ...completed, failedProviders: 1 }],
  ])("admin endpointは%s集計を安全に返す", async (_name, summary) => {
    mocks.syncAllCalendars.mockResolvedValue({ ...summary, rawError: "Bearer raw-token" });

    const response = await adminRoute.POST(request("/api/admin/sync", {
      authorization: "Bearer admin-token",
    }));
    const json = await body(response);

    expect(response.status).toBe(200);
    expect(json).toEqual(summary);
    expect(JSON.stringify(json)).not.toContain("raw-token");
  });

  it("admin endpointは未知の例外を固定500へ変換する", async () => {
    mocks.syncAllCalendars.mockRejectedValue(new Error("Bearer raw-token raw@example.com"));

    const response = await adminRoute.POST(request("/api/admin/sync", {
      authorization: "Bearer admin-token",
    }));

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "カレンダー同期を開始できませんでした。" });
    expectNoStore(response);
  });

  it("admin endpointは同期が投げたResponseをpassthroughせず固定500へ変換する", async () => {
    mocks.syncAllCalendars.mockRejectedValue(new Response("Bearer raw-token", {
      status: 418,
      headers: { location: "https://evil.example.com", "set-cookie": "secret=raw-token" },
    }));

    const response = await adminRoute.POST(request("/api/admin/sync", {
      authorization: "Bearer admin-token",
    }));

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "カレンダー同期を開始できませんでした。" });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expectNoStore(response);
  });

  it("admin endpointは不正な同期集計を固定500にし値を漏らさない", async () => {
    mocks.syncAllCalendars.mockResolvedValue({
      ...completed,
      status: "Bearer raw-token",
      members: Number.NaN,
    });

    const response = await adminRoute.POST(request("/api/admin/sync", {
      authorization: "Bearer admin-token",
    }));

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: "カレンダー同期を開始できませんでした。" });
  });
});
