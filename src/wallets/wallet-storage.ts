import { WalletInputError } from "./wallet-errors.ts";
import { fileURLToPath } from "node:url";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { gcm } from "@noble/ciphers/aes";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { nip19 } from "nostr-tools";

export interface WalletConfig {
  version: 1;
  botNpub: string;
  unit: "sat" | "msat";
  nonce: string;
  encryptedSeed: string;
}

export function walletRoot(dataDirectory = fileURLToPath(new URL("../../data", import.meta.url))): string {
  return resolve(process.env.WINGMAN_WALLET_DIR ?? join(dataDirectory, "bot-wallets"));
}

export function walletPath(root: string, botNpub: string): string {
  let decoded: ReturnType<typeof nip19.decode>;
  try { decoded = nip19.decode(botNpub); }
  catch { throw new WalletInputError("A canonical bot npub is required"); }
  if (decoded.type !== "npub" || nip19.npubEncode(decoded.data) !== botNpub) throw new WalletInputError("A canonical bot npub is required");
  return join(resolve(root), botNpub);
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new WalletInputError("Wallet directory must be a real directory");
  chmodSync(path, 0o700);
}

export function assertPrivateFile(path: string): void {
  if (!existsSync(path)) throw new WalletInputError("Required wallet file is missing; restore the complete backup or create a new wallet explicitly");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new WalletInputError("Wallet file must be private (0600) and regular");
}

export function readPrivate(path: string): Buffer {
  assertPrivateFile(path);
  return readFileSync(path);
}

export function writePrivate(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}

export function acquireWalletLock(directory: string): () => void {
  privateDirectory(directory);
  const path = join(directory, "wallet.lock");
  try { writePrivate(path, JSON.stringify({ pid: process.pid })); }
  catch { throw new WalletInputError("Wallet is locked; retry later or use unlock after confirming the recorded process exited"); }
  return () => unlinkSync(path);
}

export function unlockWallet(directory: string): void {
  const path = join(directory, "wallet.lock");
  const { pid } = JSON.parse(readPrivate(path).toString()) as { pid: number };
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new WalletInputError("Invalid lock; operator inspection required");
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(path); return; }
    throw error;
  }
  throw new WalletInputError("Wallet lock owner is still running");
}

function masterKey(root: string, create: boolean): Buffer {
  const path = join(root, "master.key");
  if (!existsSync(path) && create) {
    if (readdirSync(root, { withFileTypes: true }).some(entry => entry.isDirectory() && existsSync(join(root, entry.name, "wallet.json")))) {
      throw new WalletInputError("Wallet master key is missing for existing wallets; restore it before creating another wallet");
    }
    try { writePrivate(path, randomBytes(32)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const key = readPrivate(path);
  if (key.length !== 32) throw new WalletInputError("Wallet master key must be 32 bytes");
  return key;
}

export function createWalletConfig(root: string, directory: string, botNpub: string, unit: string): WalletConfig {
  if (unit !== "sat" && unit !== "msat") throw new WalletInputError("Supported Bitcoin units: sat, msat");
  privateDirectory(root);
  const key = masterKey(root, true);
  const seed = mnemonicToSeedSync(generateMnemonic(wordlist, 256));
  const nonce = randomBytes(12);
  const aad = new TextEncoder().encode(`${botNpub}:${unit}:1`);
  try {
    const encryptedSeed = Buffer.from(gcm(key, nonce, aad).encrypt(seed)).toString("base64");
    const config: WalletConfig = { version: 1, botNpub, unit, nonce: nonce.toString("base64"), encryptedSeed };
    writePrivate(join(directory, "wallet.json"), JSON.stringify(config));
    return config;
  } finally { key.fill(0); seed.fill(0); }
}

export function loadWalletConfig(directory: string, botNpub: string): WalletConfig {
  const config = JSON.parse(readPrivate(join(directory, "wallet.json")).toString()) as WalletConfig;
  if (config.version !== 1 || config.botNpub !== botNpub || !["sat", "msat"].includes(config.unit)) throw new WalletInputError("Wallet identity or unit is inconsistent");
  return config;
}

export function decryptWalletSeed(root: string, config: WalletConfig): Uint8Array {
  const key = masterKey(root, false);
  try {
    return gcm(key, Buffer.from(config.nonce, "base64"), new TextEncoder().encode(`${config.botNpub}:${config.unit}:1`))
      .decrypt(Buffer.from(config.encryptedSeed, "base64"));
  } finally { key.fill(0); }
}
