import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getSessionSecretBytes } from "../auth/session-secret";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const ENCRYPTED_PREFIX = "enc::";

interface EncryptedSettingPayload {
  v: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

const deriveKey = (): Buffer => {
  const secret = getSessionSecretBytes();
  return createHash("sha256").update(secret).digest().subarray(0, KEY_LENGTH);
};

export const isEncryptedSettingValue = (value: string): boolean => {
  return value.startsWith(ENCRYPTED_PREFIX);
};

export const encryptSettingValue = (plaintext: string): string => {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload: EncryptedSettingPayload = {
    v: 1,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };

  return `${ENCRYPTED_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;
};

export const decryptSettingValue = (value: string): string => {
  if (!isEncryptedSettingValue(value)) {
    return value;
  }

  const encodedPayload = value.slice(ENCRYPTED_PREFIX.length);
  const parsed = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8")) as Partial<EncryptedSettingPayload>;
  if (parsed.v !== 1 || !parsed.iv || !parsed.authTag || !parsed.ciphertext) {
    throw new Error("Invalid encrypted setting payload");
  }

  const key = deriveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
};
