"use client";

import { useEffect, useMemo, useState } from "react";

import type { PublicSalesMember } from "@/domain/member";

const PHOTO_MAX_BYTES = 256 * 1024;
const PHOTO_REFRESH_MS = 5 * 60 * 1_000;
const PHOTO_CONCURRENCY = 4;

type AuthenticatedUser = { getIdToken(): Promise<string> };

export function useMemberPhotoUrls(
  members: PublicSalesMember[],
  user: AuthenticatedUser | null,
  enabled: boolean,
): Record<string, string> {
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const memberIds = useMemo(() => members.map((member) => member.id).sort(), [members]);

  useEffect(() => {
    if (!enabled || !user || memberIds.length === 0 || !supportsObjectUrls()) {
      setPhotoUrls({});
      return;
    }

    let active = true;
    let loading = false;
    let ownedUrls: string[] = [];
    const controller = new AbortController();
    setPhotoUrls({});

    const load = async (reload: boolean) => {
      if (loading || !active) return;
      loading = true;
      try {
        const token = await user.getIdToken();
        if (!active || controller.signal.aborted) return;
        const nextUrls: Record<string, string> = {};
        let position = 0;
        const workers = Array.from(
          { length: Math.min(PHOTO_CONCURRENCY, memberIds.length) },
          async () => {
            while (active && !controller.signal.aborted) {
              const memberId = memberIds[position++];
              if (!memberId) return;
              const photo = await fetchMemberPhoto(memberId, token, controller.signal, reload);
              if (photo) nextUrls[memberId] = URL.createObjectURL(photo);
            }
          },
        );
        await Promise.all(workers);
        if (!active || controller.signal.aborted) {
          revokeUrls(Object.values(nextUrls));
          return;
        }
        revokeUrls(ownedUrls);
        ownedUrls = Object.values(nextUrls);
        setPhotoUrls(nextUrls);
      } catch {
        // 写真は補助情報なので、失敗時はイニシャル表示を維持する。
      } finally {
        loading = false;
      }
    };

    void load(false);
    const refreshTimer = window.setInterval(() => void load(true), PHOTO_REFRESH_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(refreshTimer);
      revokeUrls(ownedUrls);
    };
  }, [enabled, memberIds, user]);

  return photoUrls;
}

async function fetchMemberPhoto(
  memberId: string,
  token: string,
  signal: AbortSignal,
  reload: boolean,
): Promise<Blob | null> {
  try {
    const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/photo`, {
      cache: reload ? "reload" : "default",
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) throw new Error("photo unavailable");
    const contentType = normalizedImageContentType(response.headers.get("content-type"));
    if (!contentType) throw new Error("invalid image type");
    const bytes = await readLimitedBytes(response, PHOTO_MAX_BYTES);
    return new Blob([bytes], { type: contentType });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  }
}

async function readLimitedBytes(response: Response, maximum: number): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("photo too large");
  }
  if (!response.body) throw new Error("empty photo");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let streamEnded = false;
  while (!streamEnded) {
    const { done, value } = await reader.read();
    streamEnded = done;
    if (done) continue;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new Error("photo too large");
    }
    chunks.push(value);
  }
  if (total === 0) throw new Error("empty photo");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function normalizedImageContentType(value: string | null): "image/jpeg" | "image/png" | null {
  const type = value?.split(";", 1)[0].trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "image/jpeg";
  return type === "image/png" ? type : null;
}

function supportsObjectUrls(): boolean {
  return typeof URL.createObjectURL === "function" && typeof URL.revokeObjectURL === "function";
}

function revokeUrls(urls: string[]): void {
  for (const url of urls) URL.revokeObjectURL(url);
}
