import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAppMocks = vi.hoisted(() => ({
  cert: vi.fn(),
  getApps: vi.fn(),
  initializeApp: vi.fn(),
}));

vi.mock("firebase-admin/app", () => firebaseAppMocks);
vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn() }));
vi.mock("firebase-admin/firestore", () => ({ getFirestore: vi.fn() }));

import { getAdminApp, hasFirebaseAdminConfig } from "./admin";

const initializeCallsAtImportTime = firebaseAppMocks.initializeApp.mock.calls.length;
const ADMIN_APP_NAME = "schedule-share-admin";

function existingApp(name: string, projectId: string) {
  return { name, options: { projectId } };
}

describe("Firebase Admin configuration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    firebaseAppMocks.getApps.mockReturnValue([]);
    firebaseAppMocks.cert.mockReturnValue("certificate-credential");
    firebaseAppMocks.initializeApp.mockReturnValue("firebase-admin-app");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not initialize Firebase Admin while importing the module", () => {
    expect(initializeCallsAtImportTime).toBe(0);
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });

  it("uses App Hosting application default credentials with only a project ID", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");

    expect(hasFirebaseAdminConfig()).toBe(true);
    expect(getAdminApp()).toBe("firebase-admin-app");
    expect(firebaseAppMocks.cert).not.toHaveBeenCalled();
    expect(firebaseAppMocks.initializeApp).toHaveBeenCalledWith({
      projectId: "schedule-share-4ff0e",
    }, ADMIN_APP_NAME);
  });

  it("lets the Admin SDK read GOOGLE_APPLICATION_CREDENTIALS for local ADC", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/private/local/firebase-admin.json");

    expect(hasFirebaseAdminConfig()).toBe(true);
    getAdminApp();

    expect(firebaseAppMocks.cert).not.toHaveBeenCalled();
    expect(firebaseAppMocks.initializeApp).toHaveBeenCalledWith({
      projectId: "schedule-share-4ff0e",
    }, ADMIN_APP_NAME);
  });

  it("uses an explicit certificate only when both certificate fields are present", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "firebase-admin@example.invalid");
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "line-1\\nline-2");

    expect(hasFirebaseAdminConfig()).toBe(true);
    getAdminApp();

    expect(firebaseAppMocks.cert).toHaveBeenCalledWith({
      projectId: "schedule-share-4ff0e",
      clientEmail: "firebase-admin@example.invalid",
      privateKey: "line-1\nline-2",
    });
    expect(firebaseAppMocks.initializeApp).toHaveBeenCalledWith({
      projectId: "schedule-share-4ff0e",
      credential: "certificate-credential",
    }, ADMIN_APP_NAME);
  });

  it("reuses one named app after inline certificate initialization", () => {
    const namedApp = existingApp(ADMIN_APP_NAME, "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "firebase-admin@example.invalid");
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "line-1\\nline-2");
    firebaseAppMocks.initializeApp.mockImplementation(() => {
      firebaseAppMocks.getApps.mockReturnValue([namedApp]);
      return namedApp;
    });

    expect(getAdminApp()).toBe(namedApp);
    expect(getAdminApp()).toBe(namedApp);
    expect(firebaseAppMocks.initializeApp).toHaveBeenCalledTimes(1);
    expect(firebaseAppMocks.initializeApp).toHaveBeenCalledWith({
      projectId: "schedule-share-4ff0e",
      credential: "certificate-credential",
    }, ADMIN_APP_NAME);
  });

  it("rejects a changed project after inline certificate initialization", () => {
    const namedApp = existingApp(ADMIN_APP_NAME, "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "firebase-admin@example.invalid");
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "line-1\\nline-2");
    firebaseAppMocks.initializeApp.mockImplementation(() => {
      firebaseAppMocks.getApps.mockReturnValue([namedApp]);
      return namedApp;
    });

    expect(getAdminApp()).toBe(namedApp);
    vi.stubEnv("FIREBASE_PROJECT_ID", "different-project");

    expect(() => getAdminApp()).toThrow("Firebase Adminの既存アプリ設定が一致しません。");
    expect(firebaseAppMocks.initializeApp).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["email only", "firebase-admin@example.invalid", undefined],
    ["private key only", undefined, "private-key"],
  ])("rejects a partial explicit certificate: %s", (_label, clientEmail, privateKey) => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    if (clientEmail) vi.stubEnv("FIREBASE_CLIENT_EMAIL", clientEmail);
    if (privateKey) vi.stubEnv("FIREBASE_PRIVATE_KEY", privateKey);

    expect(hasFirebaseAdminConfig()).toBe(false);
    expect(() => getAdminApp()).toThrow("Firebase Adminの認証設定が不完全です。");
    expect(firebaseAppMocks.cert).not.toHaveBeenCalled();
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });

  it("rejects a partial explicit certificate even when an app already exists", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "firebase-admin@example.invalid");
    firebaseAppMocks.getApps.mockReturnValue([existingApp(ADMIN_APP_NAME, "schedule-share-4ff0e")]);

    expect(() => getAdminApp()).toThrow("Firebase Adminの認証設定が不完全です。");
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });

  it("reuses the named app only when its project ID exactly matches", () => {
    const namedApp = existingApp(ADMIN_APP_NAME, "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    firebaseAppMocks.getApps.mockReturnValue([namedApp]);

    expect(getAdminApp()).toBe(namedApp);
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });

  it("rejects a named app initialized for a different project", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    firebaseAppMocks.getApps.mockReturnValue([
      existingApp(ADMIN_APP_NAME, "different-project"),
    ]);

    let thrown: unknown;
    try {
      getAdminApp();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Firebase Adminの既存アプリ設定が一致しません。");
    expect((thrown as Error).message).not.toContain("schedule-share-4ff0e");
    expect((thrown as Error).message).not.toContain("different-project");
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });

  it("rejects a named app whose top-level project ID is absent", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    firebaseAppMocks.getApps.mockReturnValue([
      { name: ADMIN_APP_NAME, options: { credential: "certificate-credential" } },
    ]);

    expect(() => getAdminApp()).toThrow("Firebase Adminの既存アプリ設定が一致しません。");
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });

  it("selects the matching named app when multiple apps exist", () => {
    const namedApp = existingApp(ADMIN_APP_NAME, "schedule-share-4ff0e");
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    firebaseAppMocks.getApps.mockReturnValue([
      existingApp("other-admin", "other-project"),
      namedApp,
      existingApp("another-admin", "schedule-share-4ff0e"),
    ]);

    expect(getAdminApp()).toBe(namedApp);
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });

  it("ignores the default app and initializes its own named app", () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "schedule-share-4ff0e");
    firebaseAppMocks.getApps.mockReturnValue([
      existingApp("[DEFAULT]", "different-project"),
    ]);

    expect(getAdminApp()).toBe("firebase-admin-app");
    expect(firebaseAppMocks.initializeApp).toHaveBeenCalledWith({
      projectId: "schedule-share-4ff0e",
    }, ADMIN_APP_NAME);
  });

  it("rejects a missing project ID without exposing environment values", () => {
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "firebase-admin@example.invalid");
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "private-key");

    expect(hasFirebaseAdminConfig()).toBe(false);
    expect(() => getAdminApp()).toThrow("Firebase Adminのプロジェクト設定が不足しています。");
    expect(firebaseAppMocks.cert).not.toHaveBeenCalled();
    expect(firebaseAppMocks.initializeApp).not.toHaveBeenCalled();
  });
});
