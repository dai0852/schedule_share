"use client";

import { CalendarCheck2, ExternalLink, KeyRound, Unplug } from "lucide-react";
import { onAuthStateChanged, signInWithPopup, type User } from "firebase/auth";
import { useEffect, useRef, useState, type RefObject } from "react";

import { AppNavigation } from "@/components/AppNavigation";
import { LoginScreen } from "@/components/LoginScreen";
import type { GoogleConnectionStatus } from "@/domain/member";
import { getClientAuth, getMicrosoftProvider } from "@/lib/firebase/client";

type ConnectionView =
  | { registered: false; canManageMembers: boolean }
  | {
    registered: true;
    canManageMembers: boolean;
    status: GoogleConnectionStatus;
    googleEmail?: string;
    lastSucceededAt?: string;
  };

type LoadState =
  | { kind: "auth-loading" }
  | { kind: "signed-out" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; connection: ConnectionView };

interface GoogleConnectPanelProps {
  navigate?: (authorizationUrl: string) => void;
}

type Operation = "starting" | "disconnecting" | null;
type OAuthNotice = { error: boolean; message: string } | null;

export function GoogleConnectPanel({
  navigate = (authorizationUrl) => window.location.assign(authorizationUrl),
}: GoogleConnectPanelProps = {}) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "auth-loading" });
  const [user, setUser] = useState<User | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [oauthNotice, setOAuthNotice] = useState<OAuthNotice>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const authGeneration = useRef(0);
  const operationPending = useRef(false);
  const operationController = useRef<AbortController | null>(null);
  const signInPending = useRef(false);
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);
  const restoreDisconnectFocus = useRef(false);
  const oauthNoticeConsumed = useRef(false);

  useEffect(() => {
    if (oauthNoticeConsumed.current) return;
    oauthNoticeConsumed.current = true;
    const notice = consumeOAuthNotice();
    if (notice) setOAuthNotice(notice);
  }, []);

  useEffect(() => {
    if (!confirmDisconnect && restoreDisconnectFocus.current) {
      restoreDisconnectFocus.current = false;
      disconnectButtonRef.current?.focus();
    }
  }, [confirmDisconnect]);

  useEffect(() => {
    let active = true;
    let requestController: AbortController | null = null;
    let unsubscribe: () => void = () => undefined;

    async function loadConnection(user: User) {
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      setLoadState({ kind: "loading" });
      try {
        const token = await user.getIdToken();
        if (!active || controller.signal.aborted) return;
        const response = await fetch("/api/me/calendar-connection", {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!active || controller.signal.aborted) return;
        if (response.status === 401) {
          setLoadState({ kind: "error", message: "ログインが必要です。Microsoft 365アカウントでログインしてください。" });
          return;
        }
        if (response.status === 403) {
          setLoadState({ kind: "error", message: "このアカウントではGoogleカレンダー連携を利用できません。" });
          return;
        }
        if (!response.ok) throw new Error("request failed");
        const connection = parseConnectionView(await readLimitedJson(response));
        if (!active || controller.signal.aborted) return;
        setLoadState({ kind: "ready", connection });
      } catch {
        if (!active || controller.signal.aborted) return;
        setLoadState({
          kind: "error",
          message: "Googleカレンダーの接続状態を取得できませんでした。時間をおいて再度お試しください。",
        });
      }
    }

    try {
      unsubscribe = onAuthStateChanged(
        getClientAuth(),
        (user) => {
          authGeneration.current += 1;
          requestController?.abort();
          operationController.current?.abort();
          operationPending.current = false;
          signInPending.current = false;
          if (!active) return;
          setUser(user);
          setOperation(null);
          setSigningIn(false);
          setSignInError(null);
          setActionError(null);
          setActionSuccess(null);
          setConfirmDisconnect(false);
          if (!user) {
            setLoadState({ kind: "signed-out" });
            return;
          }
          void loadConnection(user);
        },
        () => {
          authGeneration.current += 1;
          requestController?.abort();
          operationController.current?.abort();
          operationPending.current = false;
          signInPending.current = false;
          if (!active) return;
          setUser(null);
          setOperation(null);
          setSigningIn(false);
          setActionError(null);
          setActionSuccess(null);
          setConfirmDisconnect(false);
          setLoadState({ kind: "error", message: "ログイン状態を確認できませんでした。ページを再読み込みしてください。" });
        },
      );
    } catch {
      authGeneration.current += 1;
      setLoadState({ kind: "error", message: "ログイン状態を確認できませんでした。ページを再読み込みしてください。" });
    }

    return () => {
      active = false;
      authGeneration.current += 1;
      requestController?.abort();
      operationController.current?.abort();
      operationPending.current = false;
      signInPending.current = false;
      unsubscribe();
    };
  }, []);

  async function handleSignIn() {
    if (signInPending.current) return;
    signInPending.current = true;
    const generation = authGeneration.current;
    setSigningIn(true);
    setSignInError(null);
    try {
      await signInWithPopup(getClientAuth(), getMicrosoftProvider());
    } catch {
      if (authGeneration.current === generation) {
        setSignInError("Microsoft 365でのログインに失敗しました。");
      }
    } finally {
      if (authGeneration.current === generation) {
        signInPending.current = false;
        setSigningIn(false);
      }
    }
  }

  async function startOAuth() {
    if (!user || operationPending.current) return;
    operationPending.current = true;
    setOAuthNotice(null);
    const generation = authGeneration.current;
    const controller = new AbortController();
    operationController.current?.abort();
    operationController.current = controller;
    setOperation("starting");
    setActionError(null);
    setActionSuccess(null);
    try {
      const token = await user.getIdToken();
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      const response = await fetch("/api/google/oauth/start", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      if (response.status === 401) throw new GoogleUiError("ログインが必要です。Microsoft 365アカウントでログインしてください。");
      if (response.status === 403) throw new GoogleUiError("営業メンバーとして登録されていません。");
      if (!response.ok) throw new GoogleUiError("Googleカレンダーの接続を開始できませんでした。時間をおいて再度お試しください。");
      const authorizationUrl = parseAuthorizationUrl(await readLimitedJson(response));
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      navigate(authorizationUrl);
    } catch (error) {
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      setActionError(error instanceof GoogleUiError
        ? error.message
        : "Googleカレンダーの接続を開始できませんでした。時間をおいて再度お試しください。");
    } finally {
      if (authGeneration.current === generation) {
        operationPending.current = false;
        setOperation(null);
      }
    }
  }

  async function disconnectGoogle() {
    if (!user || operationPending.current) return;
    operationPending.current = true;
    setOAuthNotice(null);
    const generation = authGeneration.current;
    const controller = new AbortController();
    operationController.current?.abort();
    operationController.current = controller;
    setOperation("disconnecting");
    setActionError(null);
    setActionSuccess(null);
    try {
      const token = await user.getIdToken();
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      const response = await fetch("/api/google/connection", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      if (response.status === 401) throw new GoogleUiError("ログインが必要です。Microsoft 365アカウントでログインしてください。");
      if (response.status === 403) throw new GoogleUiError("このアカウントではGoogleカレンダー連携を利用できません。");
      if (!response.ok) throw new GoogleUiError("Googleカレンダーの接続を解除できませんでした。時間をおいて再度お試しください。");
      await readLimitedBody(response, true);
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      setLoadState({
        kind: "ready",
        connection: {
          registered: true,
          canManageMembers: loadState.kind === "ready" ? loadState.connection.canManageMembers : false,
          status: "not_connected",
        },
      });
      setConfirmDisconnect(false);
      setOAuthNotice(null);
      setActionSuccess("Googleカレンダーの接続を解除しました。");
    } catch (error) {
      if (authGeneration.current !== generation || controller.signal.aborted) return;
      setActionError(error instanceof GoogleUiError
        ? error.message
        : "Googleカレンダーの接続を解除できませんでした。時間をおいて再度お試しください。");
    } finally {
      if (authGeneration.current === generation) {
        operationPending.current = false;
        setOperation(null);
      }
    }
  }

  function askToDisconnect() {
    setOAuthNotice(null);
    disconnectButtonRef.current?.focus();
    setConfirmDisconnect(true);
  }

  function cancelDisconnect() {
    restoreDisconnectFocus.current = true;
    setConfirmDisconnect(false);
  }

  if (loadState.kind === "signed-out") {
    return (
      <LoginScreen
        embedded
        error={signInError}
        initializing={false}
        signingIn={signingIn}
        onSignIn={handleSignIn}
        title="Googleカレンダー接続"
        description={<>会社のMicrosoft 365アカウントで認証後、個人のGoogleカレンダーを接続できます。</>}
      />
    );
  }

  return (
    <section className="adminSurface connectSurface" aria-labelledby="google-connect-title">
      <div className="scheduleHeader">
        <div>
          <p className="eyebrow">Google Calendar</p>
          <h2 id="google-connect-title">読み取り専用で接続</h2>
        </div>
        <KeyRound aria-hidden="true" size={20} />
      </div>
      <p className="plainText">
        営業メンバーごとにGoogleカレンダーの読み取りを許可します。予定の作成や編集はGoogleカレンダー側で行います。
      </p>
      {loadState.kind === "ready" ? (
        <AppNavigation
          showCalendar
          showAdminConsole={loadState.connection.canManageMembers}
          className="connectionNavigation"
        />
      ) : null}
      {oauthNotice ? (
        <p className={oauthNotice.error ? "connectionNotice error" : "connectionNotice success"} role={oauthNotice.error ? "alert" : "status"}>
          {oauthNotice.message}
        </p>
      ) : null}
      {actionError ? <p className="connectionNotice error" role="alert">{actionError}</p> : null}
      {actionSuccess ? <p className="connectionNotice success" role="status">{actionSuccess}</p> : null}
      <ConnectionContent
        state={loadState}
        operation={operation}
        confirmDisconnect={confirmDisconnect}
        disconnectButtonRef={disconnectButtonRef}
        onStartOAuth={startOAuth}
        onAskDisconnect={askToDisconnect}
        onCancelDisconnect={cancelDisconnect}
        onDisconnect={disconnectGoogle}
      />
    </section>
  );
}

function ConnectionContent({
  state,
  operation,
  confirmDisconnect,
  disconnectButtonRef,
  onStartOAuth,
  onAskDisconnect,
  onCancelDisconnect,
  onDisconnect,
}: {
  state: LoadState;
  operation: Operation;
  confirmDisconnect: boolean;
  disconnectButtonRef: RefObject<HTMLButtonElement | null>;
  onStartOAuth: () => void;
  onAskDisconnect: () => void;
  onCancelDisconnect: () => void;
  onDisconnect: () => void;
}) {
  if (state.kind === "auth-loading") return <PanelStatus>ログイン状態を確認しています…</PanelStatus>;
  if (state.kind === "signed-out") {
    return <PanelStatus error>ログインが必要です。Microsoft 365アカウントでログインしてください。</PanelStatus>;
  }
  if (state.kind === "loading") return <PanelStatus>Googleカレンダーの接続状態を確認しています…</PanelStatus>;
  if (state.kind === "error") return <PanelStatus error>{state.message}</PanelStatus>;
  if (!state.connection.registered) {
    return <PanelStatus>営業メンバーとして登録されていません</PanelStatus>;
  }

  const connection = state.connection;
  if (connection.status === "not_connected") {
    return (
      <div className="connectionActions">
        <p className="connectionStatus"><span className="statusDot" aria-hidden="true" />未接続</p>
        <button className="primaryButton" type="button" onClick={onStartOAuth} disabled={operation !== null}>
          <ExternalLink aria-hidden="true" size={16} />
          {operation === "starting" ? "接続を開始しています…" : "Googleカレンダーを接続"}
        </button>
      </div>
    );
  }

  if (connection.status === "reconnect_required") {
    return (
      <div className="connectionActions">
        <p className="connectionNotice" role="status">
          Googleカレンダーとの接続が無効になりました。再接続してください。
        </p>
        <button className="primaryButton" type="button" onClick={onStartOAuth} disabled={operation !== null}>
          <ExternalLink aria-hidden="true" size={16} />
          {operation === "starting" ? "接続を開始しています…" : "Googleカレンダーを再接続"}
        </button>
      </div>
    );
  }

  return (
    <div className="connectionDetails">
      <div className="connectionAccount">
        <CalendarCheck2 aria-hidden="true" size={20} />
        <div>
          <strong>接続済み</strong>
          {connection.googleEmail ? <span>{connection.googleEmail}</span> : null}
        </div>
      </div>
      <p className="connectionSync">{formatLastSync(connection.lastSucceededAt)}</p>
      <div className="connectedActionBar">
        <button
          className="primaryButton"
          type="button"
          onClick={onStartOAuth}
          disabled={operation !== null || confirmDisconnect}
        >
          <ExternalLink aria-hidden="true" size={16} />
          {operation === "starting" ? "接続を開始しています…" : "Googleカレンダーを再接続"}
        </button>
        <button
          ref={disconnectButtonRef}
          className="secondaryButton"
          type="button"
          onClick={onAskDisconnect}
          disabled={operation !== null}
          aria-expanded={confirmDisconnect}
          aria-controls="disconnect-confirmation"
        >
          <Unplug aria-hidden="true" size={16} />
          接続解除
        </button>
      </div>
      {confirmDisconnect ? (
        <div
          className="disconnectDialog"
          id="disconnect-confirmation"
          role="region"
          aria-labelledby="disconnect-dialog-title"
        >
          <strong id="disconnect-dialog-title">Googleカレンダーの接続を解除しますか？</strong>
          <p>今後、Googleカレンダーの予定を同期できなくなります。</p>
          <div className="disconnectActions">
            <button className="secondaryButton" type="button" onClick={onCancelDisconnect} disabled={operation !== null}>
              解除をキャンセル
            </button>
            <button className="dangerButton" type="button" onClick={onDisconnect} disabled={operation !== null}>
              <Unplug aria-hidden="true" size={16} />
              {operation === "disconnecting" ? "解除しています…" : "Googleカレンダーの接続を解除"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PanelStatus({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <p className={error ? "connectionNotice error" : "connectionNotice"} role={error ? "alert" : "status"}>{children}</p>;
}

function parseConnectionView(value: unknown): ConnectionView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
  const record = value as Record<string, unknown>;
  const canManageMembers = record.canManageMembers === undefined ? false : record.canManageMembers;
  if (typeof canManageMembers !== "boolean") throw new Error("invalid response");
  if (record.registered === false) return { registered: false, canManageMembers };
  if (record.registered !== true || !isGoogleConnectionStatus(record.status)) throw new Error("invalid response");
  const googleEmail = typeof record.googleEmail === "string" && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(record.googleEmail)
    ? record.googleEmail
    : undefined;
  const lastSucceededAt = validIsoDate(record.lastSucceededAt) ? record.lastSucceededAt : undefined;
  return {
    registered: true,
    canManageMembers,
    status: record.status,
    ...(googleEmail ? { googleEmail } : {}),
    ...(lastSucceededAt ? { lastSucceededAt } : {}),
  };
}

function isGoogleConnectionStatus(value: unknown): value is GoogleConnectionStatus {
  return value === "not_connected" || value === "connected" || value === "reconnect_required";
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function formatLastSync(value: string | undefined): string {
  if (!value) return "最終同期: まだ同期されていません";
  return `最終同期: ${new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))}`;
}

class GoogleUiError extends Error {}

async function readLimitedJson(response: Response): Promise<unknown> {
  const text = await readLimitedBody(response, false);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid response");
  }
}

async function readLimitedBody(response: Response, allowEmpty: boolean): Promise<string> {
  const maximumBytes = 16 * 1024;
  if (!response.body) {
    if (allowEmpty) return "";
    throw new Error("invalid response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let streamDone = false;
  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      streamDone = done;
      if (done) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error("invalid response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    if (allowEmpty) return "";
    throw new Error("invalid response");
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid response");
  }
}

function parseAuthorizationUrl(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleUiError("Googleカレンダーの接続を開始できませんでした。");
  const authorizationUrl = (value as Record<string, unknown>).authorizationUrl;
  if (typeof authorizationUrl !== "string" || authorizationUrl.length === 0 || authorizationUrl.length > 8_192) {
    throw new GoogleUiError("Googleカレンダーの接続を開始できませんでした。");
  }
  try {
    const url = new URL(authorizationUrl);
    if (url.origin !== "https://accounts.google.com"
      || url.pathname !== "/o/oauth2/v2/auth"
      || url.username
      || url.password
      || url.hash) {
      throw new Error("unsafe url");
    }
  } catch {
    throw new GoogleUiError("Googleカレンダーの接続を開始できませんでした。");
  }
  return authorizationUrl;
}

const OAUTH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  server_config: "Google連携の設定を確認してください。",
  invalid_request: "Google連携の有効期限が切れました。もう一度お試しください。",
  invalid_state: "Google連携の有効期限が切れました。もう一度お試しください。",
  access_denied: "Googleカレンダーの接続は完了しませんでした。",
  token_exchange_failed: "Google連携を完了できませんでした。もう一度お試しください。",
  userinfo_failed: "Google連携を完了できませんでした。もう一度お試しください。",
  refresh_token_required: "Googleカレンダーを再接続してください。",
  account_mismatch: "以前と同じGoogleアカウントで再接続してください。",
  server_error: "Google連携を完了できませんでした。もう一度お試しください。",
};

function consumeOAuthNotice(): OAuthNotice {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const google = url.searchParams.get("google");
  const sync = url.searchParams.get("sync");
  let notice: OAuthNotice = null;
  if (google === "connected") {
    notice = {
      error: false,
      message: sync === "pending"
        ? "Googleカレンダーを接続しました。予定は次回の同期で反映されます。"
        : "Googleカレンダーを接続しました。",
    };
  } else if (google === "error") {
    const reason = url.searchParams.get("reason") ?? "";
    notice = {
      error: true,
      message: OAUTH_ERROR_MESSAGES[reason] ?? "Google連携を完了できませんでした。もう一度お試しください。",
    };
  }
  if (!notice) return null;

  // OAuth専用値だけを一度きりで消費し、無関係な検索条件とhashは保持する。
  url.searchParams.delete("google");
  url.searchParams.delete("reason");
  url.searchParams.delete("sync");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return notice;
}
