import { describe, expect, it } from "vitest";

import { getCompactEventLocation } from "./eventPresentation";

describe("getCompactEventLocation", () => {
  it.each([
    "Microsoft Teams 会議",
    "Microsoft Teams meeting",
    "Teams meeting",
    "Teams会議",
    "Microsoft Teams",
    "Google Meet",
    "Google Meet会議",
    "Google Meet meeting",
    "Google Calendar",
    "Googleカレンダー",
    "Microsoft Outlook",
    "Google",
    "Microsoft",
    "  Ｍｉｃｒｏｓｏｆｔ　Ｔｅａｍｓ　会議  ",
    "gOoGlE  mEeT",
    "　 ",
  ])("サービス名だけの場所 %s をコンパクト表示から除く", (location) => {
    expect(getCompactEventLocation(location)).toBe("");
  });

  it.each([
    "会議室A",
    "Microsoft東京本社",
    "Google日本オフィス",
    "Teams連携打合せ室",
    "Google Meet Room A",
    "Microsoft Teams 会議室",
  ])("実際の場所 %s は原文のまま維持する", (location) => {
    expect(getCompactEventLocation(location)).toBe(location);
  });
});
