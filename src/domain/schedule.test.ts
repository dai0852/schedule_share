import { describe, expect, it } from "vitest";
import {
  filterEvents,
  mapGoogleEvent,
  mapMicrosoftEvent,
  sanitizeEventLocation,
  sanitizeEventTitle,
  sortEvents,
} from "./schedule";

describe("calendar event normalization", () => {
  it("maps a Google Calendar event without leaking body, attendees, or meeting URL", () => {
    const event = mapGoogleEvent(
      {
        id: "g-1",
        summary: "客先定例",
        location: "東京本社",
        description: "社外秘メモ",
        attendees: [{ email: "customer@example.com" }],
        hangoutLink: "https://meet.google.com/secret",
        start: { dateTime: "2026-06-19T10:00:00+09:00" },
        end: { dateTime: "2026-06-19T11:00:00+09:00" },
        updated: "2026-06-18T12:00:00Z",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );

    expect(event).toEqual({
      eventId: "google:sales-a:g-1",
      source: "google",
      sourceEventId: "g-1",
      ownerUserId: "sales-a",
      ownerName: "田中",
      calendarId: "primary",
      title: "客先定例",
      location: "東京本社",
      start: "2026-06-19T10:00:00+09:00",
      end: "2026-06-19T11:00:00+09:00",
      isOnlineMeeting: true,
      visibility: "team",
      updatedAt: "2026-06-18T12:00:00Z",
    });
  });

  it("maps a Microsoft Graph event as Teams when online meeting metadata is present", () => {
    const event = mapMicrosoftEvent(
      {
        id: "m-1",
        subject: "Teams 商談",
        location: { displayName: "Microsoft Teams Meeting" },
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        body: { content: "secret", contentType: "html" },
        attendees: [{ emailAddress: { address: "x@example.com" } }],
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/secret" },
        start: { dateTime: "2026-06-19T13:00:00", timeZone: "Tokyo Standard Time" },
        end: { dateTime: "2026-06-19T14:00:00", timeZone: "Tokyo Standard Time" },
        lastModifiedDateTime: "2026-06-18T15:00:00Z",
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(event).toEqual({
      eventId: "teams:sales-b:m-1",
      source: "teams",
      sourceEventId: "m-1",
      ownerUserId: "sales-b",
      ownerName: "佐藤",
      calendarId: "outlook",
      title: "Teams 商談",
      location: "Microsoft Teams Meeting",
      start: "2026-06-19T13:00:00+09:00",
      end: "2026-06-19T14:00:00+09:00",
      isOnlineMeeting: true,
      visibility: "team",
      updatedAt: "2026-06-18T15:00:00Z",
    });
    expect(Object.keys(event)).not.toContain("onlineMeeting");
    expect(Object.keys(event)).not.toContain("body");
    expect(Object.keys(event)).not.toContain("attendees");
  });

  it("does not expose a Google meeting URL included in the location", () => {
    const event = mapGoogleEvent(
      {
        id: "g-url",
        summary: "オンライン商談",
        location: "受付後 https://meet.google.com/secret に参加",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );

    expect(event.eventId).toBe("google:sales-a:g-url");
    expect(event.location).toBe("");
  });

  it("does not expose a Microsoft meeting URL used as the location", () => {
    const event = mapMicrosoftEvent(
      {
        id: "m-url",
        subject: "オンライン商談",
        location: { displayName: "https://teams.microsoft.com/l/meetup-join/secret" },
        isOnlineMeeting: true,
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(event.eventId).toBe("teams:sales-b:m-url");
    expect(event.location).toBe("");
    expect(event.isOnlineMeeting).toBe(true);
  });

  it("keeps a normal Microsoft location", () => {
    const event = mapMicrosoftEvent(
      { id: "m-office", location: { displayName: "東京本社 5F" } },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(event.eventId).toBe("microsoft:sales-b:m-office");
    expect(event.location).toBe("東京本社 5F");
  });

  it("keeps private event details masked", () => {
    const event = mapGoogleEvent(
      {
        id: "g-private",
        summary: "非公開予定",
        location: "東京本社",
        visibility: "private",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );

    expect(event.title).toBe("予定あり");
    expect(event.location).toBe("");
  });

  it("Google confidential eventもprivateと同じく件名と場所をmaskする", () => {
    const event = mapGoogleEvent(
      {
        id: "g-confidential",
        summary: "機密商談",
        location: "役員会議室",
        visibility: "confidential",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );

    expect(event.title).toBe("予定あり");
    expect(event.location).toBe("");
    expect(event.visibility).toBe("private");
  });

  it("titleからURL-like文字列だけを除去し通常の会議名は保持する", () => {
    expect(sanitizeEventTitle("定例 https://meet.google.com/abc?token=secret 次回確認")).toBe("定例 次回確認");
    expect(sanitizeEventTitle("参加 //teams.microsoft.com/l/meetup-join/secret 案内")).toBe("参加 案内");
    expect(sanitizeEventTitle("www.example.com/path?token=secret")).toBe("予定あり");
    expect(sanitizeEventTitle("（https://meet.google.com/secret）")).toBe("予定あり");
    expect(sanitizeEventTitle("[https://meet.google.com/secret] 次回")).toBe("次回");
    expect(sanitizeEventTitle("[https://meet.google.com] 次回")).toBe("次回");
    expect(sanitizeEventTitle("［https://meet.google.com］次回")).toBe("次回");
    expect(sanitizeEventTitle("meet.google.com/abc-defg-hij?auth=secret")).toBe("予定あり");
    expect(sanitizeEventTitle("tenant.zoom.us/j/123456?pwd=secret")).toBe("予定あり");
    expect(sanitizeEventTitle("Google Meet 活用相談")).toBe("Google Meet 活用相談");
    expect(sanitizeEventTitle("Teams運用定例")).toBe("Teams運用定例");
    expect(sanitizeEventTitle("www展示会の準備")).toBe("www展示会の準備");
    expect(sanitizeEventTitle("工程 A//B 比較")).toBe("工程 A//B 比較");
    expect(sanitizeEventTitle("www.企画会議")).toBe("www.企画会議");
    expect(sanitizeEventTitle("定例 https://user:secret@tenant.webex.com/meet/join?token=abc#room 次回")).toBe("定例 次回");
    expect(sanitizeEventTitle("（https://user:secret@tenant.webex.com/meet/join?token=abc#room）\n次回")).toBe("次回");
    expect(sanitizeEventTitle("連絡先 user@example.com を確認")).toBe("連絡先 user@example.com を確認");
    expect(sanitizeEventTitle("example.com の調査")).toBe("example.com の調査");
    expect(sanitizeEventTitle("定例 tenant.webex.com:8443/meet?token=secret 次回")).toBe("定例 次回");
    expect(sanitizeEventTitle("meet.google.com:8443/abc?token=secret")).toBe("予定あり");
    expect(sanitizeEventTitle("会議:8443 の確認")).toBe("会議:8443 の確認");
  });

  it("locationはURL-like文字列を一部でも含めば全体をblankにする", () => {
    expect(sanitizeEventLocation("東京本社 5F")).toBe("東京本社 5F");
    expect(sanitizeEventLocation("受付後 //example.com/secret へ移動")).toBe("");
    expect(sanitizeEventLocation("meet.google.com/abc-defg-hij")).toBe("");
    expect(sanitizeEventLocation("www.example.com/room?token=secret")).toBe("");
    expect(sanitizeEventLocation("tenant.webex.com/meet/join?token=abc#room")).toBe("");
    expect(sanitizeEventLocation("user@example.com")).toBe("user@example.com");
    expect(sanitizeEventLocation("example.com")).toBe("example.com");
    expect(sanitizeEventLocation("tenant.webex.com:8443/meet?token=secret")).toBe("");
    expect(sanitizeEventLocation("meet.google.com:8443/abc?token=secret")).toBe("");
    expect(sanitizeEventLocation("会議:8443")).toBe("会議:8443");
  });

  it("protocol-relativeのIPv4・IPv6・単一label hostをURL全体として除去する", () => {
    const ipv4 = "接続 //192.168.1.10:8443/meet?token=secret 次回";
    const ipv6 = "接続 //[2001:db8::1]:8443/meet?token=secret 次回";
    const singleLabel = "接続 //conference/meet?token=secret 次回";

    expect(sanitizeEventTitle(ipv4)).toBe("接続 次回");
    expect(sanitizeEventTitle(ipv6)).toBe("接続 次回");
    expect(sanitizeEventTitle(singleLabel)).toBe("接続 次回");
    expect(sanitizeEventLocation(ipv4)).toBe("");
    expect(sanitizeEventLocation(ipv6)).toBe("");
    expect(sanitizeEventLocation(singleLabel)).toBe("");
    expect(JSON.stringify([
      sanitizeEventTitle(ipv4),
      sanitizeEventTitle(ipv6),
      sanitizeEventTitle(singleLabel),
    ])).not.toMatch(/token=secret|192\.168|2001:db8|conference/);
  });

  it("schemelessのIP・localhost・単一label hostはsuffixを伴う場合だけ除去する", () => {
    const urlLikes = [
      "192.168.1.10:8443/meet?token=secret",
      "[2001:db8::1]:8443/meet?token=secret",
      "2001:db8::1/meet?token=secret",
      "localhost/meet?token=secret",
      "conference/meet?token=secret",
    ];

    for (const value of urlLikes) {
      expect(sanitizeEventTitle(`接続 ${value} 次回`)).toBe("接続 次回");
      expect(sanitizeEventLocation(`接続 ${value}`)).toBe("");
    }

    expect(sanitizeEventTitle("工程 A//B 比較")).toBe("工程 A//B 比較");
    expect(sanitizeEventTitle("開始 10:30")).toBe("開始 10:30");
    expect(sanitizeEventTitle("機器 192.168.1.10")).toBe("機器 192.168.1.10");
    expect(sanitizeEventTitle("連絡先 user@example.com")).toBe("連絡先 user@example.com");
  });

  it.each([
    "A/B テスト",
    "Q1/Q2 レビュー",
    "R&D/営業 定例",
    "Plan/Do/Check/Act 研修",
    "Node/React 勉強会",
    "A/Plan:Do/Check レビュー",
  ])("通常のslash表記 `%s` をtitle/locationで保持する", (value) => {
    expect(sanitizeEventTitle(value)).toBe(value);
    expect(sanitizeEventLocation(value)).toBe(value);
  });

  it("単一label hostは強いURL signalがある場合だけ除去する", () => {
    const urlLikes = [
      "//conference/agenda?ref=weekly",
      "localhost/calendar",
      "conference:8443/agenda",
      "conference/meet",
      "conference/JOIN",
      "conference/unknown?token=secret",
      "conference/unknown?AUTH=secret",
      "conference/unknown?%74oken=secret",
      "conference/unknown?%2574oken=secret",
      "conference/%6d%65%65%74?ref=weekly",
      "conference/%256d%2565%2565%2574?ref=weekly",
    ];

    for (const value of urlLikes) {
      expect(sanitizeEventTitle(`案内 ${value} 次回`)).toBe("案内 次回");
      expect(sanitizeEventLocation(value)).toBe("");
    }

    expect(sanitizeEventTitle("conference/agenda レビュー")).toBe("conference/agenda レビュー");
    expect(sanitizeEventLocation("conference/agenda room")).toBe("conference/agenda room");
  });

  it("通常slash表記をGoogle/Microsoft mappingでも過剰に削除しない", () => {
    const google = mapGoogleEvent(
      { id: "g-slash-text", summary: "Plan/Do/Check/Act 研修", location: "R&D/営業" },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );
    const microsoft = mapMicrosoftEvent(
      { id: "m-slash-text", subject: "Node/React 勉強会", location: { displayName: "Q1/Q2 会議室" } },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(google).toMatchObject({ title: "Plan/Do/Check/Act 研修", location: "R&D/営業" });
    expect(microsoft).toMatchObject({ title: "Node/React 勉強会", location: "Q1/Q2 会議室" });
  });

  it("rejected single-label prefix後のknown/DNS/IP URL suffixだけを除去する", () => {
    const values = [
      "A/meet.google.com/private?token=secret",
      "A/zoom.us/j/123?pwd=secret",
      "A/example.com/private?auth=secret",
      "A/192.168.1.10/private?session=secret",
      "A/[2001:db8::1]/private?token=secret",
    ];

    for (const value of values) {
      expect(sanitizeEventTitle(value)).toBe("A/");
      expect(sanitizeEventLocation(value)).toBe("");
    }
    expect(JSON.stringify(values.map((value) => sanitizeEventTitle(value))))
      .not.toMatch(/google|zoom|example\.com|192\.168|token=|pwd=|auth=|session=/);

    expect(sanitizeEventTitle("A/label:meet.google.com/private?token=secret")).toBe("A/label");
    expect(sanitizeEventLocation("A/label:meet.google.com/private?token=secret")).toBe("");
  });

  it("single-label prefix後のURL suffixをGoogle/Microsoft mappingでも保存しない", () => {
    const google = mapGoogleEvent(
      {
        id: "g-nested-url",
        summary: "A/meet.google.com/private?token=secret",
        location: "A/example.com/private?auth=secret",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );
    const microsoft = mapMicrosoftEvent(
      {
        id: "m-nested-url",
        subject: "A/zoom.us/j/123?pwd=secret",
        location: { displayName: "A/192.168.1.10/private?session=secret" },
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(google).toMatchObject({ title: "A/", location: "" });
    expect(microsoft).toMatchObject({ title: "A/", location: "" });
    expect(JSON.stringify([
      google.title,
      google.location,
      microsoft.title,
      microsoft.location,
    ])).not.toMatch(/token=|pwd=|auth=|session=|meet\.google|zoom\.us/);
  });

  it("long slash chain後のURLを定数倍走査で除去し、URLなしchainは保持する", { timeout: 2_000 }, () => {
    const prefix = `案内/${"A/".repeat(16_000)}`;
    const input = `${prefix}meet.google.com/private?token=secret`;
    const diagnostics = { scannedCodeUnits: 0, candidateChecks: 0 };

    expect(sanitizeEventTitle(input, diagnostics)).toBe(prefix);
    expect(diagnostics.scannedCodeUnits).toBeLessThanOrEqual(input.length * 6);
    expect(diagnostics.candidateChecks).toBeLessThanOrEqual(input.length);

    const normal = `${prefix}B テスト`;
    expect(sanitizeEventTitle(normal)).toBe(normal);
  });

  it("IP URLのinvalid portでも秘密suffixを部分的に残さない", () => {
    const values = [
      "//192.168.1.10:65536/meet?token=secret",
      "//[2001:db8::1]:not-a-port/meet?token=secret",
      "192.168.1.10:0/meet?token=secret",
      "[2001:db8::1]:65536/meet?token=secret",
    ];

    for (const value of values) {
      expect(sanitizeEventTitle(`接続 ${value} 次回`)).toBe("接続 次回");
      expect(sanitizeEventLocation(value)).toBe("");
    }
  });

  it("GoogleとMicrosoft双方でIP・単一labelの会議URLを保存しない", () => {
    const google = mapGoogleEvent(
      {
        id: "g-ip-url",
        summary: "定例 //192.168.1.10:8443/meet?token=secret 次回",
        location: "[2001:db8::1]:8443/meet?token=secret",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );
    const microsoft = mapMicrosoftEvent(
      {
        id: "m-single-host-url",
        subject: "conference/meet?token=secret",
        location: { displayName: "//conference/meet?token=secret" },
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(google).toMatchObject({ title: "定例 次回", location: "" });
    expect(microsoft).toMatchObject({ title: "予定あり", location: "" });
    expect(JSON.stringify([google, microsoft])).not.toMatch(/token=secret|192\.168|2001:db8|conference/);
  });

  it("極端に長い入力は部分文字列を返さずfail closedにする", () => {
    const oversized = `定例 ${"a".repeat(70_000)} token=secret`;

    expect(sanitizeEventTitle(oversized)).toBe("予定あり");
    expect(sanitizeEventLocation(oversized)).toBe("");
  });

  it("URL候補のない4096文字を100件、合理的なtimeout内で線形走査する", { timeout: 2_000 }, () => {
    const adversarial = "a".repeat(4_096);

    for (let index = 0; index < 100; index += 1) {
      expect(sanitizeEventTitle(adversarial)).toBe(adversarial);
      expect(sanitizeEventLocation(adversarial)).toBe(adversarial);
    }
  });

  it("colon反復とnear-authority入力を各文字一定回数以内で走査する", { timeout: 2_000 }, () => {
    const sizes = [2_000, 4_000, 8_000, 16_000];
    const patterns = [
      (size: number) => `x${"a:".repeat(size)}end`,
      (size: number) => `x${"a.".repeat(size)}end`,
      (size: number) => `x${"[a:".repeat(size)}end`,
      (size: number) => `x${"a-:".repeat(size)}end`,
    ];

    for (const size of sizes) {
      for (const createInput of patterns) {
        const input = createInput(size);
        const diagnostics = { scannedCodeUnits: 0, candidateChecks: 0 };

        expect(sanitizeEventTitle(input, diagnostics)).toBe(input);
        expect(diagnostics.scannedCodeUnits).toBeGreaterThanOrEqual(input.length);
        expect(diagnostics.scannedCodeUnits).toBeLessThanOrEqual(input.length * 4);
        expect(diagnostics.candidateChecks).toBeLessThanOrEqual(input.length);
      }
    }
  });

  it("通常のcolon表現を保持し、日本語隣接・1token内のURLは遮断する", () => {
    expect(sanitizeEventTitle("会議:8443")).toBe("会議:8443");
    expect(sanitizeEventTitle("a:b")).toBe("a:b");
    expect(sanitizeEventTitle("A//B")).toBe("A//B");
    expect(sanitizeEventTitle("user@example.com")).toBe("user@example.com");
    expect(sanitizeEventTitle("案内：https://meet.google.com/secret。次回")).toBe("案内： 。次回");
    expect(sanitizeEventTitle("案内:https://one.example/secret|https://two.example/secret")).toBe("案内");
  });

  it("rejected authority内の後続bare DNSだけを再開位置として遮断する", () => {
    const known = "案内:a:a:meet.google.com/abc?token=secret";
    const generic = "案内:a:a:tenant.webex.com/meet?token=secret";

    expect(sanitizeEventTitle(known)).toBe("案内:a:a");
    expect(sanitizeEventTitle(generic)).toBe("案内:a:a");
    expect(sanitizeEventLocation(known)).toBe("");
    expect(sanitizeEventLocation(generic)).toBe("");
    expect(JSON.stringify([
      sanitizeEventTitle(known),
      sanitizeEventTitle(generic),
    ])).not.toMatch(/meet\.google|webex|token=secret/);
  });

  it("long colon chain後のknown/generic bare URLを定数倍走査で遮断する", { timeout: 2_000 }, () => {
    for (const hostAndPath of [
      "meet.google.com/abc?token=secret",
      "tenant.webex.com/meet?token=secret",
    ]) {
      const prefix = `案内:${"a:".repeat(16_000)}`;
      const input = `${prefix}${hostAndPath}`;
      const diagnostics = { scannedCodeUnits: 0, candidateChecks: 0 };
      const sanitized = sanitizeEventTitle(input, diagnostics);

      expect(sanitized.startsWith("案内:a:a:")).toBe(true);
      expect(sanitized).not.toMatch(/meet\.google|webex|token=secret/);
      expect(diagnostics.scannedCodeUnits).toBeLessThanOrEqual(input.length * 6);
      expect(diagnostics.candidateChecks).toBeLessThanOrEqual(input.length);
    }

    const normal = `案内:${"a:".repeat(16_000)}end`;
    expect(sanitizeEventTitle(normal)).toBe(normal);
  });

  it.each(["0", "65536", "not-a-port"])(
    "invalid schemeless port %sでもURL-like token全体をfail-safeに除去する",
    (port) => {
      const generic = `定例 tenant.webex.com:${port}/meet?token=secret 次回`;
      const known = `案内 meet.google.com:${port}/abc?token=secret 次回`;
      const explicit = `確認 https://tenant.webex.com:${port}/meet?token=secret 次回`;
      const protocolRelative = `確認 //tenant.webex.com:${port}/meet?token=secret 次回`;

      expect(sanitizeEventTitle(generic)).toBe("定例 次回");
      expect(sanitizeEventTitle(known)).toBe("案内 次回");
      expect(sanitizeEventTitle(explicit)).toBe("確認 次回");
      expect(sanitizeEventTitle(protocolRelative)).toBe("確認 次回");
      expect(sanitizeEventLocation(generic)).toBe("");
      expect(sanitizeEventLocation(known)).toBe("");
      expect(sanitizeEventLocation(explicit)).toBe("");
      expect(sanitizeEventLocation(protocolRelative)).toBe("");
      expect(JSON.stringify([
        sanitizeEventTitle(generic),
        sanitizeEventTitle(known),
        sanitizeEventTitle(explicit),
        sanitizeEventTitle(protocolRelative),
        sanitizeEventLocation(generic),
        sanitizeEventLocation(known),
        sanitizeEventLocation(explicit),
        sanitizeEventLocation(protocolRelative),
      ])).not.toMatch(/token=secret|webex|google\.com|not-a-port|65536/);
    },
  );

  it("GoogleとMicrosoftの件名に混入した会議URLやquery tokenを正規化結果へ残さない", () => {
    const google = mapGoogleEvent(
      { id: "g-title-url", summary: "商談 zoom.us/j/123?pwd=secret" },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );
    const microsoft = mapMicrosoftEvent(
      { id: "m-title-url", subject: "https://teams.microsoft.com/l/meetup-join/secret?token=abc" },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(google.title).toBe("商談");
    expect(microsoft.title).toBe("予定あり");
    expect(JSON.stringify([google, microsoft])).not.toMatch(/pwd=|token=|meetup-join/);
  });

  it("GoogleとMicrosoft双方でuserinfo付きURLとbare provider URLを完全に除去する", () => {
    const google = mapGoogleEvent(
      {
        id: "g-provider-url",
        summary: "定例 https://user:secret@tenant.webex.com/meet/join?token=abc#room 次回",
        location: "tenant.webex.com/meet/join?token=abc#room",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );
    const microsoft = mapMicrosoftEvent(
      {
        id: "m-provider-url",
        subject: "https://user:secret@tenant.webex.com/meet/join?token=abc#room",
        location: { displayName: "受付 tenant.webex.com/meet/join?token=abc#room" },
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(google).toMatchObject({ title: "定例 次回", location: "" });
    expect(microsoft).toMatchObject({ title: "予定あり", location: "" });
    expect(JSON.stringify([google, microsoft])).not.toMatch(/user:secret|webex|token=abc|#room/);
  });

  it("schemeless userinfo付きURLは資格情報からsuffixまで全体を除去する", () => {
    const known = "案内 user@meet.google.com/secret 次回";
    const generic = "user:secret@tenant.webex.com/meet?token=abc";
    const tagged = "user+tag:secret@tenant.webex.com/meet?token=abc";
    const invalid = "one@two@tenant.webex.com:65536/meet?token=abc";
    const explicitPort = "user@example.com:8443";
    const ipv6 = "user@[2001:db8::1]:8443/meet?token=abc";
    const meetingHost = "user@conference/meet";
    const meetingJoin = "user@meeting/join";
    const meetingCredential = "user:secret@conference/meet";
    const meetingQuery = "user:secret@conference/unknown?token=secret";
    const meetingAuth = "user:secret@meeting/path?auth=secret";
    const intranetToken = "user:secret@intranet?token=secret";
    const fooAuth = "user:secret@foo#auth=secret";
    const intranetPath = "user:secret@intranet/path?token=secret";

    expect(sanitizeEventTitle(known)).toBe("案内 次回");
    expect(sanitizeEventTitle(generic)).toBe("予定あり");
    expect(sanitizeEventTitle(tagged)).toBe("予定あり");
    expect(sanitizeEventTitle(invalid)).toBe("予定あり");
    expect(sanitizeEventTitle(explicitPort)).toBe("予定あり");
    expect(sanitizeEventTitle(ipv6)).toBe("予定あり");
    expect(sanitizeEventTitle(meetingHost)).toBe("予定あり");
    expect(sanitizeEventTitle(meetingJoin)).toBe("予定あり");
    expect(sanitizeEventTitle(meetingCredential)).toBe("予定あり");
    expect(sanitizeEventTitle(meetingQuery)).toBe("予定あり");
    expect(sanitizeEventTitle(meetingAuth)).toBe("予定あり");
    expect(sanitizeEventTitle(intranetToken)).toBe("予定あり");
    expect(sanitizeEventTitle(fooAuth)).toBe("予定あり");
    expect(sanitizeEventTitle(intranetPath)).toBe("予定あり");
    expect(sanitizeEventLocation(known)).toBe("");
    expect(sanitizeEventLocation(generic)).toBe("");
    expect(sanitizeEventLocation(tagged)).toBe("");
    expect(sanitizeEventLocation(invalid)).toBe("");
    expect(sanitizeEventLocation(explicitPort)).toBe("");
    expect(sanitizeEventLocation(ipv6)).toBe("");
    expect(sanitizeEventLocation(meetingHost)).toBe("");
    expect(sanitizeEventLocation(meetingJoin)).toBe("");
    expect(sanitizeEventLocation(meetingCredential)).toBe("");
    expect(sanitizeEventLocation(meetingQuery)).toBe("");
    expect(sanitizeEventLocation(meetingAuth)).toBe("");
    expect(sanitizeEventLocation(intranetToken)).toBe("");
    expect(sanitizeEventLocation(fooAuth)).toBe("");
    expect(sanitizeEventLocation(intranetPath)).toBe("");
    expect(JSON.stringify([
      sanitizeEventTitle(known),
      sanitizeEventTitle(generic),
      sanitizeEventTitle(tagged),
      sanitizeEventTitle(invalid),
      sanitizeEventTitle(explicitPort),
      sanitizeEventTitle(ipv6),
      sanitizeEventTitle(meetingHost),
      sanitizeEventTitle(meetingJoin),
      sanitizeEventTitle(meetingCredential),
      sanitizeEventTitle(meetingQuery),
      sanitizeEventTitle(meetingAuth),
      sanitizeEventTitle(intranetToken),
      sanitizeEventTitle(fooAuth),
      sanitizeEventTitle(intranetPath),
    ])).not.toMatch(/user|secret|meet\.google|webex|token=|65536/);
  });

  it("suffixのない通常emailはuserinfo URLとして除去しない", () => {
    expect(sanitizeEventTitle("user@example.com")).toBe("user@example.com");
    expect(sanitizeEventTitle("連絡先 user@example.com を確認")).toBe("連絡先 user@example.com を確認");
    expect(sanitizeEventTitle("user+tag@example.co.jp")).toBe("user+tag@example.co.jp");
    expect(sanitizeEventTitle("user@meet.google.com")).toBe("user@meet.google.com");
    expect(sanitizeEventTitle("user@intranet/path")).toBe("user@intranet/path");
    expect(sanitizeEventLocation("user@intranet/path")).toBe("user@intranet/path");
    expect(sanitizeEventLocation("user+tag@example.co.jp")).toBe("user+tag@example.co.jp");
  });

  it("schemeless userinfo URLをGoogle/Microsoft mappingの件名と場所に保存しない", () => {
    const google = mapGoogleEvent(
      {
        id: "g-userinfo-url",
        summary: "user:secret@intranet?token=abc",
        location: "user:secret@foo#auth=abc",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );
    const microsoft = mapMicrosoftEvent(
      {
        id: "m-userinfo-url",
        subject: "定例 user:secret@intranet/path?token=abc",
        location: { displayName: "user:secret@foo#auth=abc" },
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(google).toMatchObject({ title: "予定あり", location: "" });
    expect(microsoft).toMatchObject({ title: "定例", location: "" });
    expect(JSON.stringify([
      google.title,
      google.location,
      microsoft.title,
      microsoft.location,
    ])).not.toMatch(/user|secret|meet\.google|webex|token=/);
  });

  it("long userinfo候補も定数倍で走査し、資格情報を部分残ししない", { timeout: 2_000 }, () => {
    const credential = "user:".repeat(8_000);
    const input = `案内 ${credential}secret@intranet/path?token=abc`;
    const diagnostics = { scannedCodeUnits: 0, candidateChecks: 0 };

    expect(sanitizeEventTitle(input, diagnostics)).toBe("案内");
    expect(diagnostics.scannedCodeUnits).toBeLessThanOrEqual(input.length * 6);
    expect(diagnostics.candidateChecks).toBeLessThanOrEqual(input.length);
  });

  it("meetingを含む通常slash表記はhostが会議用labelでなければ保持する", () => {
    expect(sanitizeEventTitle("Plan/meeting レビュー")).toBe("Plan/meeting レビュー");
    expect(sanitizeEventLocation("Plan/meeting room")).toBe("Plan/meeting room");
    expect(sanitizeEventTitle("conference/meet")).toBe("予定あり");
    expect(sanitizeEventLocation("conference/meet")).toBe("");
  });

  it("GoogleとMicrosoft双方で明示port付きschemeless URLを完全に除去する", () => {
    const google = mapGoogleEvent(
      {
        id: "g-port-url",
        summary: "定例 tenant.webex.com:8443/meet?token=secret 次回",
        location: "meet.google.com:8443/abc?token=secret",
      },
      { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
    );
    const microsoft = mapMicrosoftEvent(
      {
        id: "m-port-url",
        subject: "meet.google.com:8443/abc?token=secret",
        location: { displayName: "tenant.webex.com:65536/meet?token=secret" },
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(google).toMatchObject({ title: "定例 次回", location: "" });
    expect(microsoft).toMatchObject({ title: "予定あり", location: "" });
    expect(JSON.stringify([google, microsoft])).not.toMatch(/webex|google\.com|8443|65536|token=secret/);
  });

  it("keeps a private Teams event masked while preserving its source and meeting state", () => {
    const event = mapMicrosoftEvent(
      {
        id: "m-private",
        subject: "役員会議",
        sensitivity: "private",
        location: { displayName: "Microsoft Teams Meeting" },
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      },
      { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
    );

    expect(event.title).toBe("予定あり");
    expect(event.location).toBe("");
    expect(event.source).toBe("teams");
    expect(event.isOnlineMeeting).toBe(true);
  });

  it.each(["private", "confidential", "personal", "future-sensitive-value"])(
    "Microsoft sensitivity %s をfail-closedでmaskする",
    (sensitivity) => {
      const event = mapMicrosoftEvent(
        {
          id: `m-${sensitivity}`,
          subject: "非公開件名",
          sensitivity,
          location: { displayName: "非公開場所" },
        },
        { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
      );

      expect(event).toMatchObject({ title: "予定あり", location: "", visibility: "private" });
    },
  );

  it("uses the same owner-scoped ID for the same Google input", () => {
    const owner = { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" };
    const input = { id: "g-stable", updated: "2026-08-11T00:00:00.000Z" };

    expect(mapGoogleEvent(input, owner).eventId).toBe(mapGoogleEvent(input, owner).eventId);
  });

  it("rejects a missing Google source event ID", () => {
    expect(() =>
      mapGoogleEvent(
        {} as Parameters<typeof mapGoogleEvent>[0],
        { ownerUserId: "sales-a", ownerName: "田中", calendarId: "primary" },
      ),
    ).toThrow("Source event ID is required.");
  });

  it("rejects an empty Microsoft source event ID", () => {
    expect(() =>
      mapMicrosoftEvent(
        { id: "  " },
        { ownerUserId: "sales-b", ownerName: "佐藤", calendarId: "outlook" },
      ),
    ).toThrow("Source event ID is required.");
  });
});

describe("event filtering", () => {
  const events = [
    {
      eventId: "1",
      source: "google" as const,
      sourceEventId: "1",
      ownerUserId: "sales-a",
      ownerName: "田中",
      calendarId: "primary",
      title: "午前予定",
      location: "",
      start: "2026-06-19T09:00:00+09:00",
      end: "2026-06-19T10:00:00+09:00",
      isOnlineMeeting: false,
      visibility: "team" as const,
      updatedAt: "2026-06-18T00:00:00Z",
    },
    {
      eventId: "2",
      source: "teams" as const,
      sourceEventId: "2",
      ownerUserId: "sales-b",
      ownerName: "佐藤",
      calendarId: "outlook",
      title: "午後予定",
      location: "Teams",
      start: "2026-06-19T15:00:00+09:00",
      end: "2026-06-19T16:00:00+09:00",
      isOnlineMeeting: true,
      visibility: "team" as const,
      updatedAt: "2026-06-18T00:00:00Z",
    },
  ];

  it("filters by inclusive date window and owner without deduplicating overlaps", () => {
    expect(
      filterEvents(events, {
        start: "2026-06-19T00:00:00+09:00",
        end: "2026-06-20T00:00:00+09:00",
        ownerUserId: "sales-b",
      }),
    ).toHaveLength(1);
  });

  it("sorts by start time then owner name", () => {
    expect(sortEvents([...events]).map((event) => event.eventId)).toEqual(["1", "2"]);
  });

  it("日時filterに対してdate-only予定をAsia/Tokyoの深夜・終了日exclusiveとして扱う", () => {
    const allDay = {
      ...events[0],
      eventId: "all-day",
      start: "2026-08-12",
      end: "2026-08-13",
    };

    expect(filterEvents([allDay], {
      start: "2026-08-11T14:59:59.999Z",
      end: "2026-08-11T15:00:00.000Z",
    })).toEqual([]);
    expect(filterEvents([allDay], {
      start: "2026-08-11T15:00:00.000Z",
      end: "2026-08-12T15:00:00.000Z",
    })).toEqual([allDay]);
    expect(filterEvents([allDay], {
      start: "2026-08-12T15:00:00.000Z",
      end: "2026-08-12T15:00:00.001Z",
    })).toEqual([]);
  });
});
