import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getSessionSecretBytes } from "../auth/session-secret";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;

export interface EncryptedTeamKey {
  iv: string;
  authTag: string;
  ciphertext: string;
}

const deriveKey = (): Buffer => {
  const secret = getSessionSecretBytes();
  return createHash("sha256").update(secret).digest().subarray(0, KEY_LENGTH);
};

export const encryptTeamProviderKey = (plaintext: string): EncryptedTeamKey => {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
};

export const decryptTeamProviderKey = (payload: EncryptedTeamKey): string => {
  const key = deriveKey();
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
};

