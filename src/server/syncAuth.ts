import { createHash, timingSafeEqual } from "node:crypto";

import type { AppUser } from "@/domain/access";
import { canManage } from "@/domain/access";
import { requireAppUser } from "./auth";

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 256;
const MAX_BEARER_TOKEN_BYTES = 8_192;
const STRICT_HEADER_VALUE = /^[\x21-\x2B\x2D-\x7E]+$/;
const STRICT_BEARER = /^Bearer ([\x21-\x2B\x2D-\x7E]+)$/i;
const DUMMY_LEFT = "invalid-presented-sync-secret";
const DUMMY_RIGHT = "invalid-configured-sync-secret";

export type SafeCompare = (left: Uint8Array, right: Uint8Array) => boolean;

export function isValidSyncSecret(
  provided: string | null | undefined,
  configured: string | null | undefined,
  compare: SafeCompare = timingSafeEqual,
): boolean {
  const providedIsValid = isStrictSecret(provided);
  const configuredIsValid = isStrictSecret(configured);
  const providedDigest = digestSecret(providedIsValid ? provided : DUMMY_LEFT);
  const configuredDigest = digestSecret(configuredIsValid ? configured : DUMMY_RIGHT);
  const equal = compare(providedDigest, configuredDigest);
  return providedIsValid && configuredIsValid && equal;
}

export function isConfiguredSyncSecret(configured: string | null | undefined): configured is string {
  return isStrictSecret(configured);
}

export async function requireAdminSyncRequest(request: Request): Promise<AppUser> {
  const user = await requireAppUser(request);
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(STRICT_BEARER)?.[1];
  if (!bearer || bearer.length > MAX_BEARER_TOKEN_BYTES) {
    throw Response.json({ error: "認証が必要です。" }, { status: 401 });
  }
  if (!canManage(user)) {
    throw Response.json({ error: "管理者権限が必要です。" }, { status: 403 });
  }
  return user;
}

function isStrictSecret(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  if (value.length < MIN_SECRET_BYTES || value.length > MAX_SECRET_BYTES) return false;
  return STRICT_HEADER_VALUE.test(value);
}

function digestSecret(value: string): Buffer {
  return createHash("sha256").update(value, "ascii").digest();
}
