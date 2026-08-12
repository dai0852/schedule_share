import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGoogleOAuthUrl,
  fetchAllGoogleEvents,
  refreshGoogleAccessToken,
} from "./googleCalendar";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    GOOGLE_CLIENT_ID: "server-client-id",
    GOOGLE_CLIENT_SECRET: "server-client-secret",
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("buildGoogleOAuthUrl", () => {
  it("固定endpointと必要なOAuthパラメータ・scopeだけを設定する", () => {
    const url = new URL(buildGoogleOAuthUrl({
      clientId: "client-id",
      redirectUri: "https://app.example.com/api/google/oauth/callback",
      state: "raw-state",
    }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-id",
      redirect_uri: "https://app.example.com/api/google/oauth/callback",
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state: "raw-state",
    });
  });
});

describe("refreshGoogleAccessToken", () => {
  it("固定HTTPS endpointへserver-only認証情報とrefresh tokenをform POSTする", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_SECRET = "public-secret-must-not-be-used";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "fresh-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshGoogleAccessToken("saved-refresh-token")).resolves.toBe("fresh-access-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(input).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: "server-client-id",
      client_secret: "server-client-secret",
      refresh_token: "saved-refresh-token",
      grant_type: "refresh_token",
    });
    expect(String(init.body)).not.toContain("public-secret-must-not-be-used");
  });

  it("server設定またはrefresh tokenが不正なら上流へ送らずfail closedにする", async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshGoogleAccessToken("saved-refresh-token")).rejects.toMatchObject({
      code: "server_config",
      message: "Google Calendar連携のサーバー設定が無効です。",
    });
    await expect(refreshGoogleAccessToken(" ")).rejects.toMatchObject({
      code: "invalid_request",
      message: "Google Calendar連携のリクエストが無効です。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalid_grantだけを再接続が必要なエラーへ分類しraw本文を漏らさない", async () => {
    const rawSecret = "raw-refresh-token-and-provider-detail";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: rawSecret }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })));

    const error = await refreshGoogleAccessToken("saved-refresh-token").catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "reconnect_required",
      message: "Google Calendarの再接続が必要です。",
    });
    expect(String(error)).not.toContain(rawSecret);
    expect(JSON.stringify(error)).not.toContain(rawSecret);
  });

  it.each([
    [401, "upstream_rejected"],
    [400, "upstream_rejected"],
    [429, "rate_limited"],
    [500, "upstream_unavailable"],
  ])("HTTP %iを安定した安全なエラーへ分類する", async (status, code) => {
    const rawSecret = `provider-body-${status}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rawSecret, { status })));

    const error = await refreshGoogleAccessToken("saved-refresh-token").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(rawSecret);
  });

  it("token responseが大きすぎるか不正なら安全なinvalid_responseにする", async () => {
    const rawSecret = "upstream-secret";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ access_token: rawSecret }), {
        status: 200,
        headers: { "content-length": String(64 * 1024 + 1) },
      })));

    const error = await refreshGoogleAccessToken("saved-refresh-token").catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "invalid_response",
      message: "Google Calendarから無効な応答を受信しました。",
    });
    expect(String(error)).not.toContain(rawSecret);
  });

  it("10秒でtimeoutしtimerを必ず解放する", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));

    const assertion = expect(refreshGoogleAccessToken("saved-refresh-token")).rejects.toMatchObject({
      code: "timeout",
      message: "Google Calendarへの接続がタイムアウトしました。",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchAllGoogleEvents", () => {
  it("primary calendarを安全なfieldsで全ページ取得しpageTokenをURLSearchParamsへ渡す", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        nextPageToken: "next-token+/=safe",
        items: [{
          id: "event-1",
          summary: "訪問",
          location: "東京本社",
          start: { dateTime: "2026-08-11T10:00:00+09:00" },
          end: { dateTime: "2026-08-11T11:00:00+09:00" },
          updated: "2026-08-10T01:00:00Z",
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: "event-2",
          summary: "オンライン商談",
          location: "オンライン",
          start: { date: "2026-08-12" },
          end: { date: "2026-08-13" },
          updated: "2026-08-10T02:00:00Z",
          conferenceData: {
            conferenceSolution: { key: { type: "hangoutsMeet" } },
            entryPoints: [{ uri: "https://meet.google.com/secret" }],
          },
          description: "取得禁止",
          attendees: [{ email: "secret@example.com" }],
          attachments: [{ fileUrl: "https://example.com/secret" }],
          hangoutLink: "https://meet.google.com/secret",
        }],
      })));
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchAllGoogleEvents({
      accessToken: "access-token",
      timeMin: "2026-08-01T00:00:00+09:00",
      timeMax: "2026-09-01T00:00:00+09:00",
      owner: { ownerUserId: "member-1", ownerName: "田中", calendarId: "primary" },
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventId)).toEqual([
      "google:member-1:event-1",
      "google:member-1:event-2",
    ]);
    expect(events[1]).toMatchObject({
      source: "google",
      ownerUserId: "member-1",
      ownerName: "田中",
      calendarId: "primary",
      isOnlineMeeting: true,
      start: "2026-08-12",
      end: "2026-08-13",
    });
    expect(Object.keys(events[1])).not.toEqual(expect.arrayContaining([
      "description", "attendees", "attachments", "hangoutLink", "conferenceData", "meetingUrl",
    ]));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstInput, firstInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const firstUrl = new URL(firstInput);
    expect(firstUrl.origin + firstUrl.pathname).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: "2026-08-01T00:00:00+09:00",
      timeMax: "2026-09-01T00:00:00+09:00",
      maxResults: "2500",
      timeZone: "Asia/Tokyo",
      fields: "nextPageToken,items(id,summary,location,visibility,start(date,dateTime),end(date,dateTime),updated,conferenceData(conferenceSolution(key(type))))",
    });
    expect(firstInit.headers).toEqual({ authorization: "Bearer access-token" });
    expect(firstInit.signal).toBeInstanceOf(AbortSignal);

    const secondUrl = new URL(fetchMock.mock.calls[1][0] as unknown as URL);
    expect(secondUrl.searchParams.get("pageToken")).toBe("next-token+/=safe");
    for (const unsafe of ["description", "attendees", "attachments", "hangoutLink", "entryPoints", "meetingUrl"]) {
      expect(firstUrl.searchParams.get("fields")).not.toContain(unsafe);
      expect(secondUrl.searchParams.get("fields")).not.toContain(unsafe);
    }
  });

  it("private・終日・時間指定・会議種別を正規化しURL入り場所と未要求会議URLを破棄する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [
        {
          id: "private-event",
          summary: "役員面談",
          location: "東京本社",
          visibility: "private",
          start: { dateTime: "2026-08-11T10:00:00+09:00" },
          end: { dateTime: "2026-08-11T11:00:00+09:00" },
          updated: "2026-08-10T01:00:00Z",
        },
        {
          id: "confidential-event",
          summary: "機密商談",
          location: "役員会議室",
          visibility: "confidential",
          start: { dateTime: "2026-08-11T11:00:00+09:00" },
          end: { dateTime: "2026-08-11T12:00:00+09:00" },
          updated: "2026-08-10T01:00:00Z",
        },
        {
          id: "all-day",
          summary: "終日予定",
          location: "案内 https://meet.google.com/secret",
          start: { date: "2026-08-12" },
          end: { date: "2026-08-13" },
          updated: "2026-08-10T01:00:00Z",
          hangoutLink: "https://meet.google.com/secret",
          conferenceData: { entryPoints: [{ uri: "https://meet.google.com/secret" }] },
        },
        {
          id: "online-event",
          summary: "Google Meet",
          location: "オンライン",
          start: { dateTime: "2026-08-12T13:00:00+09:00" },
          end: { dateTime: "2026-08-12T14:00:00+09:00" },
          updated: "2026-08-10T01:00:00Z",
          conferenceData: {
            conferenceSolution: { key: { type: "hangoutsMeet" } },
            entryPoints: [{ uri: "https://meet.google.com/secret" }],
          },
        },
      ],
    }))));

    const events = await fetchAllGoogleEvents(validFetchParams());

    expect(events[0]).toMatchObject({ title: "予定あり", location: "", visibility: "private" });
    expect(events[1]).toMatchObject({ title: "予定あり", location: "", visibility: "private" });
    expect(events[2]).toMatchObject({
      title: "終日予定",
      location: "",
      start: "2026-08-12",
      end: "2026-08-13",
      isOnlineMeeting: false,
    });
    expect(events[3]).toMatchObject({ isOnlineMeeting: true, location: "オンライン" });
    expect(JSON.stringify(events)).not.toContain("meet.google.com");
  });

  it("明示的なcancelled tombstoneだけをskipする", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [
        {
          id: "cancelled",
          status: "cancelled",
          start: { date: "2026-08-11" },
          end: { date: "2026-08-12" },
          updated: "2026-08-10T00:00:00Z",
        },
        validGoogleItem("valid"),
      ],
    }))));

    const events = await fetchAllGoogleEvents(validFetchParams());

    expect(events.map((event) => event.sourceEventId)).toEqual(["valid"]);
  });

  it("cancelled以外のevent decoder失敗はpage全体をinvalid_responseにする", async () => {
    const malformedItems = [
      null,
      { id: "missing-end", start: { date: "2026-08-11" }, updated: "2026-08-10T00:00:00Z" },
      {
        id: "mixed-date-kinds",
        start: { date: "2026-08-11" },
        end: { dateTime: "2026-08-12T00:00:00+09:00" },
        updated: "2026-08-10T00:00:00Z",
      },
      {
        id: "backwards",
        start: { dateTime: "2026-08-11T11:00:00+09:00" },
        end: { dateTime: "2026-08-11T10:00:00+09:00" },
        updated: "2026-08-10T00:00:00Z",
      },
      {
        id: "bad-updated",
        start: { date: "2026-08-11" },
        end: { date: "2026-08-12" },
        updated: "not-a-date",
      },
      {
        id: "bad-summary",
        summary: { nested: "wrong" },
        start: { date: "2026-08-11" },
        end: { date: "2026-08-12" },
        updated: "2026-08-10T00:00:00Z",
      },
    ];
    const fetchMock = vi.fn();
    for (const malformed of malformedItems) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        items: [validGoogleItem("valid-before-malformed"), malformed],
      })));
    }
    vi.stubGlobal("fetch", fetchMock);

    for (let remaining = malformedItems.length; remaining > 0; remaining -= 1) {
      await expect(fetchAllGoogleEvents(validFetchParams())).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("未知のGoogle visibilityをteam公開せずpage全体をinvalid_responseにする", async () => {
    const sensitiveSummary = "未知visibilityの機密件名";
    const sensitiveLocation = "機密会議室";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [{
        ...validGoogleItem("unknown-visibility"),
        summary: sensitiveSummary,
        location: sensitiveLocation,
        visibility: "internal-only",
      }],
    }))));

    const error = await fetchAllGoogleEvents(validFetchParams()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).not.toContain(sensitiveSummary);
    expect(JSON.stringify(error)).not.toContain(sensitiveLocation);
  });

  it("省略・default・public visibilityだけをteam予定として受理する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [
        validGoogleItem("visibility-omitted"),
        { ...validGoogleItem("visibility-default"), visibility: "default" },
        { ...validGoogleItem("visibility-public"), visibility: "public" },
      ],
    }))));

    const events = await fetchAllGoogleEvents(validFetchParams());

    expect(events.map(({ visibility, title }) => ({ visibility, title }))).toEqual([
      { visibility: "team", title: "表示対象" },
      { visibility: "team", title: "表示対象" },
      { visibility: "team", title: "表示対象" },
    ]);
  });

  it.each([
    ["", "2026-09-01T00:00:00+09:00"],
    ["2026-08-01", "2026-09-01T00:00:00+09:00"],
    ["2026-08-01T00:00:00", "2026-09-01T00:00:00+09:00"],
    ["2026-09-01T00:00:00+09:00", "2026-08-01T00:00:00+09:00"],
    ["2026-08-01T00:00:00+09:00", "2028-08-01T00:00:00+09:00"],
  ])("不正な期間 %s〜%s を上流へ送らない", async (timeMin, timeMax) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllGoogleEvents({ ...validFetchParams(), timeMin, timeMax })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("access tokenとownerが不正なら上流へ送らない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllGoogleEvents({ ...validFetchParams(), accessToken: " " })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(fetchAllGoogleEvents({
      ...validFetchParams(),
      owner: { ownerUserId: "member-1", ownerName: "田中", calendarId: "other" },
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("page tokenの重複を検出して無限loopを防止する", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      nextPageToken: "same-token",
      items: [],
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllGoogleEvents(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("page token長と1ページのitems件数に上限を設ける", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nextPageToken: "x".repeat(2_049), items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: Array.from({ length: 2_501 }, () => null) })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllGoogleEvents(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(fetchAllGoogleEvents(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("100ページを超える応答を拒否する", async () => {
    let page = 0;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      nextPageToken: `page-${++page}`,
      items: [],
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllGoogleEvents(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("全ページ合計50,000 itemsを超える応答を拒否する", async () => {
    let page = 0;
    const items = Array.from({ length: 2_500 }, () => validGoogleItem("same-event"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      nextPageToken: `total-page-${++page}`,
      items,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllGoogleEvents(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  it("小さいtest capで全page累積response bytesの上限を検証する", async () => {
    const firstBody = JSON.stringify({ nextPageToken: "page-2", items: [validGoogleItem("one")] });
    const secondBody = JSON.stringify({ items: [validGoogleItem("two")] });
    const cumulativeLimit = new TextEncoder().encode(firstBody).byteLength
      + new TextEncoder().encode(secondBody).byteLength - 1;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(firstBody))
      .mockResolvedValueOnce(new Response(secondBody));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllGoogleEvents(validFetchParams(), {
      maxCumulativeResponseBytes: cumulativeLimit,
    })).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("小さいtest capで正規化後の総文字数上限を検証する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [validGoogleItem("normalized-budget")],
    }))));

    await expect(fetchAllGoogleEvents(validFetchParams(), {
      maxNormalizedCharacters: 1,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("不正または大きすぎるpage responseを安全なinvalid_responseにする", async () => {
    const rawSecret = "calendar-provider-secret";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: "not-an-array", rawSecret })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], rawSecret }), {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      }));
    vi.stubGlobal("fetch", fetchMock);

    for (let count = 0; count < 2; count += 1) {
      const error = await fetchAllGoogleEvents(validFetchParams()).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid_response" });
      expect(String(error)).not.toContain(rawSecret);
    }
  });

  it.each([
    [401, "upstream_rejected"],
    [400, "upstream_rejected"],
    [429, "rate_limited"],
    [503, "upstream_unavailable"],
  ])("events HTTP %iをraw bodyなしで分類する", async (status, code) => {
    const rawSecret = `calendar-body-${status}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rawSecret, { status })));

    const error = await fetchAllGoogleEvents(validFetchParams()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(rawSecret);
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"])(
    "events HTTP 403のallowlist reason %sだけをrate_limitedに分類する",
    async (reason) => {
      const rawSecret = "provider-message-with-token=secret";
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        error: {
          errors: [{ reason, message: rawSecret }],
          message: rawSecret,
        },
      }), { status: 403 })));

      const error = await fetchAllGoogleEvents(validFetchParams()).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "rate_limited" });
      expect(String(error)).not.toContain(rawSecret);
      expect(JSON.stringify(error)).not.toContain(rawSecret);
    },
  );

  it("events HTTP 403の非allowlist・不正・巨大bodyはupstream_rejectedのままにする", async () => {
    const rawSecret = "provider-message-with-token=secret";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { errors: [{ reason: "forbidden", message: rawSecret }] },
      }), { status: 403 }))
      .mockResolvedValueOnce(new Response("not-json-" + rawSecret, { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { errors: [{ reason: "rateLimitExceeded", message: rawSecret }] },
      }), {
        status: 403,
        headers: { "content-length": String(64 * 1024 + 1) },
      }));
    vi.stubGlobal("fetch", fetchMock);

    for (let count = 0; count < 3; count += 1) {
      const error = await fetchAllGoogleEvents(validFetchParams()).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "upstream_rejected" });
      expect(String(error)).not.toContain(rawSecret);
    }
  });

  it("events response bodyの読み込みも10秒でtimeoutしtimerを解放する", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return Promise.resolve(new Response(body));
    }));

    const assertion = expect(fetchAllGoogleEvents(validFetchParams())).rejects.toMatchObject({
      code: "timeout",
      message: "Google Calendarへの接続がタイムアウトしました。",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

function validFetchParams() {
  return {
    accessToken: "access-token",
    timeMin: "2026-08-01T00:00:00+09:00",
    timeMax: "2026-09-01T00:00:00+09:00",
    owner: { ownerUserId: "member-1", ownerName: "田中", calendarId: "primary" },
  };
}

function validGoogleItem(id: string) {
  return {
    id,
    summary: "表示対象",
    start: { date: "2026-08-11" },
    end: { date: "2026-08-12" },
    updated: "2026-08-10T00:00:00Z",
  };
}
