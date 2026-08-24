import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getSessionSecretBytes } from "../auth/session-secret";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;

export interface TodoPayload {
  title: string;
  description?: string | null;
  dueDate?: string | null;
}

export interface EncryptedTodoPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

let cachedKey: Buffer | null = null;

const getEncryptionKey = (): Buffer => {
  if (cachedKey) {
    return cachedKey;
  }
  const secret = getSessionSecretBytes();
  cachedKey = createHash("sha256").update(secret).digest().subarray(0, KEY_LENGTH);
  return cachedKey;
};

export const encryptTodoPayload = (payload: TodoPayload): EncryptedTodoPayload => {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const input = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
};

export const decryptTodoPayload = (payload: EncryptedTodoPayload): TodoPayload => {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch (error) {
    throw new Error(`Failed to parse todo payload: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid todo payload");
  }

  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) {
    throw new Error("Todo payload missing title");
  }

  const description =
    typeof record.description === "string"
      ? record.description
      : record.description === null
        ? null
        : undefined;
  const dueDate =
    typeof record.dueDate === "string"
      ? record.dueDate
      : record.dueDate === null
        ? null
        : undefined;

  return {
    title,
    description,
    dueDate,
  };
};
