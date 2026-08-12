import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const ADMIN_APP_NAME = "schedule-share-admin";

export function hasFirebaseAdminConfig(): boolean {
  const projectId = nonBlank(process.env.FIREBASE_PROJECT_ID);
  const hasClientEmail = nonBlank(process.env.FIREBASE_CLIENT_EMAIL) !== null;
  const hasPrivateKey = nonBlank(process.env.FIREBASE_PRIVATE_KEY) !== null;
  return projectId !== null && hasClientEmail === hasPrivateKey;
}

export function getAdminApp(): App {
  const projectId = nonBlank(process.env.FIREBASE_PROJECT_ID);
  if (projectId === null) {
    throw new Error("Firebase Adminのプロジェクト設定が不足しています。");
  }

  const clientEmail = nonBlank(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = nonBlank(process.env.FIREBASE_PRIVATE_KEY);
  if ((clientEmail === null) !== (privateKey === null)) {
    throw new Error("Firebase Adminの認証設定が不完全です。");
  }

  const existing = getApps().find((app) => app.name === ADMIN_APP_NAME);
  if (existing) {
    if (existing.options.projectId !== projectId) {
      throw new Error("Firebase Adminの既存アプリ設定が一致しません。");
    }
    return existing;
  }

  if (clientEmail !== null && privateKey !== null) {
    return initializeApp(
      {
        projectId,
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, "\n"),
        }),
      },
      ADMIN_APP_NAME,
    );
  }

  return initializeApp(
    { projectId },
    ADMIN_APP_NAME,
  );
}

export function getAdminAuth() {
  return getAuth(getAdminApp());
}

export function getAdminFirestore() {
  return getFirestore(getAdminApp());
}

function nonBlank(value: string | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}
