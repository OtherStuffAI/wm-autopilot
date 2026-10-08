import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SecretError } from "./secret-policy";

export function assertPrivateFile(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new SecretError("secret_storage_unsafe", 503);
}
export function privateDatabaseFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertPrivateFile(path);
  closeSync(openSync(path, "a", 0o600));
}
/** Separate imported-user domain; never reuses bot/instance/Tier2 key custody. */
export class SecretCustody {
  private readonly key: Uint8Array;
  constructor(path: string, requireExisting = false) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    assertPrivateFile(path);
    if (!lstatSync(path, { throwIfNoEntry: false })) {
      if (requireExisting) throw new SecretError("secret_custody_key_missing", 503);
      try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    assertPrivateFile(path);
    this.key = new Uint8Array(readFileSync(path));
    if (this.key.length !== 32) throw new SecretError("invalid_custody_key", 503);
  }
  encrypt(value: Uint8Array, binding: string): string {
    const nonce = randomBytes(12);
    const ciphertext = gcm(this.key, nonce, new TextEncoder().encode(binding)).encrypt(value);
    return JSON.stringify({ v: 1, nonce: nonce.toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") });
  }
  withValue<T>(envelope: string, binding: string, operation: (value: Uint8Array) => T): T {
    let value: Uint8Array | undefined;
    try {
      const data = JSON.parse(envelope);
      if (data.v !== 1) throw new Error();
      value = gcm(this.key, Buffer.from(data.nonce, "base64"), new TextEncoder().encode(binding)).decrypt(Buffer.from(data.ciphertext, "base64"));
      return operation(value);
    } finally { value?.fill(0); }
  }
  close(): void { this.key.fill(0); }
}
