import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminMocks = vi.hoisted(() => ({
  hasFirebaseAdminConfig: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({ verifyIdToken: adminMocks.verifyIdToken }),
  hasFirebaseAdminConfig: adminMocks.hasFirebaseAdminConfig,
}));

import { requireAppUser } from "@/server/auth";

describe("requireAppUser", () => {
  beforeEach(() => {
    vi.stubEnv("ALLOW_DEMO_AUTH", "false");
    vi.stubEnv("ALLOWED_EMAIL_DOMAINS", "studio-csa.com");
    vi.stubEnv("ADMIN_EMAILS", "admin@studio-csa.com");
    vi.stubEnv("DEFAULT_USER_ROLE", "viewer");
    adminMocks.hasFirebaseAdminConfig.mockReturnValue(true);
    adminMocks.verifyIdToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("does not fall back to demo authentication when Firebase Admin is missing", async () => {
    adminMocks.hasFirebaseAdminConfig.mockReturnValue(false);

    await expectResponse(requireAppUser(createRequest()), 500, "Firebase Admin設定が不足しています。");
  });

  it("allows demo authentication only when it is explicitly enabled", async () => {
    vi.stubEnv("ALLOW_DEMO_AUTH", "true");
    adminMocks.hasFirebaseAdminConfig.mockReturnValue(false);

    const user = await requireAppUser(createRequest({ "x-demo-email": "admin@studio-csa.com" }));

    expect(user.email).toBe("admin@studio-csa.com");
    expect(user.role).toBe("admin");
    expect(adminMocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("productionではALLOW_DEMO_AUTH=trueでもx-demo-emailを認証に使用しない", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEMO_AUTH", "true");

    await expectResponse(
      requireAppUser(createRequest({ "x-demo-email": "admin@studio-csa.com" })),
      401,
      "認証が必要です。",
    );
    expect(adminMocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects requests without a bearer token", async () => {
    await expectResponse(requireAppUser(createRequest()), 401, "認証が必要です。");
  });

  it("returns 401 when Firebase rejects the ID token", async () => {
    adminMocks.verifyIdToken.mockRejectedValue(new Error("invalid token"));

    await expectResponse(
      requireAppUser(createRequest({ authorization: "Bearer invalid" })),
      401,
      "認証情報が無効です。",
    );
  });

  it("rejects a Firebase token issued through a provider other than Microsoft", async () => {
    adminMocks.verifyIdToken.mockResolvedValue({
      uid: "user-1",
      email: "user@studio-csa.com",
      firebase: { sign_in_provider: "password" },
    });

    await expectResponse(
      requireAppUser(createRequest({ authorization: "Bearer password-token" })),
      403,
      "Microsoft 365アカウントでの認証が必要です。",
    );
  });

  it("rejects a Microsoft user outside the allowed corporate domains", async () => {
    adminMocks.verifyIdToken.mockResolvedValue({
      uid: "user-2",
      email: "user@outside.example",
      firebase: { sign_in_provider: "microsoft.com" },
    });

    await expectResponse(
      requireAppUser(createRequest({ authorization: "Bearer outside-token" })),
      403,
      "社内ドメインのアカウントのみ閲覧できます。",
    );
  });

  it("returns an app user for an allowed Microsoft corporate account", async () => {
    adminMocks.verifyIdToken.mockResolvedValue({
      uid: "user-3",
      email: "admin@studio-csa.com",
      name: "管理者",
      firebase: { sign_in_provider: "microsoft.com" },
    });

    const user = await requireAppUser(
      createRequest({ authorization: "Bearer microsoft-token" }),
    );

    expect(user).toEqual({
      uid: "user-3",
      email: "admin@studio-csa.com",
      displayName: "管理者",
      role: "admin",
    });
  });
});

function createRequest(headers?: HeadersInit): Request {
  return new Request("http://localhost/api/events", { headers });
}

async function expectResponse(
  promise: Promise<unknown>,
  status: number,
  message: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("Responseがthrowされませんでした。");
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    const response = error as Response;
    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe(message);
  }
}
