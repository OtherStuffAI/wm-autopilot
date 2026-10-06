import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { generateSecretKey, getPublicKey, getEventHash, verifyEvent, nip44 } from "nostr-tools";
import { ApplicationSigner } from "./application-signer";
import { BrokerKeyVault } from "./broker-key-vault";
import { listenUnixSigner, SIGNER_MAX_FRAME_BYTES } from "./unix-signer";
import type { BotKeyRecord } from "../identity/bot-key-store";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "app-signer-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = generateSecretKey(), peerKey = generateSecretKey();
  const record = { id: "test-key", userNpub: "owner", botNpub: "bot", botPubkeyHex: getPublicKey(key) } as BotKeyRecord;
  let active: BotKeyRecord | null = record;
  const vault = new BrokerKeyVault({ dataDir: dir });
  vault.provision(record, key);
  cleanups.push(() => vault.destroy());
  const open = () => new ApplicationSigner(join(dir, "grants.db"), () => active, vault);
  const signer = open();
  cleanups.push(() => signer.close());
  const policy = { methods: ["get_public_key", "sign_event", "nip44_encrypt", "nip44_decrypt"] as const,
    kindRules: [{ kind: 450, maxContentBytes: 4096, maxTags: 4, maxTagBytes: 1024, allowedTagNames: ["p", "x"] }], peers: [getPublicKey(peerKey)] };
  const issued = signer.register("owner", "bot", record.botPubkeyHex, { ...policy, methods: [...policy.methods] });
  const call = (method: string, params: Record<string, unknown> = {}) => signer.execute({ id: "1", credential: issued.credential, method, params });
  return { dir, signer, open, issued, record, call, peerKey, key, rotate: () => { active = null; } };
}
test("exact event, canonical id, identity, method and kind enforcement", async () => {
  const s = setup();
  const event = { pubkey: s.record.botPubkeyHex, kind: 450, created_at: 12, content: "é\n", tags: [["x", "2"], ["p", "1"], ["x", "1"]] };
  const unsigned = { ...event, id: getEventHash(event) };
  const signed = await s.call("sign_event", { event: unsigned }) as Parameters<typeof verifyEvent>[0];
  expect(verifyEvent(signed)).toBe(true);
  expect(signed).toMatchObject(unsigned);
  await expect(s.call("sign_event", { event: { ...unsigned, id: "00".repeat(32) } })).rejects.toThrow("event_id_mismatch");
  await expect(s.call("sign_event", { event: { ...unsigned, pubkey: getPublicKey(s.peerKey) } })).rejects.toThrow("identity_denied");
  await expect(s.call("sign_event", { event: { ...unsigned, kind: 445 } })).rejects.toThrow("kind_denied");
  await expect(s.call("raw_digest", {})).rejects.toThrow("method_denied");
  expect(() => s.signer.register("other", "bot", s.record.botPubkeyHex, { methods: ["get_public_key"], kindRules: [], peers: [] })).toThrow("identity_denied");
  s.rotate();
  await expect(s.call("get_public_key")).rejects.toThrow("identity_denied");
});
test("NIP-44 interoperates in both directions", async () => {
  const s = setup();
  const peer = getPublicKey(s.peerKey);
  const conversation = nip44.v2.utils.getConversationKey(s.peerKey, s.record.botPubkeyHex);
  const cipher = await s.call("nip44_encrypt", { peer, text: "from broker" }) as string;
  expect(nip44.v2.decrypt(cipher, conversation)).toBe("from broker");
  expect(await s.call("nip44_decrypt", { peer, text: nip44.v2.encrypt("from Marmot", conversation) })).toBe("from Marmot");
  await expect(s.call("nip44_encrypt", { peer: getPublicKey(generateSecretKey()), text: "no" })).rejects.toThrow("peer_denied");
});
test("persistent socket, restart and revocation preserve application authority", async () => {
  const s = setup();
  const path = join(s.dir, "private", "signer.sock");
  let listener = await listenUnixSigner(path, s.signer);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(s.dir, "private")).mode & 0o777).toBe(0o700);
  const client = connect(path);
  const request = (id: string) => new Promise<any>((resolve, reject) => {
    client.once("error", reject);
    client.once("data", chunk => resolve(JSON.parse(chunk.toString())));
    client.write(JSON.stringify({ id, credential: s.issued.credential, method: "get_public_key", params: {} }) + "\n");
  });
  expect((await request("first")).result).toBe(s.record.botPubkeyHex);
  expect((await request("second")).id).toBe("second");
  s.signer.revoke("owner", s.issued.grant.id);
  expect((await request("revoked")).error.code).toBe("unauthorized");
  client.destroy();
  await listener.close();
  const reopened = s.open();
  cleanups.push(() => reopened.close());
  listener = await listenUnixSigner(path, reopened);
  cleanups.push(() => listener.close());
  await expect(reopened.execute({ id: "reopen", credential: s.issued.credential, method: "get_public_key", params: {} })).rejects.toThrow("unauthorized");
  const large = connect(path);
  const closed = new Promise(resolve => large.once("close", resolve));
  large.write(Buffer.alloc(SIGNER_MAX_FRAME_BYTES + 1));
  await closed;
});
test("grant survives a fresh broker without any session lookup", async () => {
  const s = setup(), fresh = s.open();
  cleanups.push(() => fresh.close());
  expect(await fresh.execute({ id: "restart", credential: s.issued.credential, method: "get_public_key", params: {} })).toBe(s.record.botPubkeyHex);
});

test("kind ranges and private database sidecars are enforced", () => {
  const s = setup();
  const rule = { maxContentBytes: 0, maxTags: 0, maxTagBytes: 0, allowedTagNames: [] };
  for (const kind of [-1, 65536, 1.5, 445, 27235]) {
    expect(() => s.signer.register("owner", "bot", s.record.botPubkeyHex, {
      methods: ["sign_event"], peers: [], kindRules: [{ ...rule, kind }],
    })).toThrow("invalid_policy");
  }
  s.signer.register("owner", "bot", s.record.botPubkeyHex, {
    methods: ["sign_event"], peers: [], kindRules: [0, 65535].map(kind => ({ ...rule, kind })),
  });
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = statSync(join(s.dir, `grants.db${suffix}`));
    expect(file.isFile()).toBe(true);
    expect(file.uid).toBe(process.getuid!());
    expect(file.mode & 0o777).toBe(0o600);
  }
  const wal = join(s.dir, "grants.db-wal");
  chmodSync(wal, 0o644);
  try { expect(() => s.open()).toThrow("grant_storage_unsafe"); }
  finally { chmodSync(wal, 0o600); }
});

test("NIP-59 ephemeral peers require an explicit application-only grant", async () => {
  const s = setup(), ephemeral = generateSecretKey();
  const issued = s.signer.register("owner", "bot", s.record.botPubkeyHex, {
    methods: ["nip44_decrypt"], kindRules: [], peers: [], allowAnyPeer: true,
  });
  const conversation = nip44.v2.utils.getConversationKey(ephemeral, s.record.botPubkeyHex);
  expect(await s.signer.execute({ id: "outer-wrap", credential: issued.credential, method: "nip44_decrypt",
    params: { peer: getPublicKey(ephemeral), text: nip44.v2.encrypt("outer wrap", conversation) } })).toBe("outer wrap");
  await expect(s.signer.execute({ id: "no-sign", credential: issued.credential, method: "sign_event", params: {} })).rejects.toThrow("method_denied");
});
