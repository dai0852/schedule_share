import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  getGoogleTokenEncryptionKey,
} from "./tokenCrypto";

const KEY = randomBytes(32);
const ENV_KEY = "GOOGLE_TOKEN_ENCRYPTION_KEY";
const originalEnvironmentKey = process.env[ENV_KEY];
const MAX_SECRET_BYTES = 16 * 1024;

function replaceBase64Character(value: string): string {
  const replacement = value[0] === "A" ? "B" : "A";
  return replacement + value.slice(1);
}

function createAuthenticatedSecret(plaintext: string, iv: Buffer, authTagLength = 16) {
  const cipher = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

describe("tokenCrypto", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnvironmentKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnvironmentKey;
  });

  it("モジュール読み込み時に環境変数が未設定でも暗号化キーを要求しない", () => {
    delete process.env[ENV_KEY];

    expect(() => getGoogleTokenEncryptionKey()).toThrow("Google認証情報の暗号鍵が無効です。");
  });

  it("復号でき、暗号文に平文を含めない", () => {
    const plaintext = "refresh-token-secret";
    const encrypted = encryptSecret(plaintext, KEY);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(Buffer.from(encrypted.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(encrypted.authTag, "base64")).toHaveLength(16);
    expect(decryptSecret(encrypted, KEY)).toBe(plaintext);
  });

  it("暗号化ごとにランダムなIVを使用する", () => {
    const first = encryptSecret("refresh-token", KEY);
    const second = encryptSecret("refresh-token", KEY);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("Unicodeの認証情報を往復できる", () => {
    const plaintext = "更新トークン🔐漢字";

    expect(decryptSecret(encryptSecret(plaintext, KEY), KEY)).toBe(plaintext);
  });

  it.each([
    undefined,
    "",
    "not-base64!",
    randomBytes(31).toString("base64"),
    randomBytes(33).toString("base64"),
  ])("無効な環境変数の暗号鍵を固定エラーで拒否する: %s", (key) => {
    if (key === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = key;

    expect(() => getGoogleTokenEncryptionKey()).toThrow("Google認証情報の暗号鍵が無効です。");
  });

  it("base64環境変数の32バイト鍵を取得する", () => {
    process.env[ENV_KEY] = KEY.toString("base64");

    expect(getGoogleTokenEncryptionKey()).toEqual(KEY);
  });

  it.each(["", 42, null])("空または文字列以外の平文を拒否する", (plaintext) => {
    expect(() => encryptSecret(plaintext as string, KEY)).toThrow("認証情報を暗号化できません。");
  });

  it.each([randomBytes(31), randomBytes(33)])("32バイト以外のBuffer鍵を拒否する", (key) => {
    expect(() => encryptSecret("refresh-token", key)).toThrow("認証情報を暗号化できません。");
    expect(() => decryptSecret(encryptSecret("refresh-token", KEY), key)).toThrow("暗号化された認証情報を復号できません。");
  });

  it.each(["ciphertext", "authTag", "iv"] as const)("改ざんされた%sを復号しない", (field) => {
    const encrypted = encryptSecret("refresh-token", KEY);
    encrypted[field] = replaceBase64Character(encrypted[field]);

    expect(() => decryptSecret(encrypted, KEY)).toThrow("暗号化された認証情報を復号できません。");
  });

  it("異なる鍵では復号しない", () => {
    const encrypted = encryptSecret("refresh-token", KEY);

    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow("暗号化された認証情報を復号できません。");
  });

  it("16-byte IVで正しく認証された暗号文も拒否する", () => {
    const encrypted = createAuthenticatedSecret("refresh-token", randomBytes(16));

    expect(() => decryptSecret(encrypted, KEY)).toThrow("暗号化された認証情報を復号できません。");
  });

  it("15-byte auth tagで正しく認証された暗号文も拒否する", () => {
    const encrypted = createAuthenticatedSecret("refresh-token", randomBytes(12), 15);

    expect(() => decryptSecret(encrypted, KEY)).toThrow("暗号化された認証情報を復号できません。");
  });

  it("正しく認証された空の認証情報も拒否する", () => {
    const encrypted = createAuthenticatedSecret("", randomBytes(12));

    expect(() => decryptSecret(encrypted, KEY)).toThrow("暗号化された認証情報を復号できません。");
  });

  it.each([
    ["ciphertext", (encrypted: ReturnType<typeof createAuthenticatedSecret>) => ({ ...encrypted, ciphertext: `${encrypted.ciphertext}\n   ` })],
    ["iv", (encrypted: ReturnType<typeof createAuthenticatedSecret>) => ({ ...encrypted, iv: `${encrypted.iv}\n   ` })],
    ["authTag", (encrypted: ReturnType<typeof createAuthenticatedSecret>) => ({ ...encrypted, authTag: `${encrypted.authTag}\n   ` })],
  ] as const)("非canonicalなbase64の%sを拒否する", (_field, mutate) => {
    const encrypted = createAuthenticatedSecret("refresh-token", randomBytes(12));

    expect(() => decryptSecret(mutate(encrypted), KEY)).toThrow("暗号化された認証情報を復号できません。");
  });

  it("非canonicalなbase64環境変数の鍵を拒否する", () => {
    process.env[ENV_KEY] = `${KEY.toString("base64")}\n   `;

    expect(() => getGoogleTokenEncryptionKey()).toThrow("Google認証情報の暗号鍵が無効です。");
  });

  it("巨大な平文を暗号化しない", () => {
    expect(() => encryptSecret("a".repeat(MAX_SECRET_BYTES + 1), KEY)).toThrow("認証情報を暗号化できません。");
  });

  it("ちょうど16KiBの平文を暗号化・復号できる", () => {
    const plaintext = "a".repeat(MAX_SECRET_BYTES);

    expect(decryptSecret(encryptSecret(plaintext, KEY), KEY)).toBe(plaintext);
  });

  it("文字数ではなくUTF-8 byte長が16KiBを超える平文を拒否する", () => {
    const plaintext = "あ".repeat(Math.floor(MAX_SECRET_BYTES / 3) + 1);

    expect(plaintext.length).toBeLessThan(MAX_SECRET_BYTES);
    expect(Buffer.byteLength(plaintext, "utf8")).toBeGreaterThan(MAX_SECRET_BYTES);
    expect(() => encryptSecret(plaintext, KEY)).toThrow("認証情報を暗号化できません。");
  });

  it("巨大なbase64暗号文をdecode前に拒否する", () => {
    const encrypted = createAuthenticatedSecret("refresh-token", randomBytes(12));
    encrypted.ciphertext = "A".repeat(Math.ceil(MAX_SECRET_BYTES / 3) * 4 + 4);

    expect(() => decryptSecret(encrypted, KEY)).toThrow("暗号化された認証情報を復号できません。");
  });

  it.each(["ciphertext", "iv", "authTag"] as const)("巨大な%sをdecode前に拒否する", (field) => {
    const encrypted = createAuthenticatedSecret("refresh-token", randomBytes(12));
    const hugeValue = "A".repeat(MAX_SECRET_BYTES * 4);
    encrypted[field] = hugeValue;
    const from = vi.spyOn(Buffer, "from");

    expect(() => decryptSecret(encrypted, KEY)).toThrow("暗号化された認証情報を復号できません。");
    expect(from).not.toHaveBeenCalledWith(hugeValue, "base64");
  });

  it("巨大な文字列鍵をdecode前に拒否する", () => {
    const hugeKey = "A".repeat(MAX_SECRET_BYTES * 4);
    const from = vi.spyOn(Buffer, "from");

    expect(() => encryptSecret("refresh-token", hugeKey)).toThrow("認証情報を暗号化できません。");
    expect(from).not.toHaveBeenCalledWith(hugeKey, "base64");
  });

  it.each([
    { ciphertext: "!invalid-base64!", iv: randomBytes(12).toString("base64"), authTag: randomBytes(16).toString("base64") },
    { ciphertext: randomBytes(1).toString("base64"), iv: randomBytes(11).toString("base64"), authTag: randomBytes(16).toString("base64") },
    { ciphertext: randomBytes(1).toString("base64"), iv: randomBytes(12).toString("base64"), authTag: randomBytes(15).toString("base64") },
  ])("不正な暗号化済み認証情報を固定エラーで拒否する", (encrypted) => {
    expect(() => decryptSecret(encrypted, KEY)).toThrow("暗号化された認証情報を復号できません。");
  });
});
