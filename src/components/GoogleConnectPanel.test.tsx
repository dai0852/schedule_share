// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleConnectPanel } from "./GoogleConnectPanel";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chunkedResponse(body: string, status = 200) {
  const encoded = new TextEncoder().encode(body);
  const midpoint = Math.ceil(encoded.byteLength / 2);
  const chunks = [encoded.slice(0, midpoint), encoded.slice(midpoint)];
  let index = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
    },
    cancel,
  });
  return { response: new Response(stream, { status }), cancel };
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

describe("GoogleConnectPanel", () => {
  beforeEach(() => {
    firebaseMocks.getClientAuth.mockClear();
    firebaseMocks.getMicrosoftProvider.mockClear();
    firebaseMocks.onAuthStateChanged.mockReset();
    firebaseMocks.signInWithPopup.mockReset();
    window.history.replaceState({}, "", "/connect");
  });

  it("未認証なら共通Microsoftログイン画面を表示し、二重サインインを防ぐ", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(null);
      return vi.fn();
    });
    firebaseMocks.signInWithPopup.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn());

    render(<GoogleConnectPanel />);

    const signInButton = await screen.findByRole("button", { name: "Microsoft でサインイン" });
    fireEvent.click(signInButton);
    const pendingButton = screen.getByRole("button", { name: "サインインしています…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(firebaseMocks.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(firebaseMocks.signInWithPopup).toHaveBeenCalledWith(
      { name: "test-auth" },
      { providerId: "microsoft.com" },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Microsoftログイン失敗時は生エラーを隠して固定案内を表示する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(null);
      return vi.fn();
    });
    firebaseMocks.signInWithPopup.mockRejectedValue(new Error("Bearer raw-microsoft-secret"));
    vi.stubGlobal("fetch", vi.fn());

    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Microsoft でサインイン" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Microsoft 365でのログインに失敗しました。");
    expect(document.body).not.toHaveTextContent("raw-microsoft-secret");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Firebase認証の確定を待ってから接続状態を取得する", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    const unsubscribe = vi.fn();
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return unsubscribe;
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ registered: false }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<GoogleConnectPanel />);
    expect(screen.getByText("ログイン状態を確認しています…")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => handleUser?.(signedInUser()));
    expect(await screen.findByText("営業メンバーとして登録されていません")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/me/calendar-connection", expect.objectContaining({
      headers: { authorization: "Bearer firebase-token" },
    }));

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("未登録なら接続ボタンを表示しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ registered: false })));

    render(<GoogleConnectPanel />);

    expect(await screen.findByText("営業メンバーとして登録されていません")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Googleカレンダーを接続" })).not.toBeInTheDocument();
  });

  it("未接続なら接続ボタンを表示する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ registered: true, status: "not_connected" })));

    render(<GoogleConnectPanel />);

    expect(await screen.findByRole("button", { name: "Googleカレンダーを接続" })).toBeEnabled();
  });

  it("接続済みならGoogleメールと最終同期、解除ボタンを表示する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      registered: true,
      status: "connected",
      googleEmail: "personal@gmail.com",
      lastSucceededAt: "2026-08-11T01:15:00.000Z",
    })));

    render(<GoogleConnectPanel />);

    expect(await screen.findByText("personal@gmail.com")).toBeInTheDocument();
    expect(screen.getByText(/最終同期/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Googleカレンダーを再接続" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "接続解除" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "カレンダーを見る" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: "管理者コンソール" })).not.toBeInTheDocument();
  });

  it("サーバーが確認した管理者だけに管理者コンソールへの導線を表示する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      registered: true,
      canManageMembers: true,
      status: "connected",
      googleEmail: "personal@gmail.com",
    })));

    render(<GoogleConnectPanel />);

    expect(await screen.findByRole("link", { name: "カレンダーを見る" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "管理者コンソール" })).toHaveAttribute("href", "/admin");
  });

  it("再接続が必要なら固定案内と再接続ボタンを表示する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      registered: true,
      status: "reconnect_required",
      googleEmail: "personal@gmail.com",
      lastErrorSummary: "raw upstream secret",
    })));

    render(<GoogleConnectPanel />);

    expect(await screen.findByRole("button", { name: "Googleカレンダーを再接続" })).toBeEnabled();
    expect(screen.getByText("Googleカレンダーとの接続が無効になりました。再接続してください。")).toBeInTheDocument();
    expect(screen.queryByText("raw upstream secret")).not.toBeInTheDocument();
  });

  it("Bearer認証で接続を開始し、信頼済みGoogle URLだけへ遷移する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser("oauth-token"));
      return vi.fn();
    });
    const pendingStart = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "not_connected" }))
      .mockReturnValueOnce(pendingStart.promise);
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();

    render(<GoogleConnectPanel navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Googleカレンダーを接続" }));

    const pendingButton = screen.getByRole("button", { name: "接続を開始しています…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/google/oauth/start", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer oauth-token" },
    }));

    const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=client&state=safe-state";
    await act(async () => pendingStart.resolve(jsonResponse({ authorizationUrl })));
    expect(navigate).toHaveBeenCalledWith(authorizationUrl);
  });

  it("接続済みからBearer認証で再接続し、処理中は接続解除も無効にする", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser("reconnect-token"));
      return vi.fn();
    });
    const pendingStart = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockReturnValueOnce(pendingStart.promise);
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();

    render(<GoogleConnectPanel navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Googleカレンダーを再接続" }));

    expect(screen.getByRole("button", { name: "接続を開始しています…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "接続解除" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "接続を開始しています…" }));
    fireEvent.click(screen.getByRole("button", { name: "接続解除" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/google/oauth/start", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer reconnect-token" },
    }));

    const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=client&state=reconnect-state";
    await act(async () => pendingStart.resolve(jsonResponse({ authorizationUrl })));
    expect(navigate).toHaveBeenCalledWith(authorizationUrl);
  });

  it("安全でないauthorizationUrlを拒否し、生URLやAPIエラーを表示しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockResolvedValueOnce(jsonResponse({
        authorizationUrl: "javascript:alert('raw-oauth-secret')",
        error: "Bearer raw-api-token",
      }));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();

    render(<GoogleConnectPanel navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Googleカレンダーを再接続" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの接続を開始できませんでした");
    expect(navigate).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("raw-oauth-secret");
    expect(document.body).not.toHaveTextContent("raw-api-token");
  });

  it("OAuth callbackの成功とエラー理由をallowlistした固定文言だけで案内する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" })));
    window.history.replaceState({}, "", "/connect?google=connected&source=settings#calendar");

    const successView = render(<GoogleConnectPanel />);
    expect(await screen.findByText("Googleカレンダーを接続しました。")).toBeInTheDocument();
    expect(await screen.findByText("person@gmail.com")).toBeInTheDocument();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/connect?source=settings#calendar",
    );

    successView.unmount();
    window.history.replaceState({}, "", "/connect?google=error&reason=account_mismatch&detail=personal%40gmail.com");
    render(<GoogleConnectPanel />);
    expect(await screen.findByText("以前と同じGoogleアカウントで再接続してください。")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("personal@gmail.com");
    expect(window.location.search).toBe("?detail=personal%40gmail.com");
  });

  it("OAuth接続後の初回同期pendingを固定案内し、query値を一度だけ消費する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      registered: true,
      status: "connected",
      googleEmail: "person@gmail.com",
    })));
    window.history.replaceState({}, "", "/connect?google=connected&sync=pending&source=settings");

    render(<GoogleConnectPanel />);

    expect(await screen.findByText("Googleカレンダーを接続しました。予定は次回の同期で反映されます。")).toBeInTheDocument();
    expect(window.location.search).toBe("?source=settings");
  });

  it.each([
    ["/connect?google=connected", "Googleカレンダーを接続しました。"],
    ["/connect?google=error&reason=account_mismatch", "以前と同じGoogleアカウントで再接続してください。"],
  ])("StrictModeでもcallback通知を最終DOMに残し、URL値だけを一度消費する", async (url, message) => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      registered: true,
      status: "connected",
      googleEmail: "person@gmail.com",
    })));
    window.history.replaceState({}, "", url);

    render(
      <StrictMode>
        <GoogleConnectPanel />
      </StrictMode>,
    );

    expect(await screen.findByText("person@gmail.com")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("未知のcallback reasonとAPI応答は安全な固定案内に置き換える", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      registered: true,
      status: "connected",
      googleEmail: "not-an-email Bearer raw-secret",
      lastErrorSummary: "https://internal.example.com token-secret",
    })));
    window.history.replaceState({}, "", "/connect?google=error&reason=raw-server-secret");

    render(<GoogleConnectPanel />);

    expect(await screen.findByText("Google連携を完了できませんでした。もう一度お試しください。")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-server-secret");
    expect(document.body).not.toHaveTextContent("raw-secret");
    expect(document.body).not.toHaveTextContent("internal.example.com");
    expect(window.location.search).toBe("");
  });

  it("callback通知を接続操作開始時に消去する", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const pendingStart = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockReturnValueOnce(pendingStart.promise));
    window.history.replaceState({}, "", "/connect?google=error&reason=access_denied");

    render(<GoogleConnectPanel navigate={vi.fn()} />);
    expect(await screen.findByText("Googleカレンダーの接続は完了しませんでした。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Googleカレンダーを再接続" }));

    expect(screen.queryByText("Googleカレンダーの接続は完了しませんでした。")).not.toBeInTheDocument();
  });

  it("画面内確認を経てBearer認証で接続解除し、確認中と送信中の二重操作を防ぐ", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser("delete-token"));
      return vi.fn();
    });
    const pendingDelete = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockReturnValueOnce(pendingDelete.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "接続解除" }));
    const disconnectButton = screen.getByRole("button", { name: "接続解除" });
    expect(screen.getByRole("region", { name: "Googleカレンダーの接続を解除しますか？" })).toBeInTheDocument();
    expect(document.activeElement).toBe(disconnectButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "解除をキャンセル" }));
    await waitFor(() => expect(document.activeElement).toBe(disconnectButton));
    expect(screen.queryByRole("region", { name: "Googleカレンダーの接続を解除しますか？" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "接続解除" }));
    fireEvent.click(screen.getByRole("button", { name: "Googleカレンダーの接続を解除" }));
    const pendingButton = screen.getByRole("button", { name: "解除しています…" });
    expect(pendingButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Googleカレンダーを再接続" })).toBeDisabled();
    fireEvent.click(pendingButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/google/connection", expect.objectContaining({
      method: "DELETE",
      headers: { authorization: "Bearer delete-token" },
    }));

    await act(async () => pendingDelete.resolve(new Response(null, { status: 204 })));
    expect(await screen.findByRole("button", { name: "Googleカレンダーを接続" })).toBeEnabled();
    expect(screen.getByText("Googleカレンダーの接続を解除しました。")).toBeInTheDocument();
  });

  it("callback成功通知を解除開始時に消し、成功後と再読込後にも再表示しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser("delete-token"));
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "not_connected" }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/connect?google=connected");

    const firstView = render(<GoogleConnectPanel />);
    expect(await screen.findByText("Googleカレンダーを接続しました。")).toBeInTheDocument();
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "接続解除" }));
    expect(screen.queryByText("Googleカレンダーを接続しました。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Googleカレンダーの接続を解除" }));
    expect(await screen.findByText("Googleカレンダーの接続を解除しました。")).toBeInTheDocument();

    firstView.unmount();
    render(<GoogleConnectPanel />);
    expect(await screen.findByRole("button", { name: "Googleカレンダーを接続" })).toBeEnabled();
    expect(screen.queryByText("Googleカレンダーを接続しました。")).not.toBeInTheDocument();
  });

  it("chunked GETが16KiBを超えたらstreamをcancelし、生データを表示しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const oversized = chunkedResponse(JSON.stringify({
      registered: true,
      status: "not_connected",
      padding: "秘".repeat(6_000),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oversized.response));

    render(<GoogleConnectPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの接続状態を取得できませんでした");
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent("秘密");
  });

  it("chunked OAuth応答が16KiBを超えたら遷移しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const oversized = chunkedResponse(JSON.stringify({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=safe",
      padding: "秘".repeat(6_000),
    }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "not_connected" }))
      .mockResolvedValueOnce(oversized.response));
    const navigate = vi.fn();

    render(<GoogleConnectPanel navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Googleカレンダーを接続" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの接続を開始できませんでした");
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("chunked DELETE応答が16KiBを超えたら解除成功にせずstreamをcancelする", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const oversized = chunkedResponse(JSON.stringify({ padding: "秘".repeat(6_000) }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockResolvedValueOnce(oversized.response));

    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "接続解除" }));
    fireEvent.click(screen.getByRole("button", { name: "Googleカレンダーの接続を解除" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの接続を解除できませんでした");
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("person@gmail.com")).toBeInTheDocument();
  });

  it("接続解除APIの生エラーを表示しない", async () => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockResolvedValueOnce(jsonResponse({ error: "Bearer delete-secret person@gmail.com" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "接続解除" }));
    fireEvent.click(screen.getByRole("button", { name: "Googleカレンダーの接続を解除" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの接続を解除できませんでした");
    expect(document.body).not.toHaveTextContent("delete-secret");
  });

  it("ユーザー切替時に前ユーザーのGETをabortし、古い応答を反映しない", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return vi.fn();
    });
    const firstResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "second@gmail.com" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<GoogleConnectPanel />);
    await act(async () => handleUser?.(signedInUser("token-a")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;

    await act(async () => handleUser?.(signedInUser("token-b")));
    expect(await screen.findByText("second@gmail.com")).toBeInTheDocument();
    expect(firstSignal.aborted).toBe(true);
    await act(async () => firstResponse.resolve(jsonResponse({ registered: false })));
    expect(screen.getByText("second@gmail.com")).toBeInTheDocument();
    expect(screen.queryByText("営業メンバーとして登録されていません")).not.toBeInTheDocument();
  });

  it("ログアウト後にpending OAuth応答を破棄して遷移しない", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return vi.fn();
    });
    const pendingStart = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ registered: true, status: "connected", googleEmail: "person@gmail.com" }))
      .mockReturnValueOnce(pendingStart.promise);
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();

    render(<GoogleConnectPanel navigate={navigate} />);
    await act(async () => handleUser?.(signedInUser("token-a")));
    fireEvent.click(await screen.findByRole("button", { name: "Googleカレンダーを再接続" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const startSignal = (fetchMock.mock.calls[1][1] as RequestInit).signal as AbortSignal;

    await act(async () => handleUser?.(null));
    expect(screen.getByRole("button", { name: "Microsoft でサインイン" })).toBeInTheDocument();
    expect(startSignal.aborted).toBe(true);
    await act(async () => pendingStart.resolve(jsonResponse({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=stale",
    })));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("アンマウント時に購読解除とpending GETのabortを行う", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    const unsubscribe = vi.fn();
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      handleUser = next;
      return unsubscribe;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    const view = render(<GoogleConnectPanel />);
    await act(async () => handleUser?.(signedInUser()));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).signal as AbortSignal;
    view.unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
  });

  it("認証購読エラー時にpending GETをabortし、古い接続状態を反映しない", async () => {
    let handleUser: ((user: ReturnType<typeof signedInUser> | null) => void) | undefined;
    let handleAuthError: (() => void) | undefined;
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next, error) => {
      handleUser = next;
      handleAuthError = error;
      return vi.fn();
    });
    const pendingResponse = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pendingResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<GoogleConnectPanel />);
    await act(async () => handleUser?.(signedInUser()));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;

    await act(async () => handleAuthError?.());
    expect(screen.getByText("ログイン状態を確認できませんでした。ページを再読み込みしてください。")).toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    await act(async () => pendingResponse.resolve(jsonResponse({
      registered: true,
      status: "connected",
      googleEmail: "stale@gmail.com",
    })));
    expect(screen.queryByText("stale@gmail.com")).not.toBeInTheDocument();
  });

  it.each([
    [401, "ログインが必要です。Microsoft 365アカウントでログインしてください。"],
    [403, "このアカウントではGoogleカレンダー連携を利用できません。"],
    [500, "Googleカレンダーの接続状態を取得できませんでした。時間をおいて再度お試しください。"],
  ])("GETが%sなら生エラーを出さず固定案内する", async (status, expectedMessage) => {
    firebaseMocks.onAuthStateChanged.mockImplementation((_auth, next) => {
      next(signedInUser());
      return vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Bearer raw-get-secret" }, status)));

    render(<GoogleConnectPanel />);

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-get-secret");
  });
});
