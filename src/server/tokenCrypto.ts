import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_BASE64_LENGTH = Math.ceil(MAX_SECRET_BYTES / 3) * 4;
const INVALID_KEY_ERROR = "Google認証情報の暗号鍵が無効です。";
const ENCRYPTION_ERROR = "認証情報を暗号化できません。";
const DECRYPTION_ERROR = "暗号化された認証情報を復号できません。";

/** Google Calendarのrefresh tokenを保存するためのサーバー専用AES鍵を取得する。 */
export function getGoogleTokenEncryptionKey(): Buffer {
  return parseKey(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY, INVALID_KEY_ERROR);
}

export function encryptSecret(plaintext: string, key?: string | Buffer): EncryptedSecret {
  if (typeof plaintext !== "string" || plaintext.length === 0 || Buffer.byteLength(plaintext, "utf8") > MAX_SECRET_BYTES) {
    throw new Error(ENCRYPTION_ERROR);
  }

  try {
    const encryptionKey = key === undefined ? getGoogleTokenEncryptionKey() : parseKey(key, ENCRYPTION_ERROR);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  } catch {
    throw new Error(ENCRYPTION_ERROR);
  }
}

export function decryptSecret(encrypted: EncryptedSecret, key?: string | Buffer): string {
  try {
    const encryptionKey = key === undefined ? getGoogleTokenEncryptionKey() : parseKey(key, DECRYPTION_ERROR);
    if (!encrypted || typeof encrypted !== "object") throw new Error(DECRYPTION_ERROR);

    if (typeof encrypted.ciphertext !== "string" || encrypted.ciphertext.length > MAX_CIPHERTEXT_BASE64_LENGTH) {
      throw new Error(DECRYPTION_ERROR);
    }
    const ciphertext = parseBase64(encrypted.ciphertext, DECRYPTION_ERROR);
    const iv = parseBase64(encrypted.iv, DECRYPTION_ERROR, IV_LENGTH);
    const authTag = parseBase64(encrypted.authTag, DECRYPTION_ERROR, AUTH_TAG_LENGTH);
    if (ciphertext.length === 0) throw new Error(DECRYPTION_ERROR);

    const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length === 0 || plaintext.length > MAX_SECRET_BYTES) throw new Error(DECRYPTION_ERROR);
    return plaintext.toString("utf8");
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}

function parseKey(value: string | Buffer | undefined, errorMessage: string): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length !== KEY_LENGTH) throw new Error(errorMessage);
    return value;
  }

  return parseBase64(value, errorMessage, KEY_LENGTH);
}

function parseBase64(value: unknown, errorMessage: string, expectedLength?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) throw new Error(errorMessage);
  if (expectedLength !== undefined && value.length !== base64LengthForBytes(expectedLength)) throw new Error(errorMessage);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(errorMessage);
  if (expectedLength !== undefined && decoded.length !== expectedLength) throw new Error(errorMessage);
  return decoded;
}

function base64LengthForBytes(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}
