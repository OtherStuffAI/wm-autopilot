import { createCipheriv, createDecipheriv, getCiphers, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getPublicKey } from "nostr-tools";

import type { BotKeyRecord } from "../identity/bot-key-store";

const ENVELOPE_VERSION = 1;
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_DATA_DIR = new URL("../../data", import.meta.url).pathname;

export const BROKER_KEY_NOT_PROVISIONED = "broker_key_not_provisioned";
export const BROKER_KEY_IDENTITY_MISMATCH = "broker_key_identity_mismatch";

export class BrokerKeyIdentityMismatchError extends Error {
  readonly code = BROKER_KEY_IDENTITY_MISMATCH;

  constructor(message: string) {
    super(message);
    this.name = "BrokerKeyIdentityMismatchError";
  }
}

export interface BrokerKeyVaultBackend {
  has(record: BotKeyRecord): boolean;
  provision(record: BotKeyRecord, secretKey: Uint8Array): void;
  remove(record: BotKeyRecord): Promise<void>;
  ensureProvisioned(record: BotKeyRecord, legacyUnlock?: (record: BotKeyRecord) => Uint8Array): void;
  withKey<T>(record: BotKeyRecord, operation: (secretKey: Uint8Array) => T | Promise<T>): Promise<T>;
}

interface VaultEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  ownerNpub: string;
  botPubkeyHex: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  updatedAt: string;
}

export class BrokerKeyNotProvisionedError extends Error {
  readonly code = BROKER_KEY_NOT_PROVISIONED;

  constructor(readonly ownerNpub: string, readonly botNpub: string) {
    super(`${BROKER_KEY_NOT_PROVISIONED}: stable agent key ${botNpub} is not provisioned in the broker vault; complete the authenticated browser unlock once, then retry`);
    this.name = "BrokerKeyNotProvisionedError";
  }
}

function aadFor(record: BotKeyRecord): Buffer {
  return Buffer.from(`wm-broker-v1\0${record.id}\0${record.userNpub}\0${record.botPubkeyHex}`, "utf8");
}

function assertMode0600(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) chmodSync(path, 0o600);
}

function writePrivateAtomic(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/**
 * Durable local custody for stable agent signing keys.
 *
 * This prevents accidental propagation through child environments, argv and
 * generated configuration. It is not an isolation boundary against code with
 * the same OS-user/filesystem access as Autopilot; that code can recover the
 * agent-owned key material. Human, instance-root and minting credentials must
 * remain outside this vault and outside agent processes.
 */
export class BrokerKeyVault implements BrokerKeyVaultBackend {
  readonly masterKeyPath: string;
  readonly envelopesDirectory: string;
  private readonly masterKey: Uint8Array;

  constructor(input: {
    dataDir?: string;
    masterKeyPath?: string;
    envelopesDirectory?: string;
  } = {}) {
    if (!getCiphers().includes("aes-256-gcm")) throw new Error("AES-256-GCM is unavailable in this runtime");
    const dataDir = input.dataDir ?? DEFAULT_DATA_DIR;
    this.masterKeyPath = input.masterKeyPath
      ?? process.env.WINGMAN_BROKER_MASTER_KEY_FILE?.trim()
      ?? join(dataDir, "broker-vault", "master.key");
    this.envelopesDirectory = input.envelopesDirectory ?? join(dataDir, "broker-vault", "keys");
    this.masterKey = this.loadOrCreateMasterKey();
  }

  has(record: BotKeyRecord): boolean {
    return Bun.file(this.envelopePath(record)).size > 0;
  }

  ensureProvisioned(record: BotKeyRecord, legacyUnlock?: (record: BotKeyRecord) => Uint8Array): void {
    if (this.has(record)) return;
    if (!legacyUnlock) throw new BrokerKeyNotProvisionedError(record.userNpub, record.botNpub);
    let secretKey: Uint8Array | null = null;
    try {
      secretKey = legacyUnlock(record);
      this.provision(record, secretKey);
    } catch (error) {
      if (error instanceof BrokerKeyNotProvisionedError) throw error;
      throw new BrokerKeyNotProvisionedError(record.userNpub, record.botNpub);
    } finally {
      secretKey?.fill(0);
    }
  }

  provision(record: BotKeyRecord, secretKey: Uint8Array): void {
    if (secretKey.byteLength !== 32 || getPublicKey(secretKey) !== record.botPubkeyHex) {
      throw new Error("Broker vault provisioning key does not match the stable agent identity");
    }
    const plaintext = new Uint8Array(secretKey);
    const nonce = randomBytes(NONCE_BYTES);
    try {
      const cipher = createCipheriv("aes-256-gcm", this.masterKey, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadFor(record));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: VaultEnvelope = {
        version: ENVELOPE_VERSION,
        algorithm: "aes-256-gcm",
        keyId: record.id,
        ownerNpub: record.userNpub,
        botPubkeyHex: record.botPubkeyHex,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        updatedAt: new Date().toISOString(),
      };
      writePrivateAtomic(this.envelopePath(record), `${JSON.stringify(envelope)}\n`);
    } finally {
      plaintext.fill(0);
      nonce.fill(0);
    }
  }

  async remove(record: BotKeyRecord): Promise<void> {
    const path = this.envelopePath(record);
    if (!this.has(record)) return;
    // Decrypting first makes removal identity-bound instead of allowing a
    // mismatched record id to delete another profile's envelope.
    await this.withKey(record, () => undefined);
    unlinkSync(path);
  }

  async withKey<T>(record: BotKeyRecord, operation: (secretKey: Uint8Array) => T | Promise<T>): Promise<T> {
    const path = this.envelopePath(record);
    let envelope: VaultEnvelope;
    try {
      assertMode0600(path);
      envelope = JSON.parse(readFileSync(path, "utf8")) as VaultEnvelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BrokerKeyNotProvisionedError(record.userNpub, record.botNpub);
      }
      throw new Error(`Broker vault envelope could not be read for ${record.botNpub}`);
    }
    if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== "aes-256-gcm"
      || envelope.keyId !== record.id || envelope.ownerNpub !== record.userNpub
      || envelope.botPubkeyHex !== record.botPubkeyHex) {
      throw new BrokerKeyIdentityMismatchError("Broker vault envelope identity binding does not match the requested stable agent");
    }
    const nonce = Buffer.from(envelope.nonce, "base64url");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    let secretKey: Uint8Array | null = null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadFor(record));
      decipher.setAuthTag(tag);
      secretKey = new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
      if (secretKey.byteLength !== 32 || getPublicKey(secretKey) !== record.botPubkeyHex) {
        throw new BrokerKeyIdentityMismatchError("Broker vault plaintext does not match the stable agent identity");
      }
      return await operation(secretKey);
    } finally {
      secretKey?.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  }

  destroy(): void {
    this.masterKey.fill(0);
  }

  private envelopePath(record: BotKeyRecord): string {
    return join(this.envelopesDirectory, `${record.id}.json`);
  }

  private loadOrCreateMasterKey(): Uint8Array {
    try {
      assertMode0600(this.masterKeyPath);
      const key = readFileSync(this.masterKeyPath);
      if (key.byteLength !== MASTER_KEY_BYTES) throw new Error("Broker vault master key must contain exactly 32 bytes");
      return new Uint8Array(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(MASTER_KEY_BYTES);
      try {
        writePrivateAtomic(this.masterKeyPath, key);
        return new Uint8Array(key);
      } finally {
        key.fill(0);
      }
    }
  }
}

export function createBrokerKeyVaultBackend(): BrokerKeyVaultBackend {
  const backend = process.env.WINGMAN_BROKER_VAULT_BACKEND?.trim().toLowerCase() ?? "";
  if (backend && backend !== "file") {
    throw new Error(`Unsupported WINGMAN_BROKER_VAULT_BACKEND: ${backend}`);
  }
  return new BrokerKeyVault();
}
