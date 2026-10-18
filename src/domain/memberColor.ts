import type { CSSProperties } from "react";

const MEMBER_COLORS = [
  ["#2563eb", "#edf3ff", "#17448c"],
  ["#8b5cf6", "#f2edff", "#59369c"],
  ["#d97706", "#fff5e5", "#8a4b08"],
  ["#db2777", "#fdeef5", "#9d2058"],
  ["#0891b2", "#e9f8fc", "#126078"],
  ["#059669", "#e8f8ef", "#096846"],
  ["#c2410c", "#fff0e9", "#92320e"],
  ["#4f46e5", "#eeefff", "#37309a"],
  ["#a16207", "#faf6df", "#71500d"],
  ["#be123c", "#fff0f2", "#96213c"],
] as const;

/** The member ID, rather than the provider or visible ordering, determines the color. */
export function getMemberColorStyle(ownerUserId: string): CSSProperties {
  let hash = 0;
  for (const character of ownerUserId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  // Mix all bits so similar UUID suffixes do not cluster into the same palette entry.
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  const [color, background, text] = MEMBER_COLORS[hash % MEMBER_COLORS.length];
  return {
    "--member-color": color,
    "--member-bg": background,
    "--member-text": text,
  } as CSSProperties;
}
