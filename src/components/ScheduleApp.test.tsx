// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { format } from "date-fns";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicSalesMember } from "@/domain/member";
import { getCalendarRange } from "@/domain/calendar";
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
const visibleDate = format(new Date(), "yyyy-MM-dd");
const event: NormalizedEvent = {
  eventId: `google:${memberId}:g-1`,
  source: "google",
  sourceEventId: "g-1",
  ownerUserId: memberId,
  ownerName: "田中 花子",
  calendarId: "primary",
  title: "顧客訪問",
  location: "名古屋",
  start: `${visibleDate}T09:30:00+09:00`,
  end: `${visibleDate}T10:30:00+09:00`,
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

function openDetails(label: string) {
  const summary = [...document.querySelectorAll(".scheduleAccordion > summary")]
    .find((item) => item.textContent?.includes(label));
  expect(summary).toBeDefined();
  const details = summary?.parentElement as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary!);
  expect(details.open).toBe(true);
  return details;
}

function openAgendaMember(agenda: HTMLElement, name: string, count: number) {
  const summary = within(agenda).getByLabelText(`${name}の予定${count}件`, { selector: "summary" });
  const details = summary.parentElement as HTMLDetailsElement;
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  return details;
}

function eventRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events"));
}

function selectedDay(date: string, count: number) {
  return screen.getByRole("button", { name: `${date}、予定${count}件` });
}

function expectEventVisible(title: string) {
  expect(screen.getAllByText(title).length).toBeGreaterThan(0);
}

function expectEventAbsent(title: string) {
  expect(screen.queryAllByText(title)).toHaveLength(0);
}

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

function closeDayDialog() {
  const dialog = screen.getByRole("dialog", { name: "日付の予定" });
  const closeButton = within(dialog).getByRole("button", { name: "日付の予定を閉じる" });
  fireEvent.pointerDown(closeButton);
  fireEvent.click(closeButton);
  expect(screen.queryByRole("dialog", { name: "日付の予定" })).not.toBeInTheDocument();
}

describe("ScheduleApp", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true,
      value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
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
    for (const [key, descriptor] of [["showModal", originalShowModal], ["close", originalClose]] as const) {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
    }
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

    await waitFor(() => expect(document.querySelector(".scheduleAccordion > summary")).not.toBeNull());
    const sections = [...document.querySelectorAll(".scheduleAccordion > summary")];
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveTextContent("表示する担当者");
    expect(sections[1]).toHaveTextContent("その他の操作");
    expect((sections[0].parentElement as HTMLDetailsElement).open).toBe(false);
    expect((sections[1].parentElement as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByLabelText("予定元")).not.toBeInTheDocument();
    openDetails("表示する担当者");
    expect(screen.getByRole("checkbox", { name: "田中 花子 / 営業一課" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /デモ/ })).not.toBeInTheDocument();
    expectEventVisible("顧客訪問");
    const apiCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/"));
    expect(apiCalls).toHaveLength(3);
    for (const [, init] of apiCalls) {
      expect(init).toMatchObject({ headers: { authorization: "Bearer other-dept-token" } });
    }
    expect(screen.queryByRole("link", { name: "Googleカレンダー接続" })).not.toBeInTheDocument();
  });

  it("予定カードをクリックすると公開済みの予定詳細をポップアップで確認できる", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({ events: { events: [event] } });

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    await screen.findAllByRole("button", { name: "顧客訪問の予定詳細を開く" });
    const calendarCard = screen.getAllByRole("button", { name: "顧客訪問の予定詳細を開く" })[0];
    expect(calendarCard).toHaveTextContent("田中 花子");
    expect(calendarCard).toHaveTextContent("顧客訪問");
    const agenda = screen.getByRole("region", { name: "選択日の予定" });
    const memberAgenda = openAgendaMember(agenda, "田中 花子", 1);
    expect(calendarCard.style.getPropertyValue("--member-color"))
      .toBe(memberAgenda.querySelector<HTMLElement>("summary")?.style.getPropertyValue("--member-color"));
    fireEvent.click(calendarCard);

    const dialog = screen.getByRole("dialog", { name: "予定の詳細" });
    expect(dialog).toHaveTextContent("顧客訪問");
    expect(dialog).toHaveTextContent("田中 花子");
    expect(dialog).toHaveTextContent(/09:30〜10:30/);
    expect(dialog).toHaveTextContent("Google");
    expect(dialog).toHaveTextContent("名古屋");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "予定の詳細" })).not.toBeInTheDocument();
  });

  it("active登録メンバーだけにGoogle接続管理リンクを表示する", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({
      connection: { registered: true, status: "connected", googleEmail: "member@gmail.com" },
    });

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser("member-token", "member@studio-csa.com")));

    await waitFor(() => expect(document.querySelector(".scheduleAccordion > summary")).not.toBeNull());
    openDetails("その他の操作");
    expect(screen.getByRole("link", { name: "Googleカレンダー設定・解除" })).toHaveAttribute("href", "/connect");
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

    await waitFor(() => expect(document.querySelector(".scheduleAccordion > summary")).not.toBeNull());
    openDetails("その他の操作");
    expect(screen.getByRole("link", { name: "管理者コンソール" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("link", { name: "Googleカレンダー設定・解除" })).toHaveAttribute("href", "/connect");
  });

  it("管理者でも表示対象メンバーに未登録ならGoogle接続と管理者導線を隠す", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    installApiFetch({ connection: { registered: false, canManageMembers: false } });

    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser("admin-token", "kurihara@studio-csa.com")));
    await waitFor(() => expect(document.querySelector(".scheduleAccordion > summary")).not.toBeNull());
    openDetails("表示する担当者");

    expect(screen.queryByRole("link", { name: /Googleカレンダー/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "管理者コンソール" })).not.toBeInTheDocument();
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
    await waitFor(() => expect(document.querySelector(".scheduleAccordion > summary")).not.toBeNull());
    openDetails("表示する担当者");

    expect(screen.queryByRole("link", { name: "Googleカレンダー接続" })).not.toBeInTheDocument();
  });

  it("月表示で担当者を選択し、再取得せず全予定元の表示対象を切り替える", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const fetchMock = installApiFetch({
      members: { members: [member, secondMember] },
      events: { events: [
        event,
        secondEvent,
        {
          ...secondEvent,
          eventId: `teams:${secondMemberId}:legacy-teams`,
          source: "teams",
          sourceEventId: "legacy-teams",
          title: "旧Teams会議",
          isOnlineMeeting: true,
        },
      ] },
    });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser("filter-token")));
    openDetails("表示する担当者");
    const firstMemberCheckbox = screen.getByRole("checkbox", { name: "田中 花子 / 営業一課" });
    const secondMemberCheckbox = screen.getByRole("checkbox", { name: "佐藤 次郎 / 営業二課" });
    expect(screen.getByRole("button", { name: "月" })).toHaveAttribute("aria-pressed", "true");
    expect(firstMemberCheckbox).toBeChecked();
    expect(secondMemberCheckbox).toBeChecked();
    expectEventVisible("顧客訪問");
    expectEventVisible("提案準備");
    expectEventVisible("旧Teams会議");

    const eventCallsBeforeSelection = eventRequests(fetchMock).length;
    fireEvent.click(firstMemberCheckbox);

    expectEventAbsent("顧客訪問");
    expectEventVisible("提案準備");
    expect(eventRequests(fetchMock)).toHaveLength(eventCallsBeforeSelection);

    fireEvent.click(screen.getByRole("button", { name: "全員を選択" }));
    expect(firstMemberCheckbox).toBeChecked();
    expectEventVisible("顧客訪問");
    expectEventVisible("提案準備");
    expectEventVisible("旧Teams会議");
    expect(eventRequests(fetchMock)).toHaveLength(eventCallsBeforeSelection);
    const lastEventCall = eventRequests(fetchMock).at(-1);
    expect(String(lastEventCall?.[0])).not.toContain("source=");
    expect(String(lastEventCall?.[0])).not.toContain("ownerUserId");
    expect(lastEventCall?.[1]).toMatchObject({ headers: { authorization: "Bearer filter-token" } });
  });

  it("12名の担当者別一覧は登録順・一意の色を保ち、予定元混在と絞り込みでも色が変わらない", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const teamMembers: PublicSalesMember[] = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      displayName: `担当${String(index + 1).padStart(2, "0")}`,
      department: "営業部",
    }));
    const teamEvents: NormalizedEvent[] = teamMembers.map((owner, index) => {
      const source = index % 2 === 0 ? "google" : "microsoft";
      const hour = 20 - index;
      return {
        ...event,
        eventId: `${source}:${owner.id}:schedule-${index}`,
        source,
        sourceEventId: `schedule-${index}`,
        calendarId: source === "google" ? "primary" : "outlook",
        ownerUserId: owner.id,
        ownerName: owner.displayName,
        title: `${owner.displayName}の商談`,
        start: `${visibleDate}T${String(hour).padStart(2, "0")}:00:00+09:00`,
        end: `${visibleDate}T${String(hour + 1).padStart(2, "0")}:00:00+09:00`,
      };
    });
    const mixedOwner = teamMembers[5];
    teamEvents.push({
      ...teamEvents[5],
      eventId: `google:${mixedOwner.id}:extra`,
      source: "google",
      sourceEventId: "extra",
      calendarId: "primary",
      title: "別の予定元の商談",
      start: `${visibleDate}T08:00:00+09:00`,
      end: `${visibleDate}T09:00:00+09:00`,
    });
    installApiFetch({ members: { members: teamMembers }, events: { events: teamEvents } });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    const agenda = screen.getByRole("region", { name: "選択日の予定" });
    const summaries = [...agenda.querySelectorAll<HTMLElement>(".dayAgendaMember > summary")];
    expect(summaries.map((summary) => summary.getAttribute("aria-label"))).toEqual(
      teamMembers.map((owner, index) => `${owner.displayName}の予定${index === 5 ? 2 : 1}件`),
    );
    expect(summaries.every((summary) => !(summary.parentElement as HTMLDetailsElement).open)).toBe(true);

    openDetails("表示する担当者");
    const colors = teamMembers.map((owner, index) => {
      const checkbox = screen.getByRole("checkbox", { name: `${owner.displayName} / 営業部` });
      const option = checkbox.closest<HTMLElement>("label");
      const color = option?.style.getPropertyValue("--member-color");
      expect(color).toBeTruthy();
      expect(summaries[index].style.getPropertyValue("--member-color")).toBe(color);
      const group = openAgendaMember(agenda, owner.displayName, index === 5 ? 2 : 1);
      const cards = [...group.querySelectorAll<HTMLElement>(".dayAgendaEvent")];
      expect(cards).toHaveLength(index === 5 ? 2 : 1);
      expect(cards.every((card) => card.style.getPropertyValue("--member-color") === color)).toBe(true);
      return color;
    });
    expect(new Set(colors).size).toBe(12);
    const mixedCheckbox = screen.getByRole("checkbox", { name: `${mixedOwner.displayName} / 営業部` });
    const mixedGroup = summaries[5].parentElement as HTMLDetailsElement;
    expect(within(mixedGroup).getByText(`${mixedOwner.displayName}の商談`)).toBeInTheDocument();
    expect(within(mixedGroup).getByText("別の予定元の商談")).toBeInTheDocument();
    fireEvent.click(mixedCheckbox);
    expect(agenda.querySelector(`[aria-label="${mixedOwner.displayName}の予定2件"]`)).toBeNull();
    fireEvent.click(mixedCheckbox);
    const restoredSummary = within(agenda).getByLabelText(`${mixedOwner.displayName}の予定2件`, { selector: "summary" });
    expect(restoredSummary.style.getPropertyValue("--member-color")).toBe(colors[5]);
    expect(mixedCheckbox.closest<HTMLElement>("label")?.style.getPropertyValue("--member-color")).toBe(colors[5]);

    const selectedDate = new Date(`${visibleDate}T12:00:00+09:00`);
    const otherDate = new Date(selectedDate);
    otherDate.setDate(otherDate.getDate() === 1 ? 2 : 1);
    fireEvent.click(selectedDay(format(otherDate, "yyyy年M月d日"), 0));
    closeDayDialog();
    fireEvent.click(selectedDay(format(selectedDate, "yyyy年M月d日"), 13));
    closeDayDialog();
    const afterDateChange = within(screen.getByRole("region", { name: "選択日の予定" }))
      .getByLabelText(`${mixedOwner.displayName}の予定2件`, { selector: "summary" });
    expect((afterDateChange.parentElement as HTMLDetailsElement).open).toBe(false);
    expect(afterDateChange.style.getPropertyValue("--member-color")).toBe(colors[5]);
  });

  it("担当者API失敗後に月が変わり新担当者が現れても既知担当者の色を保つ", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
    const nextMonthFirst = format(nextMonth, "yyyy-MM-dd");
    const makeOwnerEvent = (ownerId: string, ownerName: string, day: string): NormalizedEvent => ({
      ...event,
      eventId: `google:${ownerId}:meeting`,
      sourceEventId: "meeting",
      ownerUserId: ownerId,
      ownerName,
      title: `${ownerName}の予定`,
      start: `${day}T09:00:00+09:00`,
      end: `${day}T10:00:00+09:00`,
    });
    const ownerA = makeOwnerEvent("owner-a", "担当A", nextMonthFirst);
    const ownerBCurrent = makeOwnerEvent("owner-b", "担当B", visibleDate);
    const ownerC = makeOwnerEvent("owner-c", "担当C", visibleDate);
    const ownerBNext = makeOwnerEvent("owner-b", "担当B", nextMonthFirst);
    let eventCallCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ error: "unavailable" }, 500));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (url.startsWith("/api/events")) {
        eventCallCount += 1;
        return Promise.resolve(jsonResponse({ events: eventCallCount === 1
          ? [ownerBCurrent, ownerC] : [ownerA, ownerBNext] }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    const firstAgenda = await screen.findByRole("region", { name: "選択日の予定" });
    const firstB = within(firstAgenda).getByLabelText("担当Bの予定1件", { selector: "summary" });
    const firstC = within(firstAgenda).getByLabelText("担当Cの予定1件", { selector: "summary" });
    const bColor = firstB.style.getPropertyValue("--member-color");
    const cColor = firstC.style.getPropertyValue("--member-color");
    expect(bColor).toBeTruthy();
    expect(cColor).toBeTruthy();
    expect(bColor).not.toBe(cColor);

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    const nextRange = getCalendarRange("month", nextMonth);
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(2));
    const params = new URL(String(eventRequests(fetchMock)[1][0]), "http://localhost").searchParams;
    expect(params.get("start")).toBe(nextRange.start.toISOString());
    expect(params.get("end")).toBe(nextRange.end.toISOString());
    expect(selectedDay(format(nextMonth, "yyyy年M月d日"), 2)).toHaveAttribute("aria-pressed", "true");

    const nextAgenda = await screen.findByRole("region", { name: "選択日の予定" });
    const nextA = within(nextAgenda).getByLabelText("担当Aの予定1件", { selector: "summary" });
    const nextB = within(nextAgenda).getByLabelText("担当Bの予定1件", { selector: "summary" });
    const aColor = nextA.style.getPropertyValue("--member-color");
    expect(nextB.style.getPropertyValue("--member-color")).toBe(bColor);
    expect(aColor).toBeTruthy();
    expect(aColor).not.toBe(bColor);
    expect(aColor).not.toBe(cColor);
  });

  it("同じ月の日付選択は再取得せず、選択日の一覧には同名予定もすべて残す", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const sameTitleEvents = Array.from({ length: 4 }, (_, index): NormalizedEvent => ({
      ...event,
      eventId: `google:${memberId}:same-${index}`,
      sourceEventId: `same-${index}`,
      title: "同名の予定",
      start: `${visibleDate}T${String(index + 9).padStart(2, "0")}:00:00+09:00`,
      end: `${visibleDate}T${String(index + 10).padStart(2, "0")}:00:00+09:00`,
    }));
    const fetchMock = installApiFetch({ events: { events: sameTitleEvents } });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    const dayLabel = format(new Date(`${visibleDate}T12:00:00+09:00`), "yyyy年M月d日");
    expect(selectedDay(dayLabel, 4)).toHaveAttribute("aria-pressed", "true");
    const agenda = screen.getByRole("region", { name: "選択日の予定" });
    openAgendaMember(agenda, "田中 花子", 4);
    expect(within(agenda).getAllByText("同名の予定")).toHaveLength(4);
    const callsBefore = eventRequests(fetchMock).length;
    const otherDay = new Date(`${visibleDate}T12:00:00+09:00`);
    otherDay.setDate(otherDay.getDate() === 1 ? 2 : 1);
    fireEvent.click(selectedDay(format(otherDay, "yyyy年M月d日"), 0));
    closeDayDialog();
    expect(selectedDay(format(otherDay, "yyyy年M月d日"), 0)).toHaveAttribute("aria-pressed", "true");
    const emptyAgenda = screen.getByRole("region", { name: "選択日の予定" });
    expect(within(emptyAgenda).queryByText("同名の予定")).not.toBeInTheDocument();
    expect(within(emptyAgenda).getByText("この日の予定はありません。")).toBeInTheDocument();
    fireEvent.click(selectedDay(dayLabel, 4));
    closeDayDialog();
    const restoredAgenda = screen.getByRole("region", { name: "選択日の予定" });
    openAgendaMember(restoredAgenda, "田中 花子", 4);
    expect(within(restoredAgenda).getAllByText("同名の予定")).toHaveLength(4);
    expect(eventRequests(fetchMock)).toHaveLength(callsBefore);
  });

  it("PCの日付クリックは選択担当者全員の時間割を開き、空日でも列を保つ", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const thirdMember: PublicSalesMember = {
      id: "123e4567-e89b-42d3-a456-426614174001",
      displayName: "鈴木 三郎",
      department: "営業三課",
    };
    const fetchMock = installApiFetch({
      members: { members: [member, secondMember, thirdMember] },
      events: { events: [event, secondEvent] },
    });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    openDetails("表示する担当者");
    fireEvent.click(screen.getByRole("checkbox", { name: "佐藤 次郎 / 営業二課" }));
    const callsBeforeDaySelection = eventRequests(fetchMock).length;
    const today = new Date(`${visibleDate}T12:00:00+09:00`);

    fireEvent.click(selectedDay(format(today, "yyyy年M月d日"), 1));
    const dialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(dialog).toHaveClass("desktopDayScheduleDialog");
    expect(dialog).toHaveTextContent(format(today, "M月d日"));
    const timeline = within(dialog).getByRole("region", { name: "担当者別の日別スケジュール" });
    const scroller = within(timeline).getByRole("region", { name: "日別スケジュールのスクロール領域" });
    const table = within(scroller).getByRole("table", { name: "担当者別の時間割" });
    expect(within(table).getByLabelText("田中 花子の時間別予定")).toBeInTheDocument();
    expect(within(table).getByLabelText("鈴木 三郎の時間別予定")).toBeInTheDocument();
    expect(within(table).queryByLabelText("佐藤 次郎の時間別予定")).not.toBeInTheDocument();
    expect(within(table).getByRole("button", { name: /09:30.*10:30.*顧客訪問/ })).toBeInTheDocument();
    expect(within(table).queryByText("提案準備")).not.toBeInTheDocument();
    expect(within(table).queryByText("Google")).not.toBeInTheDocument();
    expect(within(table).queryByText("Microsoft")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    closeDayDialog();
    expect(document.body.style.overflow).toBe("");

    const emptyDay = new Date(today);
    emptyDay.setDate(emptyDay.getDate() === 1 ? 2 : 1);
    fireEvent.click(selectedDay(format(emptyDay, "yyyy年M月d日"), 0));
    const emptyDialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(emptyDialog).toHaveClass("desktopDayScheduleDialog");
    const emptyTable = within(emptyDialog).getByRole("table", { name: "担当者別の時間割" });
    expect(within(emptyTable).getByLabelText("田中 花子の時間別予定")).toBeInTheDocument();
    expect(within(emptyTable).getByLabelText("鈴木 三郎の時間別予定")).toBeInTheDocument();
    expect(within(emptyTable).queryByRole("button", { name: /顧客訪問/ })).not.toBeInTheDocument();
    expect(eventRequests(fetchMock)).toHaveLength(callsBeforeDaySelection);
    closeDayDialog();
  });

  it("月外の日付を選ぶと表示月が移り、その日が選択される", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const fetchMock = installApiFetch();
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    const today = new Date();
    const previous = new Date(today.getFullYear(), today.getMonth(), 0);
    const following = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const outside = screen.queryByRole("button", { name: `${format(previous, "yyyy年M月d日")}、予定0件` })
      ? previous : following;
    const label = format(outside, "yyyy年M月d日");
    fireEvent.click(selectedDay(label, 0));
    expect(selectedDay(label, 0)).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(2));
    const dialog = await screen.findByRole("dialog", { name: "日付の予定" });
    expect(dialog).toHaveClass("desktopDayScheduleDialog");
    expect(dialog).toHaveTextContent(format(outside, "M月d日"));
    expect(document.body.style.overflow).toBe("hidden");
    closeDayDialog();
    expect(document.body.style.overflow).toBe("");
  });

  it("月外の日付は取得中に空ダイアログを開かず、成功後に一度だけ時間割を開く", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const nextResponse = deferred<Response>();
    let eventCallCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (url.startsWith("/api/events")) {
        eventCallCount += 1;
        return eventCallCount === 1
          ? Promise.resolve(jsonResponse({ events: [event] }))
          : nextResponse.promise;
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    await screen.findAllByText("顧客訪問");

    const today = new Date();
    const previous = new Date(today.getFullYear(), today.getMonth(), 0);
    const following = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const outside = screen.queryByRole("button", { name: `${format(previous, "yyyy年M月d日")}、予定0件` })
      ? previous : following;
    const date = format(outside, "yyyy-MM-dd");
    const destinationEvent: NormalizedEvent = {
      ...event,
      eventId: `google:${memberId}:destination`,
      sourceEventId: "destination",
      title: "移動先の予定",
      start: `${date}T09:30:00+09:00`,
      end: `${date}T10:30:00+09:00`,
    };
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");

    fireEvent.click(selectedDay(format(outside, "yyyy年M月d日"), 0));
    expect(screen.queryByRole("dialog", { name: "日付の予定" })).not.toBeInTheDocument();
    expect(showModal).not.toHaveBeenCalled();
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(2));
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "日付の予定" })).not.toBeInTheDocument();
    expect(showModal).not.toHaveBeenCalled();

    await act(async () => nextResponse.resolve(jsonResponse({ events: [destinationEvent] })));
    const dialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveClass("desktopDayScheduleDialog");
    expect(dialog).toHaveTextContent(format(outside, "M月d日"));
    const table = within(dialog).getByRole("table", { name: "担当者別の時間割" });
    expect(within(table).getByRole("button", { name: /09:30.*10:30.*移動先の予定/ })).toBeInTheDocument();
    closeDayDialog();
    showModal.mockRestore();
  });

  it("スマホ幅への変更でも担当表示を維持し、月と担当を切り替えられる", async () => {
    vi.useRealTimers();
    let isNarrow = false;
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return isNarrow; },
      media: "(max-width: 760px)",
      addEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => { onChange = listener; },
      removeEventListener: vi.fn(),
    })));
    const auth = captureAuthState();
    const fetchMock = installApiFetch();
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    fireEvent.click(screen.getByRole("button", { name: "担当" }));
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(2));
    const callsBeforeResize = eventRequests(fetchMock).length;
    isNarrow = true;
    await act(async () => onChange?.({ matches: true } as MediaQueryListEvent));
    expect(screen.getByRole("button", { name: "担当" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "月" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("table", { name: "担当者予定表" })).toBeInTheDocument();
    expect(eventRequests(fetchMock)).toHaveLength(callsBeforeResize);

    fireEvent.click(screen.getByRole("button", { name: "月" }));
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(3));
    expect(screen.getByRole("button", { name: "月" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(selectedDay(format(new Date(), "yyyy年M月d日"), 0));
    expect(screen.queryByRole("dialog", { name: "日付の予定" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "選択日の予定" })).toBeInTheDocument();
  });

  it("モバイルはメインの月と担当を切り替え、長押しpopupにはタブを表示しない", async () => {
    vi.useRealTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 760px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const thirdMember: PublicSalesMember = {
      id: "123e4567-e89b-42d3-a456-426614174001",
      displayName: "鈴木 三郎",
      department: "営業三課",
    };
    const auth = captureAuthState();
    const fetchMock = installApiFetch({
      members: { members: [member, secondMember, thirdMember] },
      events: { events: [event, secondEvent] },
    });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(screen.getByRole("button", { name: "月" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "担当" }));
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "担当" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table", { name: "担当者予定表" });
    for (const owner of [member, secondMember, thirdMember]) {
      expect(within(table).getByRole("rowheader", { name: new RegExp(owner.displayName) })).toBeInTheDocument();
    }
    expect(within(table).getAllByRole("columnheader")).toHaveLength(8);
    expect(within(table).getByRole("button", { name: "顧客訪問の予定詳細を開く" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const callsBeforeFilter = eventRequests(fetchMock).length;
    openDetails("表示する担当者");
    fireEvent.click(screen.getByRole("checkbox", { name: "佐藤 次郎 / 営業二課" }));
    expect(screen.queryByRole("rowheader", { name: /佐藤 次郎/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "担当" })).toHaveAttribute("aria-pressed", "true");
    expect(eventRequests(fetchMock)).toHaveLength(callsBeforeFilter);

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(3));
    const nextUrl = new URL(String(eventRequests(fetchMock).at(-1)?.[0]), "https://example.com");
    const expected = getCalendarRange("members", new Date(new Date().setDate(new Date().getDate() + 7)));
    expect(nextUrl.searchParams.get("start")).toBe(expected.start.toISOString());
    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(4));
    expect(screen.getByRole("button", { name: "担当" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "月" }));
    await waitFor(() => expect(eventRequests(fetchMock)).toHaveLength(5));

    const dayLabel = format(new Date(), "yyyy年M月d日");
    const callsBeforeSelection = eventRequests(fetchMock).length;
    fireEvent.click(selectedDay(dayLabel, 1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    vi.useFakeTimers();
    const dayButton = selectedDay(dayLabel, 1);
    fireEvent.pointerDown(dayButton, { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 20, clientY: 20 });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(dayButton, { pointerType: "touch", pointerId: 1 });
    const dialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(dialog).not.toHaveClass("desktopDayScheduleDialog");
    expect(within(dialog).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("table")).not.toBeInTheDocument();
    const agenda = within(dialog).getByRole("region", { name: "選択日の予定" });
    openAgendaMember(agenda, member.displayName, 1);
    fireEvent.click(within(agenda).getByRole("button", { name: /顧客訪問/ }));
    expect(screen.queryByRole("dialog", { name: "日付の予定" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "予定の詳細" })).toHaveTextContent("Google");
    expect(eventRequests(fetchMock)).toHaveLength(callsBeforeSelection);
  });

  it("日付ダイアログを開いたまま画面幅が変わると表示形式だけ切り替わる", async () => {
    vi.useRealTimers();
    let isNarrow = false;
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return isNarrow; },
      media: "(max-width: 760px)",
      addEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => { onChange = listener; },
      removeEventListener: vi.fn(),
    })));
    const auth = captureAuthState();
    installApiFetch({ events: { events: [event] } });
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    fireEvent.click(selectedDay(format(new Date(), "yyyy年M月d日"), 1));
    expect(screen.getByRole("dialog", { name: "日付の予定" })).toHaveClass("desktopDayScheduleDialog");
    isNarrow = true;
    await act(async () => onChange?.({ matches: true } as MediaQueryListEvent));
    const mobileDialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(mobileDialog).not.toHaveClass("desktopDayScheduleDialog");
    expect(within(mobileDialog).getByRole("region", { name: "選択日の予定" })).toBeInTheDocument();
    isNarrow = false;
    await act(async () => onChange?.({ matches: false } as MediaQueryListEvent));
    const desktopDialog = screen.getByRole("dialog", { name: "日付の予定" });
    expect(desktopDialog).toHaveClass("desktopDayScheduleDialog");
    expect(within(desktopDialog).getByRole("table", { name: "担当者別の時間割" })).toBeInTheDocument();
    closeDayDialog();
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

    expectEventVisible("顧客訪問");
    openDetails("表示する担当者");
    const demoMemberCheckbox = screen.getByRole("checkbox", { name: "田中 花子" });
    expect(demoMemberCheckbox).toBeChecked();
    const eventCallsBeforeSelection = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("/api/events")).length;
    fireEvent.click(demoMemberCheckbox);
    expectEventAbsent("顧客訪問");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")))
      .toHaveLength(eventCallsBeforeSelection);
    fireEvent.click(screen.getByRole("button", { name: "全員を選択" }));
    expectEventVisible("顧客訪問");
    expect(screen.queryByRole("link", { name: "Googleカレンダー接続" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/members")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/me/calendar-connection")).toHaveLength(0);

    let lastEventUrl = String(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")).at(-1)?.[0]);
    expect(lastEventUrl).toContain("start=2026-05-31T15%3A00%3A00.000Z");
    expect(selectedDay("2026年6月19日", 1)).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    await act(async () => {});
    lastEventUrl = String(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events")).at(-1)?.[0]);
    expect(lastEventUrl).toContain("start=2026-06-28T15%3A00%3A00.000Z");
    expect(lastEventUrl).toContain("end=2026-08-02T15%3A00%3A00.000Z");
    expect(selectedDay("2026年7月1日", 0)).toHaveAttribute("aria-pressed", "true");
    const eventCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/events"));
    expect(eventCalls).toHaveLength(2);
    for (const [, init] of eventCalls) {
      expect(init).toMatchObject({ headers: { "x-demo-email": "admin@example.co.jp" } });
    }

    fireEvent.click(screen.getByRole("button", { name: "前の期間" }));
    await act(async () => {});
    expect(selectedDay("2026年6月19日", 1)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    await act(async () => {});
    expect(selectedDay("2026年6月19日", 1)).toHaveAttribute("aria-pressed", "true");
    expect(eventRequests(fetchMock)).toHaveLength(5);
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

    expect((await screen.findAllByText("担当者一覧を取得できませんでした。")).length).toBeGreaterThan(0);
    await screen.findAllByText("顧客訪問");
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

    expect((await screen.findAllByText("担当者一覧を取得できませんでした。")).length).toBeGreaterThan(0);
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
    expectEventAbsent("顧客訪問");
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

  it("月取得500なら週別に再取得し、各週1000件以内の合計1001件を表示する", async () => {
    const auth = captureAuthState();
    const weeklyRanges: Array<{ start: Date; end: Date; count: number }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (!url.startsWith("/api/events")) throw new Error(`unexpected request: ${url}`);
      const params = new URL(url, "http://localhost").searchParams;
      const start = new Date(params.get("start")!);
      const end = new Date(params.get("end")!);
      if (end.getTime() - start.getTime() > 7 * 24 * 60 * 60 * 1000) {
        return Promise.resolve(jsonResponse({ error: "too many events" }, 500));
      }
      const week = weeklyRanges.length;
      const count = week === 0 ? 201 : 200;
      weeklyRanges.push({ start, end, count });
      const day = format(start, "yyyy-MM-dd");
      const events = Array.from({ length: count }, (_, index): NormalizedEvent => ({
        ...event,
        eventId: `google:${memberId}:week-${week}-${index}`,
        sourceEventId: `week-${week}-${index}`,
        title: `週${week}予定${index}`,
        start: `${day}T09:00:00+09:00`,
        end: `${day}T10:00:00+09:00`,
      }));
      return Promise.resolve(jsonResponse({ events }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(screen.getByText("1001件", { selector: ".countBadge" })).toBeInTheDocument();
    expect(weeklyRanges).toHaveLength(5);
    expect(weeklyRanges.every(({ count }) => count <= 1000)).toBe(true);
    for (const { start, end } of weeklyRanges) {
      expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    }
    expect(eventRequests(fetchMock)).toHaveLength(6);
    const monthParams = new URL(String(eventRequests(fetchMock)[0][0]), "http://localhost").searchParams;
    expect(weeklyRanges[0].start.toISOString()).toBe(monthParams.get("start"));
    expect(weeklyRanges.at(-1)?.end.toISOString()).toBe(monthParams.get("end"));
    for (let index = 1; index < weeklyRanges.length; index += 1) {
      expect(weeklyRanges[index].start.toISOString()).toBe(weeklyRanges[index - 1].end.toISOString());
    }
  });

  it("週境界の同一eventIdだけを統合し、予定元が違う同名予定は残す", async () => {
    const auth = captureAuthState();
    const sharedGoogle: NormalizedEvent = {
      ...event,
      title: "同名の商談",
      start: "2026-06-07T23:00:00+09:00",
      end: "2026-06-08T01:00:00+09:00",
    };
    const sharedMicrosoft: NormalizedEvent = {
      ...sharedGoogle,
      eventId: `microsoft:${memberId}:m-1`,
      source: "microsoft",
      sourceEventId: "m-1",
      calendarId: "outlook",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (!url.startsWith("/api/events")) throw new Error(`unexpected request: ${url}`);
      const params = new URL(url, "http://localhost").searchParams;
      const start = new Date(params.get("start")!);
      const end = new Date(params.get("end")!);
      if (end.getTime() - start.getTime() > 7 * 24 * 60 * 60 * 1000) {
        return Promise.resolve(jsonResponse({ error: "too many events" }, 500));
      }
      const weekStart = format(start, "yyyy-MM-dd");
      return Promise.resolve(jsonResponse({ events: weekStart === "2026-06-01" || weekStart === "2026-06-08"
        ? [sharedGoogle, sharedMicrosoft] : [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));

    expect(screen.getByText("2件", { selector: ".countBadge" })).toBeInTheDocument();
    fireEvent.click(selectedDay("2026年6月7日", 2));
    closeDayDialog();
    const agenda = screen.getByRole("region", { name: "選択日の予定" });
    openAgendaMember(agenda, "田中 花子", 2);
    expect(within(agenda).getAllByText("同名の商談")).toHaveLength(2);
  });

  it.each([
    [500, { error: "week failed" }],
    [401, { error: "unauthorized" }],
    [403, { error: "forbidden" }],
    [200, { events: [{ ...event, attendees: [] }] }],
  ])("週取得の失敗・不正応答(status %i)では成功週を部分表示しない", async (failureStatus, failureBody) => {
    const auth = captureAuthState();
    const failedWeek = deferred<Response>();
    const partialEvent: NormalizedEvent = {
      ...event,
      eventId: `google:${memberId}:partial`,
      sourceEventId: "partial",
      title: "部分表示してはいけない予定",
      start: "2026-06-01T09:00:00+09:00",
      end: "2026-06-01T10:00:00+09:00",
    };
    let weeklyCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/members") return Promise.resolve(jsonResponse({ members: [member] }));
      if (url === "/api/me/calendar-connection") return Promise.resolve(jsonResponse({ registered: false }));
      if (!url.startsWith("/api/events")) throw new Error(`unexpected request: ${url}`);
      const params = new URL(url, "http://localhost").searchParams;
      const start = new Date(params.get("start")!);
      const end = new Date(params.get("end")!);
      if (end.getTime() - start.getTime() > 7 * 24 * 60 * 60 * 1000) {
        return Promise.resolve(jsonResponse({ error: "too many events" }, 500));
      }
      weeklyCalls += 1;
      if (weeklyCalls === 1) return Promise.resolve(jsonResponse({ events: [partialEvent] }));
      if (weeklyCalls === 2) return failedWeek.promise;
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    await act(async () => {});

    expect(weeklyCalls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("予定を読み込んでいます…")).toBeInTheDocument();
    expectEventAbsent("部分表示してはいけない予定");
    await act(async () => failedWeek.resolve(jsonResponse(failureBody, failureStatus)));
    expect(screen.getByText("予定の取得に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expectEventAbsent("部分表示してはいけない予定");
  });

  it("月送りで新requestがpending・errorでも旧月の予定を即時に隠す", async () => {
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
    await screen.findAllByText("顧客訪問");

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));

    expectEventAbsent("顧客訪問");
    expect(screen.getByText("予定を読み込んでいます…")).toBeInTheDocument();
    await act(async () => nextEvents.resolve(jsonResponse({ error: "raw-next-month" }, 500)));
    expect(await screen.findByText("予定の取得に失敗しました。時間をおいて再度お試しください。")).toBeInTheDocument();
    expectEventAbsent("顧客訪問");
  });

  it("月を連続移動してabortされた旧requestが完了しても旧予定を復元しない", async () => {
    vi.useRealTimers();
    const auth = captureAuthState();
    const abortedEvents = deferred<Response>();
    const nextMonth = new Date(`${visibleDate}T12:00:00+09:00`);
    nextMonth.setMonth(nextMonth.getMonth() + 2, 1);
    const microsoftEvent = {
      ...event,
      eventId: `microsoft:${memberId}:m-1`,
      source: "microsoft" as const,
      sourceEventId: "m-1",
      calendarId: "outlook",
      title: "Microsoft予定",
      start: `${format(nextMonth, "yyyy-MM-dd")}T09:30:00+09:00`,
      end: `${format(nextMonth, "yyyy-MM-dd")}T10:30:00+09:00`,
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
        return Promise.resolve(jsonResponse({ events: [microsoftEvent] }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleApp />);
    await act(async () => auth.emit(signedInUser()));
    await screen.findAllByText("顧客訪問");

    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    expectEventAbsent("顧客訪問");
    await waitFor(() => expect(eventRequests).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "次の期間" }));
    await screen.findAllByText("Microsoft予定");
    await act(async () => abortedEvents.resolve(jsonResponse({ events: [event] })));

    expectEventVisible("Microsoft予定");
    expectEventAbsent("顧客訪問");
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
    openDetails("表示する担当者");
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
    openDetails("表示する担当者");
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
    await screen.findAllByText("顧客訪問");

    await act(async () => auth.emit(null));
    expect(screen.getByRole("button", { name: "Microsoft でサインイン" })).toBeInTheDocument();
    expectEventAbsent("顧客訪問");
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
