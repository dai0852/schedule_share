import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type FirestoreIndex = {
  collectionGroup: string;
  queryScope: string;
  fields: Array<{ fieldPath: string; order: string }>;
};

function readProjectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Firebase deployment configuration", () => {
  it("Firestore client access is denied for every document", () => {
    expect(readProjectFile("firestore.rules")).toBe([
      "rules_version = '2';",
      "service cloud.firestore {",
      "  match /databases/{database}/documents {",
      "    match /{document=**} {",
      "      allow read, write: if false;",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"));
  });

  it("declares only the composite indexes used by the event and member queries", () => {
    const config = JSON.parse(readProjectFile("firestore.indexes.json")) as {
      indexes: FirestoreIndex[];
      fieldOverrides: unknown[];
    };

    expect(config).toEqual({
      indexes: [
        index("events", "endEpochMs", "startEpochMs"),
        index("events", "ownerUserId", "endEpochMs", "startEpochMs"),
        index("events", "source", "endEpochMs", "startEpochMs"),
        index("events", "ownerUserId", "source", "endEpochMs", "startEpochMs"),
        index("salesMembers", "active", "displayName"),
      ],
      fieldOverrides: [],
    });
  });

  it("points Firebase CLI only at the Firestore rules and index files", () => {
    expect(JSON.parse(readProjectFile("firebase.json"))).toEqual({
      firestore: {
        rules: "firestore.rules",
        indexes: "firestore.indexes.json",
      },
    });
  });

  it("ignores environment, Firebase Admin credential, and Firebase cache paths without ignoring .env.example", () => {
    const ignoredPaths = [
      ".env.production",
      "nested/.env.production",
      "schedule-share-4ff0e-firebase-adminsdk-abc.json",
      "nested/schedule-share-4ff0e-firebase-adminsdk-abc.json",
      ".firebase/cache.json",
      "nested/.firebase/cache.json",
    ];
    const allowedPaths = [".env.example", "nested/.env.example"];
    const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: process.cwd(),
      input: [...ignoredPaths, ...allowedPaths].join("\n"),
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").filter(Boolean)).toEqual(ignoredPaths);
  });
});

function index(collectionGroup: string, ...fieldPaths: string[]): FirestoreIndex {
  return {
    collectionGroup,
    queryScope: "COLLECTION",
    fields: fieldPaths.map((fieldPath) => ({ fieldPath, order: "ASCENDING" })),
  };
}
