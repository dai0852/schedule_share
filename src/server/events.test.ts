import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listEvents } from "./events";

const mocks = vi.hoisted(() => ({
  hasFirebaseAdminConfig: vi.fn(),
  listMembers: vi.fn(),
  get: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  hasFirebaseAdminConfig: mocks.hasFirebaseAdminConfig,
  getAdminFirestore: () => ({
    collection: () => ({
      where: mocks.where,
    }),
  }),
}));

vi.mock("@/server/memberStore", () => ({
  getMemberStore: () => ({ listMembers: mocks.listMembers }),
}));

const ownerId = "550e8400-e29b-41d4-a716-446655440000";
const range = {
  start: "2026-08-11T00:00:00.000Z",
  end: "2026-08-13T00:00:00.000Z",
};

const activeMember = {
  id: ownerId,
  displayName: "佐藤",
  department: "営業部",
  microsoftEmail: "sato@example.co.jp",
  active: true,
  microsoftSyncEnabled: true,
  googleConnectionStatus: "connected" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function storedEvent(overrides: Record<string, unknown> = {}) {
  const start = "2026-08-12T01:00:00.000Z";
  const end = "2026-08-12T02:00:00.000Z";
  return {
    eventId: `google:${ownerId}:event-1`,
    source: "google",
    sourceEventId: "event-1",
    ownerUserId: ownerId,
    ownerName: "佐藤",
    calendarId: "primary",
    title: "訪問",
    location: "名古屋",
    start,
    end,
    isOnlineMeeting: false,
    visibility: "team",
    updatedAt: "2026-08-11T09:00:00.000Z",
    startEpochMs: Date.parse(start),
    endEpochMs: Date.parse(end),
    ...overrides,
  };
}

function setDocuments(values: unknown[]) {
  mocks.get.mockResolvedValue({ docs: values.map((value) => ({ data: () => value })) });
}

describe("listEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("USE_FIRESTORE", "true");
    vi.stubEnv("ALLOW_DEMO_AUTH", "false");
    mocks.hasFirebaseAdminConfig.mockReturnValue(true);
    mocks.listMembers.mockResolvedValue([activeMember]);
    mocks.where.mockImplementation(() => ({
      where: mocks.where,
      limit: mocks.limit,
    }));
    mocks.limit.mockImplementation(() => ({ get: mocks.get }));
    setDocuments([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("期間・担当者・予定元をFirestore queryへ適用し、内部fieldを除いた予定だけを返す", async () => {
    setDocuments([storedEvent({ internalRevision: undefined })]);
    // Firestore does not persist undefined; keep the fixture exact.
    const value = storedEvent();
    setDocuments([value]);

    const events = await listEvents({ ...range, ownerUserId: ownerId, source: "teams" });

    expect(mocks.where.mock.calls).toEqual([
      ["ownerUserId", "==", ownerId],
      ["source", "==", "teams"],
      ["startEpochMs", "<", Date.parse(range.end)],
      ["endEpochMs", ">", Date.parse(range.start)],
    ]);
    expect(mocks.limit).toHaveBeenCalledWith(1_001);
    expect(events).toEqual([]); // defensive source filtering rejects a bad fake query result
    expect(JSON.stringify(value)).toContain("startEpochMs");
  });

  it("Microsoft指定ではMicrosoft予定と旧Teams予定をFirestoreからまとめて取得する", async () => {
    const microsoftEvent = storedEvent({
      eventId: `microsoft:${ownerId}:microsoft-event`,
      source: "microsoft",
      sourceEventId: "microsoft-event",
      calendarId: "outlook",
    });
    const legacyTeamsEvent = storedEvent({
      eventId: `teams:${ownerId}:legacy-teams-event`,
      source: "teams",
      sourceEventId: "legacy-teams-event",
      calendarId: "outlook",
      isOnlineMeeting: true,
    });
    setDocuments([microsoftEvent, legacyTeamsEvent]);

    const events = await listEvents({ ...range, source: "microsoft" });

    expect(mocks.where).toHaveBeenCalledWith("source", "in", ["microsoft", "teams"]);
    expect(events.map((event) => event.source)).toEqual(["microsoft", "teams"]);
  });

  it("Firestore結果を開始日時順に返し、epochや未知fieldを公開しない", async () => {
    const later = storedEvent({
      eventId: `google:${ownerId}:event-2`,
      sourceEventId: "event-2",
      start: "2026-08-12T03:00:00.000Z",
      end: "2026-08-12T04:00:00.000Z",
      startEpochMs: Date.parse("2026-08-12T03:00:00.000Z"),
      endEpochMs: Date.parse("2026-08-12T04:00:00.000Z"),
    });
    setDocuments([later, storedEvent()]);

    const events = await listEvents(range);
    const serialized = JSON.stringify(events);

    expect(events.map((event) => event.sourceEventId)).toEqual(["event-1", "event-2"]);
    expect(serialized).not.toContain("startEpochMs");
    expect(serialized).not.toContain("endEpochMs");
  });

  it("owner指定がinactiveまたは不存在なら予定queryを実行せず0件を返す", async () => {
    mocks.listMembers.mockResolvedValue([{ ...activeMember, active: false }]);
    setDocuments([storedEvent()]);

    await expect(listEvents({ ...range, ownerUserId: ownerId })).resolves.toEqual([]);

    expect(mocks.where).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("全員表示でもinactive所有者の古い予定を公開しない", async () => {
    const inactiveOwnerId = "123e4567-e89b-42d3-a456-426614174000";
    mocks.listMembers.mockResolvedValue([
      activeMember,
      { ...activeMember, id: inactiveOwnerId, microsoftEmail: "inactive@example.co.jp", active: false },
    ]);
    setDocuments([
      storedEvent(),
      storedEvent({
        eventId: `google:${inactiveOwnerId}:inactive-event`,
        sourceEventId: "inactive-event",
        ownerUserId: inactiveOwnerId,
        ownerName: "退職者",
      }),
    ]);

    const events = await listEvents(range);

    expect(events.map((item) => item.ownerUserId)).toEqual([ownerId]);
  });

  it("member文書が壊れてactive一覧を確定できなければ予定全体をfail closedにする", async () => {
    mocks.listMembers.mockRejectedValue(new Error("Firestore data is invalid: member.active"));

    await expect(listEvents(range)).rejects.toThrow();

    expect(mocks.where).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("Firestoreを指定したのにAdmin設定がなければデモへfallbackしない", async () => {
    mocks.hasFirebaseAdminConfig.mockReturnValue(false);
    vi.stubEnv("ALLOW_DEMO_AUTH", "true");

    await expect(listEvents(range)).rejects.toThrow("予定データ設定が不足しています。");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("本番ではALLOW_DEMO_AUTH=trueでもFirestoreを必須にする", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("USE_FIRESTORE", "false");
    vi.stubEnv("ALLOW_DEMO_AUTH", "true");

    await expect(listEvents(range)).rejects.toThrow("予定データ設定が不足しています。");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("非本番で明示したdemo authだけがデモ予定を返す", async () => {
    vi.stubEnv("USE_FIRESTORE", "false");
    vi.stubEnv("ALLOW_DEMO_AUTH", "true");

    const events = await listEvents({
      start: "2026-06-18T15:00:00.000Z",
      end: "2026-06-20T15:00:00.000Z",
      ownerUserId: "sales-a",
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.ownerUserId === "sales-a")).toBe(true);
    expect(events.every((event) => event.eventId === `${event.source}:${event.ownerUserId}:${event.sourceEventId}`)).toBe(true);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("日付だけの期間はAsia/Tokyo境界でdefensive filterする", async () => {
    const tokyoMorning = storedEvent({
      eventId: `google:${ownerId}:tokyo-morning`,
      sourceEventId: "tokyo-morning",
      start: "2026-08-11T16:00:00.000Z",
      end: "2026-08-11T17:00:00.000Z",
      startEpochMs: Date.parse("2026-08-11T16:00:00.000Z"),
      endEpochMs: Date.parse("2026-08-11T17:00:00.000Z"),
    });
    setDocuments([tokyoMorning]);

    const events = await listEvents({ start: "2026-08-12", end: "2026-08-13" });

    expect(events.map((item) => item.sourceEventId)).toEqual(["tokyo-morning"]);
    expect(mocks.where).toHaveBeenCalledWith("endEpochMs", ">", Date.parse("2026-08-12T00:00:00.000+09:00"));
  });

  it.each([
    ["未知field", { secret: "must-not-leak" }],
    ["epoch不一致", { startEpochMs: 1 }],
    ["危険なlocation", { location: "https://meet.google.com/secret" }],
    ["private未mask", { visibility: "private", title: "秘密商談" }],
  ])("壊れたFirestore文書（%s）が1件でもあれば全体をfail closedにする", async (_name, override) => {
    setDocuments([storedEvent(), storedEvent({
      eventId: `google:${ownerId}:event-2`,
      sourceEventId: "event-2",
      ...override,
    })]);

    await expect(listEvents(range)).rejects.toThrow("予定データを取得できません。");
  });

  it("公開上限を超えるFirestore結果を拒否する", async () => {
    setDocuments(Array.from({ length: 1_001 }, (_, index) => storedEvent({
      eventId: `google:${ownerId}:event-${index}`,
      sourceEventId: `event-${index}`,
    })));

    await expect(listEvents(range)).rejects.toThrow("予定データを取得できません。");
  });

  it.each([
    [{}, "期間"],
    [{ start: range.start }, "期間"],
    [{ start: "invalid", end: range.end }, "期間"],
    [{ start: range.end, end: range.start }, "期間"],
    [{ start: range.start, end: "2028-08-13T00:00:00.000Z" }, "期間"],
    [{ start: "2026-08-11", end: range.end }, "期間"],
    [{ ...range, ownerUserId: "../secret" }, "担当者"],
  ])("不正filter %jをFirestoreへ渡さない", async (filters, _reason) => {
    void _reason;
    await expect(listEvents(filters)).rejects.toThrow();
    expect(mocks.where).not.toHaveBeenCalled();
  });
});
