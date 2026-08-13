// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicSalesMember } from "@/domain/member";
import { useMemberPhotoUrls } from "./useMemberPhotoUrls";

const member: PublicSalesMember = {
  id: "member-1",
  displayName: "栗原 大",
  department: "営業部",
};
const membersFixture = [member];

function Harness({
  members = membersFixture,
  user,
  enabled = true,
}: {
  members?: PublicSalesMember[];
  user: { getIdToken(): Promise<string> } | null;
  enabled?: boolean;
}) {
  const photos = useMemberPhotoUrls(members, user, enabled);
  return <output>{JSON.stringify(photos)}</output>;
}

describe("useMemberPhotoUrls", () => {
  const createObjectURL = vi.fn(() => "blob:member-photo");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("Firebase ID tokenをheaderだけに付けて写真を取得し、破棄時にblob URLを解放する", async () => {
    const user = { getIdToken: vi.fn().mockResolvedValue("firebase-id-token") };
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/jpeg", "content-length": "3" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<Harness user={user} />);
    expect(await screen.findByText('{"member-1":"blob:member-photo"}')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/members/member-1/photo",
      expect.objectContaining({
        cache: "default",
        headers: { authorization: "Bearer firebase-id-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    const firstCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(firstCall[0])).not.toContain("firebase-id-token");

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:member-photo");
  });

  it.each([
    ["404", new Response(null, { status: 404 })],
    ["unexpected type", new Response(new Uint8Array([1]), { headers: { "content-type": "image/svg+xml" } })],
  ])("%sでは写真を作らずイニシャル用の空mapを保つ", async (_name, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    render(<Harness user={{ getIdToken: vi.fn().mockResolvedValue("token") }} />);

    await waitFor(() => expect(screen.getByText("{}")).toBeInTheDocument());
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("5分ごとにID tokenと写真を再取得してMicrosoft側の変更を反映する", async () => {
    vi.useFakeTimers();
    const user = { getIdToken: vi.fn().mockResolvedValue("fresh-token") };
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), {
      headers: { "content-type": "image/jpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness user={user} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(user.getIdToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1] as unknown as [RequestInfo | URL, RequestInit];
    expect(secondCall[1]).toMatchObject({ cache: "reload" });
  });
});
