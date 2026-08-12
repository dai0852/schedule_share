// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminMembers } from "./AdminMembers";

const firebaseMocks = vi.hoisted(() => ({
  getClientAuth: vi.fn(() => ({ name: "test-auth" })),
  getMicrosoftProvider: vi.fn(() => ({ providerId: "microsoft.com" })),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
}));

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: firebaseMocks.getClientAuth,
  getMicrosoftProvider: firebaseMocks.getMicrosoftProvider,
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: firebaseMocks.onAuthStateChanged,
  signInWithPopup: firebaseMocks.signInWithPopup,
}));

const member = {
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

const statuses = [{
  memberId: "member-1",
  provider: "google",
  status: "success",
  lastStartedAt: "2026-08-11T08:55:00.000Z",
  lastSucceededAt: "2026-08-11T09:00:00.000Z",
  lastErrorCode: null,
  lastErrorSummary: null,
  updatedAt: "2026-08-11T09:00:00.000Z",
}];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chunkedResponse(chunks: Uint8Array[], status = 200): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signedInUser(token = "firebase-token") {
  return { getIdToken: vi.fn().mockResolvedValue(token) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("AdminMembers", () => {
  beforeEach(() => {
    firebaseMocks.getClientAuth.mockClear();
    firebaseMocks.getMicrosoftProvider.mockClear();
    firebaseMocks.onAuthStateChanged.mockReset();
    firebaseMocks.signInWithPopup.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("認証初期化中から管理者一覧へ遷移し、購読を解除する", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    const unsubscribe = vi.fn();
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return unsubscribe;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ members: [member], syncStatuses: statuses })));

    const view = render(<AdminMembers />);
    expect(screen.getByText("ログイン状態を確認しています…")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => handleUser?.(signedInUser()));

    expect(await screen.findByText("佐藤 花子")).toBeInTheDocument();
    expect(screen.getByText("hanako@example.com")).toBeInTheDocument();
    expect(screen.getByText("接続済み")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "営業メンバー一覧" });
    expect(within(table).getAllByRole("rowgroup")).toHaveLength(2);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(6);
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getAllByRole("cell")).toHaveLength(6);
    expect(fetch).toHaveBeenCalledWith("/api/admin/members", {
      headers: { authorization: "Bearer firebase-token" },
    });

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("未ログインなら管理APIを呼ばず、この画面からMicrosoftログインを開始できる", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(null);
      return vi.fn();
    });
    firebaseMocks.signInWithPopup.mockResolvedValue({ user: signedInUser() });
    vi.stubGlobal("fetch", vi.fn());

    render(<AdminMembers />);

    expect(await screen.findByText("管理画面を利用するにはログインしてください。")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Microsoft でサインイン" }));
    await waitFor(() => expect(firebaseMocks.signInWithPopup).toHaveBeenCalledWith(
      { name: "test-auth" },
      { providerId: "microsoft.com" },
    ));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("未ログイン画面でMicrosoftログインの二重起動を防ぐ", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(null);
      return vi.fn();
    });
    firebaseMocks.signInWithPopup.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn());

    render(<AdminMembers />);
    const button = await screen.findByRole("button", { name: "Microsoft でサインイン" });
    fireEvent.click(button);
    const pendingButton = screen.getByRole("button", { name: "サインインしています…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(firebaseMocks.signInWithPopup).toHaveBeenCalledTimes(1);
  });

  it("両providerの安全な同期状態だけを表示し、生エラーをDOMへ出さない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      members: [member],
      syncStatuses: [
        statuses[0],
        {
          ...statuses[0],
          provider: "microsoft",
          status: "error",
          lastSucceededAt: null,
          lastErrorCode: "permission_denied",
          lastErrorSummary: "Microsoftカレンダーの読み取り権限を確認してください。",
          lastErrorMessage: "Bearer raw-token raw@example.com https://internal.example.com",
        },
      ],
    })));

    render(<AdminMembers />);

    expect(await screen.findByText("佐藤 花子")).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /佐藤 花子/ });
    expect(within(row).getByText("Google")).toBeInTheDocument();
    expect(within(row).getByText("Microsoft")).toBeInTheDocument();
    expect(within(row).getByText(/Microsoftカレンダーの読み取り権限を確認してください。/)).toBeInTheDocument();
    expect(row).not.toHaveTextContent("raw-token");
    expect(row).not.toHaveTextContent("raw@example.com");
    expect(row).not.toHaveTextContent("internal.example.com");
  });

  it("フォームからBearer認証付きで登録し一覧へ追加する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [], syncStatuses: [] }))
      .mockResolvedValueOnce(jsonResponse({ member }, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("登録済みメンバーはいません。");
    fireEvent.change(screen.getByLabelText("氏名"), { target: { value: "佐藤 花子" } });
    fireEvent.change(screen.getByLabelText("部署"), { target: { value: "営業一課" } });
    fireEvent.change(screen.getByLabelText("Microsoftメールアドレス"), { target: { value: "hanako@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "営業メンバーを追加" }));

    expect(await screen.findByText("営業メンバーを追加しました。")).toBeInTheDocument();
    expect(screen.getByText("佐藤 花子")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/members", {
      method: "POST",
      headers: {
        authorization: "Bearer firebase-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "佐藤 花子",
        department: "営業一課",
        microsoftEmail: "hanako@example.com",
      }),
    });
  });

  it("登録処理中の二重送信を防ぐ", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [], syncStatuses: [] }))
      .mockReturnValueOnce(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("登録済みメンバーはいません。");
    fireEvent.change(screen.getByLabelText("氏名"), { target: { value: "佐藤 花子" } });
    fireEvent.change(screen.getByLabelText("部署"), { target: { value: "営業一課" } });
    fireEvent.change(screen.getByLabelText("Microsoftメールアドレス"), { target: { value: "hanako@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "営業メンバーを追加" }));

    const pendingButton = screen.getByRole("button", { name: "追加しています…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("activeとMicrosoft同期をPATCHで切り替える", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const inactive = { ...member, active: false };
    const syncDisabled = { ...inactive, microsoftSyncEnabled: false };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: [] }))
      .mockResolvedValueOnce(jsonResponse({ member: inactive }))
      .mockResolvedValueOnce(jsonResponse({ member: syncDisabled }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "佐藤 花子を無効化" }));
    await screen.findByRole("button", { name: "佐藤 花子を有効化" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/members/member-1", {
      method: "PATCH",
      headers: {
        authorization: "Bearer firebase-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ active: false }),
    });

    fireEvent.click(screen.getByRole("button", { name: "佐藤 花子のMicrosoft同期を無効化" }));
    await screen.findByRole("button", { name: "佐藤 花子のMicrosoft同期を有効化" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/admin/members/member-1", {
      method: "PATCH",
      headers: {
        authorization: "Bearer firebase-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ microsoftSyncEnabled: false }),
    });
  });

  it("pending POSTの旧認証応答をlogoutと再ログイン後に反映しない", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return vi.fn();
    });
    const pendingPost = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [], syncStatuses: [] }))
      .mockReturnValueOnce(pendingPost.promise)
      .mockResolvedValueOnce(jsonResponse({ members: [], syncStatuses: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await act(async () => handleUser?.(signedInUser("token-a")));
    await screen.findByText("登録済みメンバーはいません。");
    fireEvent.change(screen.getByLabelText("氏名"), { target: { value: "佐藤 花子" } });
    fireEvent.change(screen.getByLabelText("部署"), { target: { value: "営業一課" } });
    fireEvent.change(screen.getByLabelText("Microsoftメールアドレス"), { target: { value: "hanako@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "営業メンバーを追加" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => handleUser?.(null));
    expect(screen.getByText("管理画面を利用するにはログインしてください。")).toBeInTheDocument();
    await act(async () => pendingPost.resolve(jsonResponse({ member }, 201)));
    await act(async () => handleUser?.(signedInUser("token-b")));

    expect(await screen.findByText("登録済みメンバーはいません。")).toBeInTheDocument();
    expect(screen.queryByText("営業メンバーを追加しました。")).not.toBeInTheDocument();
    expect(screen.queryByText("佐藤 花子")).not.toBeInTheDocument();
  });

  it("pending PATCHの旧認証応答を別userへ切替後に反映しない", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return vi.fn();
    });
    const pendingPatch = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: [] }))
      .mockReturnValueOnce(pendingPatch.promise)
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await act(async () => handleUser?.(signedInUser("token-a")));
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "佐藤 花子を無効化" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => handleUser?.(signedInUser("token-b")));
    await screen.findByRole("button", { name: "佐藤 花子を無効化" });
    await act(async () => pendingPatch.resolve(jsonResponse({ member: { ...member, active: false } })));

    expect(screen.getByRole("button", { name: "佐藤 花子を無効化" })).toBeInTheDocument();
    expect(screen.queryByText("メンバー設定を更新しました。")).not.toBeInTheDocument();
  });

  it("403とその他のAPIエラーを安全に表示する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "internal details" }, 403)));

    const view = render(<AdminMembers />);
    expect(await screen.findByText("管理者権限が必要です。")).toBeInTheDocument();
    expect(screen.queryByText("internal details")).not.toBeInTheDocument();

    view.unmount();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "safe api error" }, 500)));
    render(<AdminMembers />);
    expect(await screen.findByText("メンバー一覧を取得できませんでした。")).toBeInTheDocument();
    expect(screen.queryByText("safe api error")).not.toBeInTheDocument();
  });

  it("手動同期をBearer認証で実行し、更新したtokenでメンバーと同期状態を再取得する", async () => {
    const user = signedInUser();
    user.getIdToken
      .mockResolvedValueOnce("initial-token")
      .mockResolvedValueOnce("sync-token")
      .mockResolvedValueOnce("refreshed-token");
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(user);
      return vi.fn();
    });
    const refreshedStatus = { ...statuses[0], lastSucceededAt: "2026-08-11T10:00:00.000Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        members: 1,
        succeededProviders: 2,
        failedProviders: 0,
        skippedProviders: 0,
      }))
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: [refreshedStatus] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByText("手動同期が完了しました。")).toBeInTheDocument();
    expect(screen.getByText(/成功: 2026\/8\/11 19:00:00/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/sync", {
      method: "POST",
      headers: { authorization: "Bearer sync-token" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/admin/members", {
      headers: { authorization: "Bearer refreshed-token" },
    });
    expect(user.getIdToken).toHaveBeenCalledTimes(3);
  });

  it("手動同期中はボタンを無効化して二重送信を防ぐ", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const pendingSync = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockReturnValueOnce(pendingSync.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    const pendingButton = screen.getByRole("button", { name: "同期しています…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it.each([
    [
      "locked",
      { status: "locked", members: 0, succeededProviders: 0, failedProviders: 0, skippedProviders: 0 },
      "別の同期が実行中です。しばらくしてから再度お試しください。",
    ],
    [
      "partial",
      { status: "completed", members: 1, succeededProviders: 1, failedProviders: 1, skippedProviders: 0 },
      "手動同期は完了しましたが、一部の予定元で同期に失敗しました。",
    ],
  ])("手動同期の%sを固定メッセージで表示して一覧を再取得する", async (_name, summary, message) => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse(summary))
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("手動同期の未知fieldを拒否し、生値を表示・再取得しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        members: 1,
        succeededProviders: 2,
        failedProviders: 0,
        skippedProviders: 0,
        rawError: "Bearer raw-token raw@example.com",
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("手動同期を開始できませんでした。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body).not.toHaveTextContent("raw-token");
    expect(document.body).not.toHaveTextContent("raw@example.com");
  });

  it("64KiBを超えるchunked手動同期応答を途中で拒否する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const encoder = new TextEncoder();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(chunkedResponse([
        encoder.encode(`{"status":"completed","members":1,"succeededProviders":2,"failedProviders":0,"skippedProviders":0,"padding":"${"a".repeat(40_000)}`),
        encoder.encode(`${"b".repeat(30_000)}"}`),
      ]));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("手動同期を開始できませんでした。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("64KiB以内のchunked手動同期JSONを読み取る", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const serialized = JSON.stringify({
      status: "completed",
      members: 1,
      succeededProviders: 2,
      failedProviders: 0,
      skippedProviders: 0,
    });
    const bytes = new TextEncoder().encode(serialized);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(chunkedResponse([bytes.slice(0, 17), bytes.slice(17, 61), bytes.slice(61)]))
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByText("手動同期が完了しました。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["不正UTF-8", () => chunkedResponse([new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])])],
    ["不正JSON", () => chunkedResponse([new TextEncoder().encode("{\"status\":")])],
  ])("手動同期の%s本文を固定エラーへ変換する", async (_name, makeResponse) => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(makeResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("手動同期を開始できませんでした。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "ログインし直してください。"],
    [403, "管理者権限が必要です。"],
    [500, "手動同期を開始できませんでした。"],
  ])("手動同期の%sを安全な固定メッセージで表示する", async (status, message) => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({ error: "Bearer raw-token raw@example.com" }, status));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body).not.toHaveTextContent("raw-token");
    expect(document.body).not.toHaveTextContent("raw@example.com");
  });

  it("手動同期後の一覧再取得失敗を安全な固定メッセージで表示する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        members: 1,
        succeededProviders: 2,
        failedProviders: 0,
        skippedProviders: 0,
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "Bearer raw-token" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("同期状態を更新できませんでした。");
    expect(document.body).not.toHaveTextContent("raw-token");
  });

  it("手動同期後の不正な一覧応答をDOMへ反映しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        members: 1,
        succeededProviders: 2,
        failedProviders: 0,
        skippedProviders: 0,
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "Bearer raw-token" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("同期状態を更新できませんでした。");
    expect(screen.getByText("佐藤 花子")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-token");
  });

  it.each([
    ["member", { members: [{ ...member, displayName: 123, rawError: "Bearer raw-token" }], syncStatuses: statuses }],
    ["sync status", {
      members: [member],
      syncStatuses: [{ ...statuses[0], lastErrorCode: "permission_denied", lastErrorSummary: "Bearer raw-token" }],
    }],
  ])("手動同期後の不正な%s要素を拒否する", async (_name, refreshed) => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        members: 1,
        succeededProviders: 2,
        failedProviders: 0,
        skippedProviders: 0,
      }))
      .mockResolvedValueOnce(jsonResponse(refreshed));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("同期状態を更新できませんでした。");
    expect(screen.getByText("佐藤 花子")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-token");
  });

  it("再取得用tokenの更新失敗を固定メッセージで表示する", async () => {
    const user = signedInUser();
    user.getIdToken
      .mockResolvedValueOnce("initial-token")
      .mockResolvedValueOnce("sync-token")
      .mockRejectedValueOnce(new Error("Bearer raw-token"));
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(user);
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        members: 1,
        succeededProviders: 2,
        failedProviders: 0,
        skippedProviders: 0,
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("同期状態を更新できませんでした。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenCalledTimes(3);
    expect(document.body).not.toHaveTextContent("raw-token");
  });

  it("再取得用token待機中のlogout後に旧応答を反映しない", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    const pendingRefreshToken = deferred<string>();
    const userA = signedInUser();
    userA.getIdToken
      .mockResolvedValueOnce("initial-a")
      .mockResolvedValueOnce("sync-a")
      .mockReturnValueOnce(pendingRefreshToken.promise);
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        members: 1,
        succeededProviders: 2,
        failedProviders: 0,
        skippedProviders: 0,
      }))
      .mockResolvedValueOnce(jsonResponse({ members: [], syncStatuses: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await act(async () => handleUser?.(userA));
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));
    await waitFor(() => expect(userA.getIdToken).toHaveBeenCalledTimes(3));

    await act(async () => handleUser?.(null));
    await act(async () => pendingRefreshToken.resolve("stale-refresh-token"));
    await act(async () => handleUser?.(signedInUser("token-b")));

    expect(await screen.findByText("登録済みメンバーはいません。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/members", {
      headers: { authorization: "Bearer stale-refresh-token" },
    });
    expect(screen.queryByText("手動同期が完了しました。")).not.toBeInTheDocument();
  });

  it("pending手動同期の旧認証応答をlogoutと別userへの切替後に反映しない", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return vi.fn();
    });
    const pendingSync = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockReturnValueOnce(pendingSync.promise)
      .mockResolvedValueOnce(jsonResponse({ members: [], syncStatuses: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMembers />);
    await act(async () => handleUser?.(signedInUser("token-a")));
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => handleUser?.(null));
    await act(async () => pendingSync.resolve(jsonResponse({
      status: "completed",
      members: 1,
      succeededProviders: 2,
      failedProviders: 0,
      skippedProviders: 0,
    })));
    await act(async () => handleUser?.(signedInUser("token-b")));

    expect(await screen.findByText("登録済みメンバーはいません。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("手動同期が完了しました。")).not.toBeInTheDocument();
  });

  it("unmount後の手動同期応答を反映せず一覧再取得もしない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const pendingSync = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [member], syncStatuses: statuses }))
      .mockReturnValueOnce(pendingSync.promise);
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<AdminMembers />);
    await screen.findByText("佐藤 花子");
    fireEvent.click(screen.getByRole("button", { name: "手動同期を実行" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    view.unmount();

    await act(async () => pendingSync.resolve(jsonResponse({
      status: "completed",
      members: 1,
      succeededProviders: 2,
      failedProviders: 0,
      skippedProviders: 0,
    })));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
