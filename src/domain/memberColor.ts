import type { CSSProperties } from "react";

const MEMBER_COLORS = [
  ["#2563eb", "#edf3ff", "#17448c"],
  ["#d97706", "#fff5e5", "#8a4b08"],
  ["#059669", "#e8f8ef", "#096846"],
  ["#db2777", "#fdeef5", "#9d2058"],
  ["#8b5cf6", "#f2edff", "#59369c"],
  ["#0891b2", "#e9f8fc", "#126078"],
  ["#c2410c", "#fff0e9", "#92320e"],
  ["#a16207", "#faf6df", "#71500d"],
  ["#b91c1c", "#fff0f0", "#8f1717"],
  ["#4d7c0f", "#f2f8e6", "#3b5e10"],
  ["#795548", "#f7efeb", "#5c3d32"],
  ["#475569", "#f0f3f7", "#334155"],
  ["#a21caf", "#fbedfc", "#75157e"],
  ["#0f766e", "#e8f6f4", "#0c5c56"],
  ["#cc6256", "#fff2ee", "#984239"],
  ["#4f46e5", "#eeefff", "#37309a"],
] as const;

export type MemberColorMap = Readonly<Record<string, CSSProperties>>;

/** Allocate from the complete registry, before applying date/member filters. */
export function createMemberColorMap(ownerUserIds: readonly string[]): MemberColorMap {
  return extendMemberColorMap(Object.create(null), ownerUserIds);
}

/** Newly discovered members get unused colors without recoloring known members. */
export function extendMemberColorMap(previous: MemberColorMap, ownerUserIds: readonly string[]): MemberColorMap {
  const newIds = [...new Set(ownerUserIds)].sort().filter((id) => !Object.hasOwn(previous, id));
  if (newIds.length === 0) return previous;
  const colors: Record<string, CSSProperties> = Object.assign(Object.create(null), previous);
  const previousCount = Object.keys(previous).length;
  newIds.forEach((id, offset) => {
    const index = previousCount + offset;
    const palette = MEMBER_COLORS[index];
    const hue = ((index - MEMBER_COLORS.length) * 137.508 % 360).toFixed(3);
    colors[id] = colorStyle(palette ?? [
      `hsl(${hue} 62% 40%)`, `hsl(${hue} 70% 95%)`, `hsl(${hue} 48% 28%)`,
    ]);
  });
  return colors;
}

export function getMemberColorStyle(ownerUserId: string, memberColors?: MemberColorMap): CSSProperties {
  if (memberColors && Object.hasOwn(memberColors, ownerUserId)) return memberColors[ownerUserId];
  let hash = 0;
  for (const character of ownerUserId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  // Mix all bits so similar UUID suffixes do not cluster into the same palette entry.
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return colorStyle(MEMBER_COLORS[hash % MEMBER_COLORS.length]);
}

function colorStyle([color, background, text]: readonly string[]): CSSProperties {
  return {
    "--member-color": color,
    "--member-bg": background,
    "--member-text": text,
  } as CSSProperties;
}
