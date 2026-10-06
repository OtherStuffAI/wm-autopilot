import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { BotKeyStore } from "../identity/bot-key-store";
import { ApplicationSigner, type ApplicationGrantPolicy } from "./application-signer";
import { BrokerKeyVault } from "./broker-key-vault";
import { registerLocalApplication, updateLocalApplicationContentBound } from "./local-application-management";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "local-app-management-"));
  roots.push(dataDir);
  const store = new BotKeyStore(join(dataDir, "bot-keys.db"));
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const record = store.createKey({ userNpub: "owner", botNpub: nip19.npubEncode(pubkey), botPubkeyHex: pubkey,
    displayName: "test", encryptedToUser: "test", encryptedEscrow: "test", escrowUuid: "test" });
  const vault = new BrokerKeyVault({ dataDir });
  vault.provision(record, key);
  key.fill(0);
  const signer = new ApplicationSigner(join(dataDir, "application-grants.db"), npub => store.getActiveKeyForBotNpub(npub), vault);
  signer.close();
  vault.destroy();
  mkdirSync(join(dataDir, "private"), { mode: 0o700 });
  return { dataDir, record, credentialFile: join(dataDir, "private", "credential"),
    masterKeyPath: join(dataDir, "broker-vault", "master.key"), ownerNpub: record.userNpub,
    botNpub: record.botNpub, expectedPubkey: record.botPubkeyHex,
    policy: { methods: ["get_public_key"], kindRules: [], peers: [] } as ApplicationGrantPolicy };
}
test("local grant uses existing custody and captures a private credential without replacing output", async () => {
  const input = fixture();
  const grant = await registerLocalApplication(input);
  expect(grant.pubkey).toBe(input.expectedPubkey);
  expect(statSync(input.credentialFile).mode & 0o777).toBe(0o600);
  expect(statSync(input.credentialFile).nlink).toBe(1);
  const credential = readFileSync(input.credentialFile, "utf8").trim();
  const vault = new BrokerKeyVault({ dataDir: input.dataDir });
  const signer = new ApplicationSigner(join(input.dataDir, "application-grants.db"), () => input.record, vault);
  try {
    expect(await signer.execute({ id: "1", credential, method: "get_public_key", params: {} })).toBe(input.expectedPubkey);
    await expect(registerLocalApplication(input)).rejects.toThrow();
    expect(readFileSync(input.credentialFile, "utf8").trim()).toBe(credential);
    signer.revoke(input.ownerNpub, grant.id);
    await expect(signer.execute({ id: "2", credential, method: "get_public_key", params: {} })).rejects.toThrow("unauthorized");
  } finally { signer.close(); vault.destroy(); }
});
test("local grant refuses mismatched ownership and never creates missing custody", async () => {
  const input = fixture();
  await expect(registerLocalApplication({ ...input, ownerNpub: "another-owner" })).rejects.toThrow("identity_denied");
  expect(existsSync(input.credentialFile)).toBe(false);
  unlinkSync(input.masterKeyPath);
  await expect(registerLocalApplication(input)).rejects.toThrow();
  expect(existsSync(input.masterKeyPath)).toBe(false);
  expect(existsSync(input.credentialFile)).toBe(false);
});
test("local capture refuses symlink outputs and cleans up a rejected policy", async () => {
  const input = fixture();
  symlinkSync(input.masterKeyPath, input.credentialFile);
  await expect(registerLocalApplication(input)).rejects.toThrow();
  expect(statSync(input.masterKeyPath).size).toBe(32);
  unlinkSync(input.credentialFile);
  await expect(registerLocalApplication({ ...input, policy: { ...input.policy, kindRules: [
    { kind: 445, maxContentBytes: 0, maxTags: 0, maxTagBytes: 0, allowedTagNames: [] },
  ] } })).rejects.toThrow("invalid_policy");
  expect(existsSync(input.credentialFile)).toBe(false);
});

test("local content bound update preserves credential bytes and checks existing custody", async () => {
  const input = fixture();
  input.policy = { methods: ["get_public_key", "sign_event"], peers: [], kindRules: [
    { kind: 450, maxContentBytes: 47, maxTags: 0, maxTagBytes: 0, allowedTagNames: [] },
  ] };
  const grant = await registerLocalApplication(input);
  const bytes = readFileSync(input.credentialFile);
  const update = { ...input, expectedGrant: grant, kind: 450, maxContentBytes: 49 };
  const updated = await updateLocalApplicationContentBound(update);
  expect(updated.policy.kindRules[0]!.maxContentBytes).toBe(49);
  expect(readFileSync(input.credentialFile)).toEqual(bytes);
  await expect(updateLocalApplicationContentBound(update)).rejects.toThrow("stale_grant");
  await expect(updateLocalApplicationContentBound({ ...update, ownerNpub: "wrong" })).rejects.toThrow("identity_denied");
  await expect(updateLocalApplicationContentBound({ ...update, expectedGrant: { ...grant, botNpub: "wrong" } })).rejects.toThrow("identity_denied");
});


test("operator CLI permits only one content bound and rejects broader proposed policy", async () => {
  const input = fixture();
  input.policy = { methods: ["get_public_key", "sign_event"], peers: [], kindRules: [
    { kind: 450, maxContentBytes: 47, maxTags: 0, maxTagBytes: 0, allowedTagNames: [] },
  ] };
  const grant = await registerLocalApplication(input);
  const original = { ownerNpub: input.ownerNpub, botNpub: input.botNpub,
    expectedPubkey: input.expectedPubkey, policy: input.policy };
  const before = join(input.dataDir, "private", "before.json");
  const proposed = join(input.dataDir, "private", "after.json");
  const metadata = join(input.dataDir, "private", "grant.json");
  writeFileSync(before, JSON.stringify(original), { mode: 0o600 });
  writeFileSync(metadata, JSON.stringify(grant), { mode: 0o600 });
  const after = structuredClone(original);
  after.policy.kindRules[0]!.maxContentBytes = 49;
  const run = async () => {
    const proc = Bun.spawn(["bun", "clis/wingman-application.ts", "update-content-bound",
      "--request-file", proposed, "--expected-request-file", before, "--grant-file", metadata,
      "--data-dir", input.dataDir, "--master-key-file", input.masterKeyPath], { stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
  };
  writeFileSync(proposed, JSON.stringify({ ...after, policy: { ...after.policy, allowAnyPeer: true } }), { mode: 0o600 });
  expect((await run()).code).toBe(1);
  writeFileSync(proposed, JSON.stringify(after));
  const credential = readFileSync(input.credentialFile, "utf8");
  const result = await run();
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).id).toBe(grant.id);
  expect(result.out + result.err).not.toContain(credential.trim());
  expect(readFileSync(input.credentialFile, "utf8")).toBe(credential);
  expect((await run()).code).toBe(1);
});
