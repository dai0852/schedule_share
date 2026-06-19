"use client";

import { initializeApp, getApps } from "firebase/app";
import { getAuth, OAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function hasFirebaseClientConfig(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId,
  );
}

export function getClientAuth() {
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  return getAuth(app);
}

export function getMicrosoftProvider() {
  const provider = new OAuthProvider("microsoft.com");
  provider.setCustomParameters({
    tenant: process.env.NEXT_PUBLIC_MICROSOFT_TENANT_ID ?? "common",
  });
  return provider;
}
