import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../app/api/events/route";

const mocks = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ requireAppUser: mocks.requireAppUser }));
vi.mock("@/server/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/events")>()),
  listEvents: mocks.listEvents,
}));

const start = "2026-08-11T00:00:00.000Z";
const end = "2026-08-13T00:00:00.000Z";
const ownerId = "550e8400-e29b-41d4-a716-446655440000";

function request(query = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`) {
  return new Request(`http://localhost/api/events?${query}`);
}

function largeEvent(index: number, textLength: number) {
  const sourceEventId = `large-${index}`;
  return {
    eventId: `google:${ownerId}:${sourceEventId}`,
    source: "google",
    sourceEventId,
    ownerUserId: ownerId,
    ownerName: "佐藤",
    calendarId: "primary",
    title: "予".repeat(textLength),
    location: "場".repeat(textLength),
    start,
    end,
    isOnlineMeeting: false,
    visibility: "team",
    updatedAt: start,
  };
}

describe("GET /api/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAppUser.mockResolvedValue({
      uid: "viewer-other-department",
      email: "viewer@studio-csa.com",
      role: "viewer",
    });
    mocks.listEvents.mockResolvedValue([]);
  });

  it("認証Responseをそのまま返し、queryやstoreを処理しない", async () => {
    const unauthorized = new Response("認証が必要です。", { status: 401 });
    mocks.requireAppUser.mockRejectedValue(unauthorized);

    const response = await GET(request("unknown=secret"));

    expect(response).toBe(unauthorized);
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown query", `start=${start}&end=${end}&secret=x`],
    ["duplicate", `start=${start}&start=${start}&end=${end}`],
    ["missing range", `start=${start}`],
    ["invalid source", `start=${start}&end=${end}&source=outlook`],
    ["invalid owner", `start=${start}&end=${end}&ownerUserId=../secret`],
    ["reverse range", `start=${end}&end=${start}`],
    ["too long range", "start=2025-01-01T00%3A00%3A00.000Z&end=2026-08-13T00%3A00%3A00.000Z"],
    ["mixed date formats", "start=2026-08-11&end=2026-08-13T00%3A00%3A00.000Z"],
  ])("%sは400でstoreを呼ばない", async (_name, query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "予定の検索条件が正しくありません。" });
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("他部署viewerもBearer認証後に担当者・予定元filterで予定を取得できる", async () => {
    const response = await GET(request(
      `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&ownerUserId=${ownerId}&source=teams`,
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.listEvents).toHaveBeenCalledWith({ start, end, ownerUserId: ownerId, source: "teams" });
    expect(await response.json()).toEqual({ events: [] });
  });

  it("成功時も公開allowlist以外の内部fieldをstripする", async () => {
    mocks.listEvents.mockResolvedValue([{
      eventId: `google:${ownerId}:g-1`, source: "google", sourceEventId: "g-1",
      ownerUserId: ownerId, ownerName: "佐藤", calendarId: "primary", title: "訪問",
      location: "名古屋", start, end, isOnlineMeeting: false, visibility: "team",
      updatedAt: start, startEpochMs: 123, secret: "raw-token",
    }]);

    const response = await GET(request());
    const serialized = JSON.stringify(await response.json());

    expect(serialized).not.toContain("startEpochMs");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).toContain("訪問");
  });

  it("store errorは固定500にし、生情報を返さない", async () => {
    mocks.listEvents.mockRejectedValue(new Error("Bearer raw-token firestore/project/internal"));

    const response = await GET(request());
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toContain("予定の取得に失敗しました。");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("firestore");
  });

  it("1000件のmultibyte予定でも公開byte上限内なら全件返す", async () => {
    mocks.listEvents.mockResolvedValue(Array.from({ length: 1_000 }, (_, index) => largeEvent(index, 1_000)));

    const response = await GET(request());
    const payload = await response.text();

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(8 * 1_024 * 1_024);
    expect(JSON.parse(payload).events).toHaveLength(1_000);
  });

  it("title/location上限のmultibyte予定でresponse byte上限を超えたらpartialを返さず固定500にする", async () => {
    mocks.listEvents.mockResolvedValue(Array.from({ length: 1_000 }, (_, index) => largeEvent(index, 4_096)));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "予定の取得に失敗しました。" });
  });

  it("storeがResponseをthrowしても認証Responseとしてpassthroughしない", async () => {
    const upstreamResponse = new Response("Bearer upstream-secret", { status: 418 });
    mocks.listEvents.mockRejectedValue(upstreamResponse);

    const response = await GET(request());

    expect(response).not.toBe(upstreamResponse);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "予定の取得に失敗しました。" });
  });
});
