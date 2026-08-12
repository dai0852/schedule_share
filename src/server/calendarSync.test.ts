import { describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "@/domain/schedule";
import { GoogleCalendarError } from "@/integrations/googleCalendar";
import { MicrosoftGraphError } from "@/integrations/microsoftGraph";
import {
  CalendarConnectionRecord,
  MemberStore,
  SyncConnectionChangedError,
  SyncStatusRecord,
} from "./memberStore";
import {
  createCalendarSyncService,
  type CalendarSyncDependencies,
  type SyncRange,
} from "./calendarSync";

const NOW = new Date("2026-08-11T09:00:00.000Z");
const START = "2026-07-12T09:00:00.000Z";
const END = "2027-02-07T09:00:00.000Z";

const member = {
  id: "member-1",
  displayName: "佐藤 花子",
  department: "営業部",
  microsoftEmail: "sato@example.com",
  active: true,
  microsoftSyncEnabled: true,
  googleConnectionStatus: "connected" as const,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

const connection: CalendarConnectionRecord = {
  memberId: member.id,
  revision: "11111111-1111-4111-8111-111111111111",
  googleSubject: "google-subject",
  googleEmail: "person@gmail.com",
  calendarId: "primary",
  encryptedRefreshToken: "ciphertext",
  tokenIv: "iv",
  tokenAuthTag: "tag",
  connectedAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function event(source: NormalizedEvent["source"], id = "provider/event/1"): NormalizedEvent {
  return {
    eventId: `${source}:${member.id}:${id}`,
    source,
    sourceEventId: id,
    ownerUserId: member.id,
    ownerName: member.displayName,
    calendarId: source === "google" ? "primary" : "outlook",
    title: "訪問",
    location: "名古屋",
    start: "2026-08-12T01:00:00.000Z",
    end: "2026-08-12T02:00:00.000Z",
    isOnlineMeeting: source === "teams",
    visibility: "team",
    updatedAt: NOW.toISOString(),
  };
}

function dependencies(overrides: Partial<CalendarSyncDependencies> = {}) {
  const statuses: SyncStatusRecord[] = [];
  const store = {
    listMembers: vi.fn().mockResolvedValue([member]),
    getConnection: vi.fn().mockResolvedValue(connection),
    getSyncStatuses: vi.fn().mockResolvedValue([]),
    saveSyncStatus: vi.fn(async (status: SyncStatusRecord) => { statuses.push(status); }),
    replaceProviderEvents: vi.fn().mockResolvedValue(undefined),
    saveGoogleReconnectFailure: vi.fn(async (status: SyncStatusRecord) => { statuses.push(status); }),
    acquireSyncLock: vi.fn().mockResolvedValue({ ownerId: "lease-token", fence: 1 }),
    renewSyncLock: vi.fn().mockResolvedValue(undefined),
    releaseSyncLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemberStore;
  const deps: CalendarSyncDependencies = {
    store,
    decryptRefreshToken: vi.fn().mockReturnValue("refresh-secret"),
    refreshGoogleAccessToken: vi.fn().mockResolvedValue("google-access-secret"),
    fetchGoogleEvents: vi.fn().mockResolvedValue([event("google")]),
    getMicrosoftAccessToken: vi.fn().mockResolvedValue("microsoft-access-secret"),
    fetchMicrosoftEvents: vi.fn().mockResolvedValue([event("microsoft")]),
    clock: () => new Date(NOW),
    scheduleInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    cancelInterval: vi.fn(),
    ...overrides,
  };
  return { deps, store, statuses };
}

describe("calendar sync service", () => {
  it("固定nowから範囲とMicrosoft syncedAtを一度だけ決め、providerを独立して完了する", async () => {
    const raw = "Bearer raw-access person@gmail.com https://provider.invalid/private";
    const { deps, store, statuses } = dependencies({
      fetchGoogleEvents: vi.fn().mockRejectedValue(new GoogleCalendarError("rate_limited")),
      fetchMicrosoftEvents: vi.fn().mockResolvedValue([event("microsoft")]),
    });
    const service = createCalendarSyncService(deps);

    const summary = await service.syncAllCalendars({ now: NOW });

    expect(summary).toEqual({
      status: "completed",
      members: 1,
      succeededProviders: 1,
      failedProviders: 1,
      skippedProviders: 0,
    });
    expect(deps.fetchGoogleEvents).toHaveBeenCalledWith(expect.objectContaining({
      timeMin: START,
      timeMax: END,
      owner: { ownerUserId: member.id, ownerName: member.displayName, calendarId: "primary" },
    }));
    expect(deps.fetchMicrosoftEvents).toHaveBeenCalledWith(expect.objectContaining({
      start: START,
      end: END,
      syncedAt: NOW.toISOString(),
      owner: { ownerUserId: member.id, ownerName: member.displayName, calendarId: "outlook" },
    }));
    expect(store.replaceProviderEvents).toHaveBeenCalledTimes(1);
    expect(store.replaceProviderEvents).toHaveBeenCalledWith(
      member.id,
      "microsoft",
      { start: START, end: END, syncedAt: NOW.toISOString() } satisfies SyncRange,
      [event("microsoft")],
      expect.objectContaining({ lease: { ownerId: "lease-token", fence: 1 }, now: expect.any(Function) }),
    );
    expect(statuses.at(-2)).toMatchObject({
      provider: "google",
      status: "error",
      lastErrorCode: "rate_limited",
      lastErrorMessage: "予定サービスが混み合っています。次回の同期で再試行します。",
    });
    expect(JSON.stringify(statuses)).not.toContain(raw);
    expect(statuses.at(-1)).toMatchObject({
      provider: "microsoft",
      status: "success",
      lastSucceededAt: NOW.toISOString(),
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    expect(store.releaseSyncLock).toHaveBeenCalledWith({ ownerId: "lease-token", fence: 1 });
  });

  it("Googleの再接続要求は状態だけ更新し、既存予定を削除しない", async () => {
    const { deps, store, statuses } = dependencies({
      refreshGoogleAccessToken: vi.fn().mockRejectedValue(new GoogleCalendarError("reconnect_required")),
    });
    const service = createCalendarSyncService(deps);

    const result = await service.syncMemberCalendars(member, {
      start: START,
      end: END,
      syncedAt: NOW.toISOString(),
    });

    expect(result.google).toBe("error");
    expect(store.saveGoogleReconnectFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: member.id,
        provider: "google",
        status: "error",
        lastErrorCode: "reconnect_required",
        lastErrorMessage: "Google Calendarの再接続が必要です。",
      }),
      expect.objectContaining({ lease: { ownerId: "lease-token", fence: 1 } }),
      connection.revision,
    );
    expect(store.replaceProviderEvents).not.toHaveBeenCalledWith(
      member.id,
      "google",
      expect.anything(),
      expect.anything(),
    );
    expect(statuses.find((status) => status.provider === "google" && status.status === "error"))
      .toMatchObject({
        lastErrorCode: "reconnect_required",
        lastErrorMessage: "Google Calendarの再接続が必要です。",
      });
  });

  it("再接続の原子更新が一般store failureなら非原子的fallbackをせず、connectedの次runで再試行する", async () => {
    const refreshGoogleAccessToken = vi.fn()
      .mockRejectedValueOnce(new GoogleCalendarError("reconnect_required"))
      .mockResolvedValue("google-access-secret");
    const { deps, store, statuses } = dependencies({ refreshGoogleAccessToken });
    vi.mocked(store.saveGoogleReconnectFailure)
      .mockRejectedValueOnce(new Error("firestore raw-secret failure"))
      .mockResolvedValueOnce(undefined);
    const service = createCalendarSyncService(deps);
    const target = { ...member, microsoftSyncEnabled: false };

    const first = await service.syncMemberCalendars(target, {
      start: START, end: END, syncedAt: NOW.toISOString(),
    });
    const second = await service.syncMemberCalendars(target, {
      start: START, end: END, syncedAt: NOW.toISOString(),
    });

    expect(first.google).toBe("error");
    expect(second.google).toBe("success");
    expect(refreshGoogleAccessToken).toHaveBeenCalledTimes(2);
    expect(statuses.filter((status) => status.provider === "google" && status.status === "error")).toEqual([]);
    expect(store.saveSyncStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", status: "error" }),
      expect.anything(),
      expect.anything(),
    );
    expect(JSON.stringify(statuses)).not.toContain("raw-secret");
  });

  it("inactive、未接続Google、無効Microsoftは取得も置換も行わない", async () => {
    const { deps, store } = dependencies();
    const service = createCalendarSyncService(deps);
    const inactive = { ...member, active: false };
    const inactiveResult = await service.syncMemberCalendars(inactive, {
      start: START,
      end: END,
      syncedAt: NOW.toISOString(),
    });
    expect(inactiveResult).toMatchObject({ google: "skipped", microsoft: "skipped" });

    const disabledResult = await service.syncMemberCalendars({
      ...member,
      googleConnectionStatus: "not_connected",
      microsoftSyncEnabled: false,
    }, { start: START, end: END, syncedAt: NOW.toISOString() });
    expect(disabledResult).toMatchObject({ google: "skipped", microsoft: "skipped" });
    expect(deps.fetchGoogleEvents).not.toHaveBeenCalled();
    expect(deps.fetchMicrosoftEvents).not.toHaveBeenCalled();
    expect(store.replaceProviderEvents).not.toHaveBeenCalled();
    expect(store.saveSyncStatus).not.toHaveBeenCalled();
  });

  it("memberId指定時は該当するactiveメンバーだけ同期する", async () => {
    const other = { ...member, id: "member-2", microsoftEmail: "other@example.com" };
    const { deps, store } = dependencies();
    vi.mocked(store.listMembers).mockResolvedValue([member, other, { ...member, id: "member-3", active: false }]);
    const service = createCalendarSyncService(deps);

    const summary = await service.syncAllCalendars({ now: NOW, memberId: other.id });

    expect(summary.members).toBe(1);
    expect(store.getConnection).toHaveBeenCalledWith(other.id);
    expect(store.getConnection).not.toHaveBeenCalledWith(member.id);
  });

  it("有効lock競合はproviderを呼ばず安全なsummaryを返す", async () => {
    const { deps, store } = dependencies();
    vi.mocked(store.acquireSyncLock).mockResolvedValue(null);
    const service = createCalendarSyncService(deps);

    await expect(service.syncAllCalendars({ now: NOW })).resolves.toEqual({
      status: "locked",
      members: 0,
      succeededProviders: 0,
      failedProviders: 0,
      skippedProviders: 0,
    });
    expect(store.listMembers).not.toHaveBeenCalled();
    expect(store.releaseSyncLock).not.toHaveBeenCalled();
  });

  it("unknown例外を固定sync_failedへ変換し、raw messageを保存しない", async () => {
    const raw = "refresh-secret client-secret person@gmail.com https://evil.invalid";
    const { deps, statuses } = dependencies({
      fetchMicrosoftEvents: vi.fn().mockRejectedValue(new Error(raw)),
    });
    const service = createCalendarSyncService(deps);

    await service.syncMemberCalendars({
      ...member,
      googleConnectionStatus: "not_connected",
    }, { start: START, end: END, syncedAt: NOW.toISOString() });

    expect(statuses.at(-1)).toMatchObject({
      provider: "microsoft",
      status: "error",
      lastErrorCode: "sync_failed",
      lastErrorMessage: "カレンダーの同期に失敗しました。次回の同期で再試行します。",
    });
    expect(JSON.stringify(statuses)).not.toContain(raw);
  });

  it("integration error codeをallowlistの固定メッセージへ分類する", async () => {
    const { deps, statuses } = dependencies({
      fetchGoogleEvents: vi.fn().mockRejectedValue(new GoogleCalendarError("invalid_response")),
      fetchMicrosoftEvents: vi.fn().mockRejectedValue(new MicrosoftGraphError("permission_denied")),
    });
    const service = createCalendarSyncService(deps);
    await service.syncMemberCalendars(member, { start: START, end: END, syncedAt: NOW.toISOString() });

    const errors = statuses.filter((status) => status.status === "error");
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "google", lastErrorCode: "invalid_response", lastErrorMessage: "予定サービスから無効な応答を受信しました。" }),
      expect.objectContaining({ provider: "microsoft", lastErrorCode: "permission_denied", lastErrorMessage: "Microsoftカレンダーの読み取り権限を確認してください。" }),
    ]));
  });

  it("不正なnowとrangeをprovider呼び出し前に拒否する", async () => {
    const { deps } = dependencies();
    const service = createCalendarSyncService(deps);
    await expect(service.syncAllCalendars({ now: new Date(Number.NaN) })).rejects.toThrow("同期日時が正しくありません。");
    await expect(service.syncAllCalendars({ now: "2026-08-11" } as never)).rejects.toThrow("同期日時が正しくありません。");
    await expect(service.syncMemberCalendars(member, {
      start: END,
      end: START,
      syncedAt: NOW.toISOString(),
    })).rejects.toThrow("同期範囲が正しくありません。");
    await expect(service.syncMemberCalendars(member, {
      start: "2026-11-31T00:00:00.000Z",
      end: "2026-12-03T00:00:00.000Z",
      syncedAt: NOW.toISOString(),
    })).rejects.toThrow("同期範囲が正しくありません。");
    await expect(service.syncMemberCalendars({
      ...member,
      googleConnectionStatus: "raw_status" as never,
    }, { start: START, end: END, syncedAt: NOW.toISOString() }))
      .rejects.toThrow("同期対象メンバーが正しくありません。");
    expect(deps.fetchGoogleEvents).not.toHaveBeenCalled();
  });

  it("全メンバー同期を最大3件に制限し、Microsoft app tokenをrun内で一度だけ共有する", async () => {
    const members = Array.from({ length: 10 }, (_, index) => ({
      ...member,
      id: `member-${index}`,
      microsoftEmail: `member-${index}@example.com`,
      googleConnectionStatus: "not_connected" as const,
    }));
    let active = 0;
    let maxActive = 0;
    const fetchMicrosoftEvents = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return [];
    });
    const { deps, store } = dependencies({ fetchMicrosoftEvents });
    vi.mocked(store.listMembers).mockResolvedValue(members);
    const service = createCalendarSyncService(deps);

    const summary = await service.syncAllCalendars({ now: NOW });

    expect(summary.members).toBe(10);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(deps.getMicrosoftAccessToken).toHaveBeenCalledTimes(1);
  });

  it("共有Microsoft token取得失敗でもGoogle同期を継続し、各Microsoftだけ安全なerrorにする", async () => {
    const members = [member, { ...member, id: "member-2", microsoftEmail: "member-2@example.com" }];
    const { deps, store, statuses } = dependencies({
      getMicrosoftAccessToken: vi.fn().mockRejectedValue(new Error("tenant-secret raw-token")),
      fetchGoogleEvents: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(store.listMembers).mockResolvedValue(members);
    const service = createCalendarSyncService(deps);

    const summary = await service.syncAllCalendars({ now: NOW });

    expect(summary.succeededProviders).toBe(2);
    expect(summary.failedProviders).toBe(2);
    expect(deps.getMicrosoftAccessToken).toHaveBeenCalledTimes(1);
    expect(deps.fetchGoogleEvents).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(statuses)).not.toContain("tenant-secret");
  });

  it("heartbeatを60秒ごとに登録し、処理中にrenewしてfinallyで必ず解除する", async () => {
    let heartbeat: (() => void) | undefined;
    let resolveFetch: ((events: NormalizedEvent[]) => void) | undefined;
    const pendingFetch = new Promise<NormalizedEvent[]>((resolve) => { resolveFetch = resolve; });
    const scheduleInterval = vi.fn((callback: () => void, milliseconds: number) => {
      expect(milliseconds).toBe(60_000);
      heartbeat = callback;
      return 99 as unknown as ReturnType<typeof setInterval>;
    });
    const cancelInterval = vi.fn();
    const { deps, store } = dependencies({
      fetchGoogleEvents: vi.fn(() => pendingFetch),
      scheduleInterval,
      cancelInterval,
    });
    const service = createCalendarSyncService(deps);
    const syncing = service.syncAllCalendars({ now: NOW });
    await vi.waitFor(() => expect(deps.fetchGoogleEvents).toHaveBeenCalled());

    heartbeat?.();
    await vi.waitFor(() => expect(store.renewSyncLock).toHaveBeenCalledWith(
      { ownerId: "lease-token", fence: 1 },
      NOW,
    ));
    resolveFetch?.([]);
    await syncing;

    expect(cancelInterval).toHaveBeenCalledWith(99);
    expect(store.releaseSyncLock).toHaveBeenCalledWith({ ownerId: "lease-token", fence: 1 });
  });

  it("heartbeatでleaseを失った場合は進行中fetch後の永続化を止め、timerを必ず解除する", async () => {
    let heartbeat: (() => void) | undefined;
    let resolveFetch: ((events: NormalizedEvent[]) => void) | undefined;
    const pendingFetch = new Promise<NormalizedEvent[]>((resolve) => { resolveFetch = resolve; });
    const cancelInterval = vi.fn();
    const { deps, store } = dependencies({
      fetchGoogleEvents: vi.fn(() => pendingFetch),
      scheduleInterval: (callback) => {
        heartbeat = callback;
        return 77 as unknown as ReturnType<typeof setInterval>;
      },
      cancelInterval,
    });
    vi.mocked(store.listMembers).mockResolvedValue([{ ...member, microsoftSyncEnabled: false }]);
    vi.mocked(store.renewSyncLock).mockRejectedValueOnce(new Error("new-owner secret"));
    const service = createCalendarSyncService(deps);
    const syncing = service.syncAllCalendars({ now: NOW });
    await vi.waitFor(() => expect(deps.fetchGoogleEvents).toHaveBeenCalled());

    heartbeat?.();
    await vi.waitFor(() => expect(store.renewSyncLock).toHaveBeenCalled());
    await Promise.resolve();
    resolveFetch?.([event("google")]);
    const summary = await syncing;

    expect(summary.failedProviders).toBe(1);
    expect(store.replaceProviderEvents).not.toHaveBeenCalled();
    expect(cancelInterval).toHaveBeenCalledWith(77);
    expect(store.releaseSyncLock).toHaveBeenCalledWith({ ownerId: "lease-token", fence: 1 });
  });

  it("Google接続revisionがfetch中に変わった場合は旧結果・旧error statusを書かない", async () => {
    const { deps, store, statuses } = dependencies();
    vi.mocked(store.replaceProviderEvents).mockRejectedValueOnce(new SyncConnectionChangedError());
    const service = createCalendarSyncService(deps);

    const result = await service.syncMemberCalendars({ ...member, microsoftSyncEnabled: false }, {
      start: START, end: END, syncedAt: NOW.toISOString(),
    });

    expect(result.google).toBe("error");
    expect(statuses.filter((status) => status.provider === "google")).toEqual([
      expect.objectContaining({ status: "running" }),
    ]);
    expect(store.saveGoogleReconnectFailure).not.toHaveBeenCalled();
  });
});
