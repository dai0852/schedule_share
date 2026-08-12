import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

function declarationsFor(selector: string): string {
  const selectorStart = styles.indexOf(selector);
  if (selectorStart < 0) throw new Error(`Missing selector: ${selector}`);
  const declarationStart = styles.indexOf("{", selectorStart);
  const declarationEnd = styles.indexOf("}", declarationStart);
  return styles.slice(declarationStart + 1, declarationEnd);
}

describe("calendar source colors", () => {
  it.each([".calendarEventCard.microsoft", ".monthEvent.microsoft", ".memberScheduleEvent.microsoft", ".sourcePill.microsoft"])(
    "%s はGoogleの青と区別できるMicrosoft紫を使う",
    (selector) => {
      const declarations = declarationsFor(selector);

      expect(declarations).toContain("background: #eeeafd;");
      expect(declarations).toContain("color: #4b3ca7;");
    },
  );
});
