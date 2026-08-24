import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";

import type { BotKeyRecord } from "../identity/bot-key-store";
import { BrokerKeyNotProvisionedError, BrokerKeyVault } from "./broker-key-vault";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "broker-vault-"));
  roots.push(root);
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const record: BotKeyRecord = {
    id: crypto.randomUUID(), userNpub: "npub1owner", botPubkeyHex: pubkey, botNpub: nip19.npubEncode(pubkey),
    displayName: "agent", encryptedToUser: "legacy-user", encryptedEscrow: "legacy-escrow", escrowUuid: "legacy-uuid",
    isActive: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  return { root, secretKey, record };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BrokerKeyVault", () => {
  test("uses the local encrypted vault by default", () => {
    const { root } = fixture();
    const vault = new BrokerKeyVault({ dataDir: root });
    expect(existsSync(join(root, "broker-vault", "master.key"))).toBe(true);
    expect(statSync(vault.masterKeyPath).mode & 0o777).toBe(0o600);
  });

  test("survives reconstruction and signs with the same stable identity", async () => {
    const { root, secretKey, record } = fixture();
    const first = new BrokerKeyVault({ dataDir: root });
    first.provision(record, secretKey);
    first.destroy();

    const reconstructed = new BrokerKeyVault({ dataDir: root });
    const event = await reconstructed.withKey(record, (key) => finalizeEvent({ kind: 1, content: "restart", tags: [], created_at: 1 }, key));
    expect(event.pubkey).toBe(record.botPubkeyHex);
    expect(verifyEvent(event)).toBe(true);
    expect(statSync(reconstructed.masterKeyPath).mode & 0o777).toBe(0o600);
    const envelope = readFileSync(join(reconstructed.envelopesDirectory, `${record.id}.json`), "utf8");
    expect(envelope).not.toContain(Buffer.from(secretKey).toString("hex"));
  });

  test("binds an envelope to the exact record identity", async () => {
    const { root, secretKey, record } = fixture();
    const vault = new BrokerKeyVault({ dataDir: root });
    vault.provision(record, secretKey);
    const other = { ...record, userNpub: "npub1different-owner" };
    await expect(vault.withKey(other, () => undefined)).rejects.toThrow(/identity binding/);
  });

  test("fails closed with an operator-actionable provisioning diagnostic", () => {
    const { root, record } = fixture();
    const vault = new BrokerKeyVault({ dataDir: root });
    expect(() => vault.ensureProvisioned(record)).toThrow(BrokerKeyNotProvisionedError);
    expect(() => vault.ensureProvisioned(record)).toThrow(/authenticated browser unlock once/);
  });

  test("rewraps a legacy unlock once and no longer depends on it after restart", async () => {
    const { root, secretKey, record } = fixture();
    let legacyCalls = 0;
    const first = new BrokerKeyVault({ dataDir: root });
    first.ensureProvisioned(record, () => { legacyCalls += 1; return new Uint8Array(secretKey); });
    first.destroy();
    const reconstructed = new BrokerKeyVault({ dataDir: root });
    reconstructed.ensureProvisioned(record, () => { throw new Error("legacy escrow is offline"); });
    expect(legacyCalls).toBe(1);
    expect(await reconstructed.withKey(record, (key) => getPublicKey(key))).toBe(record.botPubkeyHex);
  });

  test("removes only an identity-matching envelope", async () => {
    const { root, secretKey, record } = fixture();
    const vault = new BrokerKeyVault({ dataDir: root });
    vault.provision(record, secretKey);
    await expect(vault.remove({ ...record, userNpub: "npub1wrong" })).rejects.toThrow(/identity binding/);
    expect(vault.has(record)).toBe(true);
    await vault.remove(record);
    expect(vault.has(record)).toBe(false);
  });
});
