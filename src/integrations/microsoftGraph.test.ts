import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAllMicrosoftCalendarView,
  fetchMicrosoftProfilePhoto,
  getMicrosoftAppAccessToken,
  getMicrosoftProfilePhotoAccessToken,
} from "./microsoftGraph";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    MICROSOFT_TENANT_ID: "11111111-2222-4333-8444-555555555555",
    MICROSOFT_CLIENT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    MICROSOFT_CLIENT_SECRET: "server-client-secret",
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getMicrosoftAppAccessToken", () => {
  it("tenant固有HTTPS endpointへserver-only資格情報とdefault scopeをform POSTする", async () => {
    process.env.NEXT_PUBLIC_MICROSOFT_CLIENT_SECRET = "public-secret-must-not-be-used";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      token_type: "Bearer",
      expires_in: 3_599,
      access_token: "microsoft-app-access-token",
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMicrosoftAppAccessToken()).resolves.toBe("microsoft-app-access-token");

    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(input).toBe(
      "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/oauth2/v2.0/token",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      client_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      client_secret: "server-client-secret",
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    expect(String(init.body)).not.toContain("public-secret-must-not-be-used");
  });

  it.each([
    ["MICROSOFT_TENANT_ID", "common"],
    ["MICROSOFT_TENANT_ID", "11111111-2222-3333-4444-555555555555/path"],
    ["MICROSOFT_CLIENT_ID", "not-a-guid"],
    ["MICROSOFT_CLIENT_SECRET", "line1\nline2"],
  ])("不正なserver設定 %s=%s は上流へ送らずserver_configにする", async (name, value) => {
    process.env[name] = value;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMicrosoftAppAccessToken()).rejects.toMatchObject({
      code: "server_config",
      message: "Microsoft Graph連携のサーバー設定が無効です。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, "upstream_rejected"],
    [401, "upstream_rejected"],
    [403, "permission_denied"],
    [429, "rate_limited"],
    [503, "upstream_unavailable"],
  ])("token HTTP %iをraw bodyなしの安定エラーへ分類する", async (status, code) => {
    const rawSecret = `provider-body-${status}-server-client-secret`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rawSecret, {
      status,
      headers: { "retry-after": rawSecret },
    })));

    const error = await getMicrosoftAppAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(rawSecret);
    expect(JSON.stringify(error)).not.toContain(rawSecret);
  });

  it("token responseの型・長さ・64KiB上限・fatal UTF-8を検証する", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "x".repeat(8_193) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 123 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "secret" }), {
        headers: { "content-length": String(64 * 1024 + 1) },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])));
    vi.stubGlobal("fetch", fetchMock);

    for (let count = 0; count < 4; count += 1) {
      await expect(getMicrosoftAppAccessToken()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("10秒でtimeoutしtimerを必ず解放する", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));

    const assertion = expect(getMicrosoftAppAccessToken()).rejects.toMatchObject({
      code: "timeout",
      message: "Microsoft Graphへの接続がタイムアウトしました。",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchMicrosoftProfilePhoto", () => {
  it("同時に並ぶ写真取得では短時間キャッシュしたapp tokenを共有する", async () => {
    process.env.MICROSOFT_TENANT_ID = "11111111-1111-4111-8111-111111111111";
    process.env.MICROSOFT_CLIENT_ID = "22222222-2222-4222-8222-222222222222";
    process.env.MICROSOFT_CLIENT_SECRET = "profile-photo-client-secret";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "shared-profile-token",
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(Promise.all([
      getMicrosoftProfilePhotoAccessToken(),
      getMicrosoftProfilePhotoAccessToken(),
      getMicrosoftProfilePhotoAccessToken(),
    ])).resolves.toEqual([
      "shared-profile-token",
      "shared-profile-token",
      "shared-profile-token",
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("登録UPNの48x48写真だけをBearer認証で取得する", async () => {
    const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetchMock = vi.fn(async () => new Response(photoBytes, {
      headers: { "content-type": "image/jpeg", "content-length": String(photoBytes.byteLength) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMicrosoftProfilePhoto({
      accessToken: "profile-photo-access-token",
      userPrincipalName: "sales+tokyo@example.co.jp",
    })).resolves.toEqual({ contentType: "image/jpeg", bytes: photoBytes });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(input)).toBe(
      "https://graph.microsoft.com/v1.0/users/sales%2Btokyo%40example.co.jp/photos/48x48/$value",
    );
    expect(init.headers).toEqual({ authorization: "Bearer profile-photo-access-token" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("写真未設定の404はエラーにせずnullにする", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(fetchMicrosoftProfilePhoto({
      accessToken: "access-token",
      userPrincipalName: "sales@example.co.jp",
    })).resolves.toBeNull();
  });

  it.each([
    ["image/svg+xml", new Uint8Array([1, 2, 3]), undefined],
    ["image/jpeg", new Uint8Array([1, 2, 3]), String(256 * 1024 + 1)],
    ["image/jpeg", new Uint8Array(), "0"],
  ])("不正な写真応答 %s をfail closedにする", async (contentType, bytes, contentLength) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, {
      headers: {
        "content-type": contentType,
        ...(contentLength === undefined ? {} : { "content-length": contentLength }),
      },
    })));

    await expect(fetchMicrosoftProfilePhoto({
      accessToken: "access-token",
      userPrincipalName: "sales@example.co.jp",
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("Microsoftのimage/jpgを標準のimage/jpegとして扱う", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
      headers: { "content-type": "image/jpg" },
    })));

    await expect(fetchMicrosoftProfilePhoto({
      accessToken: "access-token",
      userPrincipalName: "sales@example.co.jp",
    })).resolves.toMatchObject({ contentType: "image/jpeg" });
  });

  it("不正なtokenとUPNはGraphへ送信しない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMicrosoftProfilePhoto({
      accessToken: "token\nleak",
      userPrincipalName: "sales@example.co.jp",
    })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(fetchMicrosoftProfilePhoto({
      accessToken: "access-token",
      userPrincipalName: "https://evil.example/photo",
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchAllMicrosoftCalendarView", () => {
  it("安全なselectとTokyo timezone指定でMicrosoft calendarViewを全ページ取得する", async () => {
    const nextLink = createNextLink("opaque-token+/=safe");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [validMicrosoftItem("event-1")],
        "@odata.nextLink": nextLink,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [validMicrosoftItem("event-2")],
      })));
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchAllMicrosoftCalendarView(validFetchParams());

    expect(events.map((event) => event.sourceEventId)).toEqual(["event-1", "event-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstInput, firstInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const firstUrl = new URL(firstInput);
    expect(firstUrl.origin + firstUrl.pathname).toBe(
      "https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView",
    );
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      startDateTime: "2026-08-01T00:00:00+09:00",
      endDateTime: "2026-09-01T00:00:00+09:00",
      "$select": "id,subject,start,end,location,isAllDay,isCancelled,isOnlineMeeting,onlineMeetingProvider,sensitivity",
      "$top": "100",
    });
    for (const unsafe of [
      "body", "bodyPreview", "attendees", "attachments", "onlineMeeting,", "onlineMeetingUrl", "webLink",
    ]) {
      expect(firstUrl.searchParams.get("$select")).not.toContain(unsafe);
    }
    expect(firstUrl.searchParams.get("$select")).not.toContain("lastModifiedDateTime");
    expect(firstInit.headers).toEqual({
      authorization: "Bearer access-token",
      prefer: 'outlook.timezone="Tokyo Standard Time"',
    });
    expect(firstInit.signal).toBeInstanceOf(AbortSignal);
    expect(String(fetchMock.mock.calls[1][0])).toBe(nextLink);
    expect(events.map((event) => event.updatedAt)).toEqual([
      "2026-08-11T00:00:00Z",
      "2026-08-11T00:00:00Z",
    ]);
  });

  it.each([
    ["$skip", "100"],
    ["$skiptoken", "opaque-token+/=safe"],
  ])("公式nextLinkのopaque paging %s だけでも同一resourceなら追跡する", async (key, value) => {
    const nextUrl = new URL("https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView");
    nextUrl.searchParams.set(key, value);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [], "@odata.nextLink": nextUrl.toString() })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [validMicrosoftItem("next-page")] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).resolves.toMatchObject([
      { sourceEventId: "next-page", updatedAt: "2026-08-11T00:00:00Z" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(nextUrl.toString());
  });

  it("private・confidential・personal・未知sensitivityを安全にmaskし通常予定だけ公開する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      value: [
        validMicrosoftItem("normal", { sensitivity: "normal", subject: "通常会議", location: { displayName: "東京本社" } }),
        validMicrosoftItem("private", { sensitivity: "private", subject: "役員面談", location: { displayName: "役員室" } }),
        validMicrosoftItem("confidential", { sensitivity: "confidential", subject: "機密商談", location: { displayName: "秘密" } }),
        validMicrosoftItem("personal", { sensitivity: "personal", subject: "私用", location: { displayName: "自宅" } }),
        validMicrosoftItem("future", { sensitivity: "future-secret", subject: "未知機密", location: { displayName: "未知場所" } }),
      ],
    }))));

    const events = await fetchAllMicrosoftCalendarView(validFetchParams());

    expect(events[0]).toMatchObject({ title: "通常会議", location: "東京本社", visibility: "team" });
    for (const event of events.slice(1)) {
      expect(event).toMatchObject({ title: "予定あり", location: "", visibility: "private" });
    }
    expect(JSON.stringify(events)).not.toMatch(/役員面談|役員室|機密商談|秘密|私用|自宅|未知機密|未知場所/);
  });

  it("Teams会議もMicrosoftとして扱い、終日・Tokyo/UTC日時を正規化してURLを除去する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      value: [
        validMicrosoftItem("teams", {
          subject: "商談 https://teams.microsoft.com/l/meetup-join/secret 次回",
          location: { displayName: "https://teams.microsoft.com/l/meetup-join/secret" },
          isOnlineMeeting: true,
          onlineMeetingProvider: "teamsForBusiness",
        }),
        validMicrosoftItem("all-day", {
          subject: "終日予定",
          isAllDay: true,
          start: { dateTime: "2026-08-12T00:00:00.0000000", timeZone: "Tokyo Standard Time" },
          end: { dateTime: "2026-08-13T00:00:00.0000000", timeZone: "Tokyo Standard Time" },
        }),
        validMicrosoftItem("utc", {
          start: { dateTime: "2026-08-11T01:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-08-11T02:00:00", timeZone: "UTC" },
        }),
      ],
    }))));

    const events = await fetchAllMicrosoftCalendarView(validFetchParams());

    expect(events[0]).toMatchObject({
      source: "microsoft", title: "商談 次回", location: "", isOnlineMeeting: true,
      start: "2026-08-11T10:00:00+09:00", end: "2026-08-11T11:00:00+09:00",
    });
    expect(events[1]).toMatchObject({ start: "2026-08-12", end: "2026-08-13" });
    expect(events[2]).toMatchObject({ start: "2026-08-11T01:00:00Z", end: "2026-08-11T02:00:00Z" });
    expect(JSON.stringify(events)).not.toContain("meetup-join");
  });

  it.each(["UTC", "tokyo standard time"])(
    "終日予定はend側だけtimezoneを %s へ変更されてもfail-closedで拒否する",
    async (endTimeZone) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      value: [validMicrosoftItem("mixed-all-day-timezone", {
        isAllDay: true,
        start: { dateTime: "2026-08-12T00:00:00.0000000", timeZone: "Tokyo Standard Time" },
        end: { dateTime: "2026-08-13T00:00:00.0000000", timeZone: endTimeZone },
      })],
    }))));

    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
    },
  );

  it("時間指定予定はstart/endで異なる有効timezoneを維持して正規化する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      value: [validMicrosoftItem("mixed-timed-timezone", {
        start: { dateTime: "2026-08-12T10:00:00", timeZone: "Tokyo Standard Time" },
        end: { dateTime: "2026-08-12T02:00:00", timeZone: "UTC" },
      })],
    }))));

    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).resolves.toMatchObject([{
      start: "2026-08-12T10:00:00+09:00",
      end: "2026-08-12T02:00:00Z",
    }]);
  });

  it("明示的なcancelled tombstoneだけをskipし、他のmalformed itemはpage全体を拒否する", async () => {
    const malformedItems = [
      null,
      { ...validMicrosoftItem("missing-end"), end: undefined },
      validMicrosoftItem("bad-timezone", { start: { dateTime: "2026-08-11T10:00:00", timeZone: "Unknown/Zone" } }),
      validMicrosoftItem("backwards", {
        start: { dateTime: "2026-08-11T12:00:00", timeZone: "Tokyo Standard Time" },
        end: { dateTime: "2026-08-11T11:00:00", timeZone: "Tokyo Standard Time" },
      }),
      validMicrosoftItem("bad-location", { location: { displayName: { secret: true } } }),
      validMicrosoftItem("missing-sensitivity", { sensitivity: undefined }),
      validMicrosoftItem("bad-sensitivity", { sensitivity: { secret: true } }),
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{ id: "cancelled", isCancelled: true }, validMicrosoftItem("valid")],
      })));
    for (const malformed of malformedItems) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ value: [validMicrosoftItem("first"), malformed] })));
    }
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).resolves.toMatchObject([
      { sourceEventId: "valid" },
    ]);
    for (let count = 0; count < malformedItems.length; count += 1) {
      await expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it.each([
    ["https://evil.example/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x"],
    ["https://graph.microsoft.com.evil.example/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x"],
    ["http://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x"],
    ["https://user:password@graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x"],
    ["https://graph.microsoft.com/v1.0/users/other%40example.co.jp/calendarView?$skiptoken=x"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/messages?$skiptoken=x"],
    ["https://graph.microsoft.com/beta/users/sales%40example.co.jp/calendarView?$skip=x"],
    ["https://graph.microsoft.com:444/v1.0/users/sales%40example.co.jp/calendarView?$skip=x"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x#fragment"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x&access_token=secret"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x&$skiptoken=y"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skiptoken=x&$top=999"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skip=100&startDateTime=2026-09-01T00%3A00%3A00%2B09%3A00"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skip=100&endDateTime=2026-10-01T00%3A00%3A00%2B09%3A00"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skip=100&$select=id%2Csubject%2Cbody"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skip=100&$expand=attachments"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skip=-1"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skip=abc"],
    ["https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView?$skip=100&$skiptoken=x"],
  ])("危険なnextLinkをfetchせず拒否する: %s", async (nextLink) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      value: [],
      "@odata.nextLink": nextLink,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["", "2026-09-01T00:00:00+09:00"],
    ["2026-08-01", "2026-09-01T00:00:00+09:00"],
    ["2026-08-01T00:00:00", "2026-09-01T00:00:00+09:00"],
    ["2026-09-01T00:00:00+09:00", "2026-08-01T00:00:00+09:00"],
    ["2026-08-01T00:00:00+09:00", "2028-08-01T00:00:00+09:00"],
  ])("不正な期間 %s〜%s を上流へ送らない", async (start, end) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllMicrosoftCalendarView({ ...validFetchParams(), start, end })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("access token・メール・ownerが不正なら上流へ送らない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const params of [
      { ...validFetchParams(), accessToken: " " },
      { ...validFetchParams(), userPrincipalName: "sales@example.co.jp/other" },
      { ...validFetchParams(), userPrincipalName: "sales\n@example.co.jp" },
      { ...validFetchParams(), syncedAt: "not-a-date" },
      { ...validFetchParams(), owner: { ...validFetchParams().owner, calendarId: "primary" } },
    ]) {
      await expect(fetchAllMicrosoftCalendarView(params)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("同じnextLinkの繰り返しを検出して無限loopを防止する", async () => {
    const nextLink = createNextLink("same-token");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: [], "@odata.nextLink": nextLink })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("100ページ・1ページ500件・全体50,000件の上限を設ける", async () => {
    let page = 0;
    const pageLimitFetch = vi.fn(async () => new Response(JSON.stringify({
      value: [],
      "@odata.nextLink": createNextLink(`page-${++page}`),
    })));
    vi.stubGlobal("fetch", pageLimitFetch);
    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({ code: "invalid_response" });
    expect(pageLimitFetch).toHaveBeenCalledTimes(100);

    const itemsLimitFetch = vi.fn(async () => new Response(JSON.stringify({
      value: Array.from({ length: 501 }, () => validMicrosoftItem("same")),
    })));
    vi.stubGlobal("fetch", itemsLimitFetch);
    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({ code: "invalid_response" });

    let totalPage = 0;
    const totalItems = Array.from({ length: 500 }, () => validMicrosoftItem("same"));
    const totalLimitFetch = vi.fn(async () => new Response(JSON.stringify({
      value: totalItems,
      "@odata.nextLink": createNextLink(`total-${++totalPage}`),
    })));
    vi.stubGlobal("fetch", totalLimitFetch);
    await expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({ code: "invalid_response" });
    expect(totalLimitFetch).toHaveBeenCalledTimes(100);
  });

  it("全page累積bytesと正規化後文字数の小さいtest capを適用する", async () => {
    const firstBody = JSON.stringify({ value: [validMicrosoftItem("one")], "@odata.nextLink": createNextLink("two") });
    const secondBody = JSON.stringify({ value: [validMicrosoftItem("two")] });
    const maxCumulativeResponseBytes = new TextEncoder().encode(firstBody).byteLength
      + new TextEncoder().encode(secondBody).byteLength - 1;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(firstBody))
      .mockResolvedValueOnce(new Response(secondBody)));
    await expect(fetchAllMicrosoftCalendarView(validFetchParams(), {
      maxCumulativeResponseBytes,
    })).rejects.toMatchObject({ code: "invalid_response" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [validMicrosoftItem("chars")] }))));
    await expect(fetchAllMicrosoftCalendarView(validFetchParams(), {
      maxNormalizedCharacters: 1,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("不正・巨大・fatal UTF-8 responseをraw内容なしのinvalid_responseにする", async () => {
    const rawSecret = "graph-raw-provider-secret";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "not-an-array", rawSecret })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [], rawSecret }), {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])));
    vi.stubGlobal("fetch", fetchMock);

    for (let count = 0; count < 3; count += 1) {
      const error = await fetchAllMicrosoftCalendarView(validFetchParams()).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid_response" });
      expect(String(error)).not.toContain(rawSecret);
      expect(JSON.stringify(error)).not.toContain(rawSecret);
    }
  });

  it.each([
    [400, "upstream_rejected"],
    [401, "upstream_rejected"],
    [403, "permission_denied"],
    [429, "rate_limited"],
    [500, "upstream_unavailable"],
  ])("calendar HTTP %iをraw body/Retry-Afterなしで分類する", async (status, code) => {
    const rawSecret = `calendar-body-${status}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rawSecret, {
      status,
      headers: { "retry-after": rawSecret },
    })));

    const error = await fetchAllMicrosoftCalendarView(validFetchParams()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(rawSecret);
    expect(JSON.stringify(error)).not.toContain(rawSecret);
  });

  it("body streamも10秒でtimeoutしtimerを解放する", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(new Response(body));
    }));

    const assertion = expect(fetchAllMicrosoftCalendarView(validFetchParams())).rejects.toMatchObject({
      code: "timeout",
      message: "Microsoft Graphへの接続がタイムアウトしました。",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

function validFetchParams() {
  return {
    accessToken: "access-token",
    userPrincipalName: "sales@example.co.jp",
    start: "2026-08-01T00:00:00+09:00",
    end: "2026-09-01T00:00:00+09:00",
    syncedAt: "2026-08-11T00:00:00Z",
    owner: { ownerUserId: "member-1", ownerName: "田中", calendarId: "outlook" },
  };
}

function validMicrosoftItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    subject: "表示対象",
    sensitivity: "normal",
    location: { displayName: "東京本社" },
    isAllDay: false,
    isCancelled: false,
    isOnlineMeeting: false,
    onlineMeetingProvider: "unknown",
    start: { dateTime: "2026-08-11T10:00:00", timeZone: "Tokyo Standard Time" },
    end: { dateTime: "2026-08-11T11:00:00", timeZone: "Tokyo Standard Time" },
    ...overrides,
  };
}

function createNextLink(skipToken: string): string {
  const url = new URL("https://graph.microsoft.com/v1.0/users/sales%40example.co.jp/calendarView");
  url.searchParams.set("startDateTime", "2026-08-01T00:00:00+09:00");
  url.searchParams.set("endDateTime", "2026-09-01T00:00:00+09:00");
  url.searchParams.set(
    "$select",
    "id,subject,start,end,location,isAllDay,isCancelled,isOnlineMeeting,onlineMeetingProvider,sensitivity",
  );
  url.searchParams.set("$top", "100");
  url.searchParams.set("$skiptoken", skipToken);
  return url.toString();
}
