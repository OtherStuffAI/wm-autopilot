import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

interface StoredRuntimeEnvelope {
  version: typeof ENVELOPE_VERSION;
  appId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface AppRuntimeEnvelopeReference {
  path: string;
  key: string;
}

function appEnvelopeAad(appId: string): Buffer {
  return Buffer.from(`wingman-app-runtime-env:${appId}`, "utf8");
}

export async function createAppRuntimeEnvelope(
  directory: string,
  appId: string,
  env: Record<string, string>,
): Promise<AppRuntimeEnvelopeReference> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const key = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(appEnvelopeAad(appId));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(env), "utf8")),
    cipher.final(),
  ]);
  const payload: StoredRuntimeEnvelope = {
    version: ENVELOPE_VERSION,
    appId,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  return { path, key: key.toString("base64url") };
}

export async function removeAppRuntimeEnvelope(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
  }
}

export async function consumeAppRuntimeEnvelope(
  reference: AppRuntimeEnvelopeReference,
  expectedAppId: string,
): Promise<Record<string, string>> {
  try {
    const payload = JSON.parse(await Bun.file(reference.path).text()) as Partial<StoredRuntimeEnvelope>;
    if (payload.version !== ENVELOPE_VERSION || payload.appId !== expectedAppId) {
      throw new Error("Managed app runtime environment envelope does not match this app");
    }
    if (!payload.iv || !payload.authTag || !payload.ciphertext) {
      throw new Error("Managed app runtime environment envelope is incomplete");
    }
    const key = Buffer.from(reference.key, "base64url");
    if (key.length !== KEY_BYTES) {
      throw new Error("Managed app runtime environment envelope key is invalid");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
    decipher.setAAD(appEnvelopeAad(expectedAppId));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Managed app runtime environment payload is invalid");
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new Error(`Managed app runtime environment value for ${name} is invalid`);
      }
      env[name] = value;
    }
    return env;
  } finally {
    await removeAppRuntimeEnvelope(reference.path);
  }
}
