// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicSalesMember } from "@/domain/member";
import { PUBLIC_EVENTS_RESPONSE_MAX_BYTES, type NormalizedEvent } from "@/domain/schedule";
import { ScheduleApp } from "./ScheduleApp";

const firebaseMocks = vi.hoisted(() => ({
  getClientAuth: vi.fn(() => ({ name: "test-auth" })),
  getMicrosoftProvider: vi.fn(() => ({ providerId: "microsoft.com" })),
  hasFirebaseClientConfig: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: firebaseMocks.getClientAuth,
  getMicrosoftProvider: firebaseMocks.getMicrosoftProvider,
  hasFirebaseClientConfig: firebaseMocks.hasFirebaseClientConfig,
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: firebaseMocks.onAuthStateChanged,
  signInWithPopup: firebaseMocks.signInWithPopup,
  signOut: firebaseMocks.signOut,
}));

const memberId = "550e8400-e29b-41d4-a716-446655440000";
const member: PublicSalesMember = {
  id: memberId,
  displayName: "田中 花子",
  department: "営業一課",
};
const secondMemberId = "123e4567-e89b-42d3-a456-426614174000";
const secondMember: PublicSalesMember = {
  id: secondMemberId,
  displayName: "佐藤 次郎",
  department: "営業二課",
};
const event: NormalizedEvent = {
  eventId: `google:${memberId}:g-1`,
  source: "google",
  sourceEventId: "g-1",
  ownerUserId: memberId,
  ownerName: "田中 花子",
  calendarId: "primary",
  title: "顧客訪問",
  location: "名古屋",
  start: "2026-08-11T09:30:00+09:00",
  end: "2026-08-11T10:30:00+09:00",
  isOnlineMeeting: false,
  visibility: "team",
  updatedAt: "2026-08-10T12:00:00.000Z",
};
const secondEvent: NormalizedEvent = {
  ...event,
  eventId: `microsoft:${secondMemberId}:m-1`,
  source: "microsoft",
  sourceEventId: "m-1",
  ownerUserId: secondMemberId,
  ownerName: "佐藤 次郎",
  calendarId: "outlook",
  title: "提案準備",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function signedInUser(token = "firebase-token", email = "viewer@studio-csa.com") {
  return { email, getIdToken: vi.fn().mockResolvedValue(token) };
}

function installApiFetch(options: {
  members?: unknown;
  events?: unknown;
  memberStatus?: number;
  eventStatus?: number;
  memberHeaders?: HeadersInit;
  eventHeaders?: HeadersInit;
  connection?: unknown;
  connectionStatus?: number;
  connectionHeaders?: HeadersInit;
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    const url = String(input);
    if (url.startsWith("/api/members")) {
      return jsonResponse(
        options.members ?? { members: [member] },
        options.memberStatus ?? 200,
        options.memberHeaders,
      );
    }
    if (url.startsWith("/api/events")) {
      return jsonResponse(
        options.events ?? { events: [] },
        options.eventStatus ?? 200,
        options.eventHeaders,
      );
    }
    if (url === "/api/me/calendar-connection") {
      return jsonResponse(
        options.connection ?? { registered: false },
        options.connectionStatus ?? 200,
        options.connectionHeaders,
      );
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function captureAuthState() {
  let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
  const unsubscribe = vi.fn();
  firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
    handleUser = next;
    return unsubscribe;
  });
  return { emit: (user: ReturnType<typeof signedInUser> | null) => handleUser?.(user), unsubscribe };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

describe("ScheduleApp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T12:00:00+09:00"));
    firebaseMocks.hasFirebaseClientConfig.mockReturnValue(true);
    firebaseMocks.onAuthStateChanged.mockReset();
    firebaseMocks.signInWithPopup.mockReset();
    firebaseMocks.signOut.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("Firebase認証確定前はAPIを呼ばずログイン画面だけを表示する", async () => {
    const auth = captureAuthState();
    const fetchMock = installApiFetch();

    render(<ScheduleApp />);

    expect(screen.getByText("ログイン状態を確認しています…")).toBeInTheDocument();
    expect(screen.queryByLabelText("担当者")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => auth.emit(null));
    expect(screen.getByRole("button", { name: "Microsoft でサインイン" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Firebase設定がなくdemoも明示されていなければ固定案内だけを表示してAPIを呼ばない", () => {
    firebaseMocks.hasFirebaseClientConfig.mockReturnValue(false);
    const fetchMock = installApiFetch();

    render(<ScheduleApp allowDemoAuth={false} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Firebase認証設定が不足しています。");
    expect(screen.queryByRole("button", { name: "Microsoft でサインイン" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("担当者")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("他部署viewerでもBearer認証で担当者と予定を取得し、Firestore担当者だけを表示する", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const fetchMock = installApiFetch({ members: { members: [member] }, events: { events: [event] } });

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser("other-dept-token", "hr@studio-csa.com")));

    expect(await screen.findByRole("checkbox", { name: "田中 花子 / 営業一課" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /デモ/ })).not.toBeInTheDocument();
    expect(await screen.findByText("顧客訪問")).toBeInTheDocument();
    const apiCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/"));
    expect(apiCalls).toHaveLength(3);
    for (const [, init] of apiCalls) {
      expect(init).toMatchObject({ headers: { authorization: "Bearer other-dept-token" } });
    }
    expect(screen.queryByRole("link", { name: "Googleカレンダー接続" })).not.toBeInTheDocument();
  });

  it("active登録メンバーだけにGoogle接続管理リンクを表示する", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({
      connection: { registered: true, status: "connected", googleEmail: "member@gmail.com" },
    });

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser("member-token", "member@studio-csa.com")));

    expect(await screen.findByRole("link", { name: "Googleカレンダー接続" })).toHaveAttribute("href", "/connect");
    expect(screen.queryByRole("link", { name: "管理者コンソール" })).not.toBeInTheDocument();
  });

  it("サーバーが確認した管理者には管理者コンソールへの導線を表示する", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({
      connection: {
        registered: true,
        canManageMembers: true,
        status: "connected",
        googleEmail: "member@gmail.com",
      },
    });

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser("admin-token", "kurihara@studio-csa.com")));

    expect(await screen.findByRole("link", { name: "管理者コンソール" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("link", { name: "Googleカレンダー接続" })).toHaveAttribute("href", "/connect");
  });

  it("Google接続状態responseが失敗・過大なら導線をfail closedで隠す", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({
      connection: { registered: true, status: "connected" },
      connectionHeaders: { "content-length": "70000" },
    });

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    await screen.findByRole("checkbox", { name: "田中 花子 / 営業一課" });

    expect(screen.queryByRole("link", { name: "Googleカレンダー接続" })).not.toBeInTheDocument();
  });

  it("担当ビューで複数担当者を選択し、再取得せず表示対象を切り替える", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const fetchMock = installApiFetch({
      members: { members: [member, secondMember] },
      events: { events: [event, secondEvent] },
    });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser("filter-token")));
    const firstMemberCheckbox = await screen.findByRole("checkbox", { name: "田中 花子 / 営業一課" });
    const secondMemberCheckbox = screen.getByRole("checkbox", { name: "佐藤 次郎 / 営業二課" });
    expect(screen.getByRole("button", { name: "担当" })).toHaveAttribute("aria-pressed", "true");
    expect(firstMemberCheckbox).toBeChecked();
    expect(secondMemberCheckbox).toBeChecked();
    expect(screen.getByText("顧客訪問")).toBeInTheDocument();
    expect(screen.getByText("提案準備")).toBeInTheDocument();

    const eventCallsBeforeSelection = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("/api/events")).length;
    fireEvent.click(firstMemberCheckbox);

    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
    expect(screen.getByText("提案準備")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")))
      .toHaveLength(eventCallsBeforeSelection);

    fireEvent.click(screen.getByRole("button", { name: "全員を選択" }));
    expect(firstMemberCheckbox).toBeChecked();
    expect(screen.getByText("顧客訪問")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("予定元"), { target: { value: "teams" } });
    await act(async () => {});
    const lastEventCall = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")).at(-1);
    expect(String(lastEventCall?.[0])).toContain("source=teams");
    expect(String(lastEventCall?.[0])).not.toContain("ownerUserId");
    expect(lastEventCall?.[1]).toMatchObject({ headers: { authorization: "Bearer filter-token" } });
  });

  it("明示デモモードは担当者・接続APIを呼ばず、デモ認証で予定だけを再取得する", async () => {
    firebaseMocks.hasFirebaseClientConfig.mockReturnValue(false);
    const demoEvent = {
      ...event,
      start: "2026-06-19T09:30:00+09:00",
      end: "2026-06-19T10:30:00+09:00",
    };
    const fetchMock = installApiFetch({ events: { events: [demoEvent] } });
    render(<ScheduleApp allowDemoAuth />);
    await act(async () => {});

    expect(screen.getByText("顧客訪問")).toBeInTheDocument();
    const demoMemberCheckbox = screen.getByRole("checkbox", { name: "田中 花子" });
    expect(demoMemberCheckbox).toBeChecked();
    const eventCallsBeforeSelection = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("/api/events")).length;
    fireEvent.click(demoMemberCheckbox);
    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")))
      .toHaveLength(eventCallsBeforeSelection);
    fireEvent.click(screen.getByRole("button", { name: "全員を選択" }));
    expect(screen.getByText("顧客訪問")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Googleカレンダー接続" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/members")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/me/calendar-connection")).toHaveLength(0);

    let lastEventUrl = String(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")).at(-1)?.[0]);
    expect(lastEventUrl).toContain("start=2026-06-14T15%3A00%3A00.000Z");
    expect(lastEventUrl).toContain("end=2026-06-21T15%3A00%3A00.000Z");

    fireEvent.click(screen.getByRole("button", { name: "月" }));
    await act(async () => {});
    lastEventUrl = String(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")).at(-1)?.[0]);
    expect(lastEventUrl).toContain("start=2026-05-31T15%3A00%3A00.000Z");

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    await act(async () => {});
    lastEventUrl = String(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")).at(-1)?.[0]);
    expect(lastEventUrl).toContain("start=2026-06-28T15%3A00%3A00.000Z");
    expect(lastEventUrl).toContain("end=2026-08-02T15%3A00%3A00.000Z");
    const eventCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events"));
    expect(eventCalls).toHaveLength(3);
    for (const [, init] of eventCalls) {
      expect(init).toMatchObject({ headers: { "x-demo-email": "admin@example.co.jp" } });
    }
  });

  it("担当者API失敗時は固定文言だけを表示し、予定取得は継続する", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({
      memberStatus: 500,
      members: { error: "Bearer raw-member-token user@secret.example" },
      events: { events: [event] },
    });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(await screen.findByText("担当者一覧を取得できませんでした。")).toBeInTheDocument();
    expect(await screen.findByText("顧客訪問")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-member-token");
    expect(document.body).not.toHaveTextContent("secret.example");
  });

  it("予定API失敗時は固定文言だけを表示し、生エラーを描画しない", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({
      eventStatus: 500,
      events: { error: "Firestore raw-token https://internal.example" },
    });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(await screen.findByText("予定の取得に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-token");
    expect(document.body).not.toHaveTextContent("internal.example");
  });

  it("大きすぎる担当者responseを本文読取前に拒否する", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({ memberHeaders: { "content-length": "70000" } });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(await screen.findByText("担当者一覧を取得できませんでした。")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "田中 花子 / 営業一課" })).not.toBeInTheDocument();
  });

  it("Content-Lengthが公開予定byte契約を超えたresponseを本文読取前に拒否する", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({
      events: { events: [event] },
      eventHeaders: { "content-length": String(PUBLIC_EVENTS_RESPONSE_MAX_BYTES + 1) },
    });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(await screen.findByText("予定の取得に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
  });

  it("Content-Lengthなしのchunked multibyte responseも公開予定byte契約で打ち切る", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const chunk = new TextEncoder().encode("予".repeat(350_000));
    let chunkCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (url.startsWith("/api/events")) {
        return Promise.resolve(new Response(new ReadableStream({
          pull(controller) {
            if (chunkCount < 9) {
              controller.enqueue(chunk);
              chunkCount += 1;
            } else {
              controller.close();
            }
          },
        }), { headers: { "content-type": "application/json" } }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(await screen.findByText("予定の取得に失敗しました。時間をおいて再度お試しください。"))
      .toBeInTheDocument();
    expect(chunkCount).toBeLessThanOrEqual(9);
  });

  it("予定元filter変更で新requestがpending・errorでも旧filterの予定を即時に隠す", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const nextEvents = deferred<Response>();
    let eventRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (url.startsWith("/api/events")) {
        eventRequests += 1;
        return eventRequests === 1
          ? Promise.resolve(jsonResponse({ events: [event] }))
          : nextEvents.promise;
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    expect(await screen.findByText("顧客訪問")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("予定元"), { target: { value: "google" } });

    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
    expect(screen.getByText("予定を読み込んでいます…")).toBeInTheDocument();
    await act(async () => nextEvents.resolve(jsonResponse({ error: "raw-old-filter" }, 500)));
    expect(await screen.findByText("予定の取得に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
  });

  it("view/sourceを連続変更してabortされた旧requestが完了しても旧予定を復元しない", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const abortedEvents = deferred<Response>();
    const teamsEvent = {
      ...event,
      eventId: `teams:${memberId}:t-1`,
      source: "teams" as const,
      sourceEventId: "t-1",
      calendarId: "outlook",
      title: "Teams予定",
    };
    let eventRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (url.startsWith("/api/events")) {
        eventRequests += 1;
        if (eventRequests === 1) return Promise.resolve(jsonResponse({ events: [event] }));
        if (eventRequests === 2) return abortedEvents.promise;
        return Promise.resolve(jsonResponse({ events: [teamsEvent] }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    expect(await screen.findByText("顧客訪問")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "月" }));
    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
    await waitFor(() => expect(eventRequests).toBe(2));
    fireEvent.change(screen.getByLabelText("予定元"), { target: { value: "teams" } });
    expect(await screen.findByText("Teams予定")).toBeInTheDocument();
    await act(async () => abortedEvents.resolve(jsonResponse({ events: [event] })));

    expect(screen.getByText("Teams予定")).toBeInTheDocument();
    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
  });

  it("URLを含む予定や未知fieldをstrictに拒否して画面へ出さない", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({ events: { events: [{ ...event, title: "https://meet.google.com/raw-secret", attendees: [] }] } });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(await screen.findByText("予定の取得に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-secret");
  });

  it("認証ユーザー切替後に旧requestが完了しても旧担当者を反映しない", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const oldMembers = deferred<Response>();
    const newMember = { ...member, id: "123e4567-e89b-42d3-a456-426614174000", displayName: "佐藤 次郎" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (url === "/api/members" && authorization === "Bearer old-token") return oldMembers.promise;
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [newMember] }));
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);

    await act(async () => auth.emit(signedInUser("old-token", "old@studio-csa.com")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/members", expect.anything()));
    await act(async () => auth.emit(signedInUser("new-token", "new@studio-csa.com")));
    expect(await screen.findByRole("checkbox", { name: "佐藤 次郎 / 営業一課" })).toBeInTheDocument();
    await act(async () => oldMembers.resolve(jsonResponse({ members: [member] })));

    expect(screen.queryByRole("checkbox", { name: "田中 花子 / 営業一課" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "佐藤 次郎 / 営業一課" })).toBeInTheDocument();
  });

  it("認証ユーザー切替後に旧Google接続状態が完了しても旧ユーザーの導線を表示しない", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const oldConnection = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (url === "/api/me/calendar-connection" && authorization === "Bearer old-token") {
        return oldConnection.promise;
      }
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url.startsWith("/api/events")) return Promise.resolve(jsonResponse({ events: [] }));
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);

    await act(async () => auth.emit(signedInUser("old-token", "old@studio-csa.com")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/calendar-connection",
      expect.objectContaining({ headers: { authorization: "Bearer old-token" } }),
    ));
    await act(async () => auth.emit(signedInUser("new-token", "new@studio-csa.com")));
    await act(async () => oldConnection.resolve(jsonResponse({ registered: true, status: "connected" })));

    expect(screen.queryByRole("link", { name: "Googleカレンダー接続" })).not.toBeInTheDocument();
  });

  it("StrictMode再mountでは破棄済みeffectから重複API requestを送らない", async () => {
    vi.useRealTimers();
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser("strict-token"));
      return vi.fn();
    });
    const fetchMock = installApiFetch();

    render(<StrictMode><ScheduleApp /></StrictMode>);
    expect(await screen.findByRole("checkbox", { name: "田中 花子 / 営業一課" })).toBeInTheDocument();

    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/members")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events"))).toHaveLength(1);
  });

  it("認証を失ったら予定と担当者をclearしてログイン画面へ戻る", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({ events: { events: [event] } });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    expect(await screen.findByText("顧客訪問")).toBeInTheDocument();

    await act(async () => auth.emit(null));
    expect(screen.getByRole("button", { name: "Microsoft でサインイン" })).toBeInTheDocument();
    expect(screen.queryByText("顧客訪問")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "田中 花子 / 営業一課" })).not.toBeInTheDocument();
  });

  it("Microsoft sign-in失敗は固定文言にし二重requestを防ぐ", async () => {
    vi.useRealTimers();
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(null);
      return vi.fn();
    });
    const pending = deferred<never>();
    firebaseMocks.signInWithPopup.mockReturnValue(pending.promise);
    installApiFetch();
    render(<ScheduleApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Microsoft でサインイン" }));
    const pendingButton = screen.getByRole("button", { name: "サインインしています…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(firebaseMocks.signInWithPopup).toHaveBeenCalledTimes(1);

    await act(async () => pending.reject(new Error("raw provider secret")));
    await waitFor(() => expect(screen.getByText("Microsoft 365でのログインに失敗しました。")).toBeInTheDocument());
    expect(document.body).not.toHaveTextContent("raw provider secret");
  });
});
