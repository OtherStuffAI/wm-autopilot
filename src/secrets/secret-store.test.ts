import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { SecretStore } from "./secret-store";
import { deniedPolicy, type SecretConsumer, type SecretPolicy } from "./secret-policy";

const key = new Uint8Array(32).fill(1);
const otherKey = new Uint8Array(32).fill(2);
const owner = nip19.npubEncode(getPublicKey(key));
const other = nip19.npubEncode(getPublicKey(otherKey));
const event = { kind: 1, content: "Synthetic test note", tags: [] };
const kindRules = [{ kind: 1, maxContentBytes: 128, maxTags: 2, maxTagBytes: 256, allowedTagNames: ["p"] }];
const consumer: SecretConsumer = { ownerNpub: owner, workspaceId: "local", identityNpub: owner, context: "pipeline", contextId: "pipeline-one" };
function policy(exportValue = false): SecretPolicy {
  return { identities: [owner, other], pipelines: { enabled: true, mode: "selected", ids: ["pipeline-one"] },
    agents: { enabled: true, mode: "selected", ids: [other] }, allowExport: exportValue, kindRules };
}
let dir: string;
let store: SecretStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wm-secrets-test-")); store = new SecretStore(join(dir, "secrets.db"), join(dir, "master.key")); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
function create(type: "secret" | "nostr" = "nostr", grant = policy()) {
  return store.create(owner, "local", { label: "Synthetic credential", type, value: type === "nostr" ? nip19.nsecEncode(key) : "synthetic-api-token", policy: grant });
}
describe("imported credential custody", () => {
  test("CRUD is owner/workspace separated, never lists/detail values, and uses CAS", () => {
    const record = create();
    expect(store.list(other, "local")).toEqual([]);
    expect(store.list(owner, "another-workspace")).toEqual([]);
    expect(() => store.get(other, "local", record.id)).toThrow("secret_not_found");
    expect(() => store.update(other, "local", record.id, { revision: 1, label: "attack" })).toThrow();
    expect(() => store.revoke(other, "local", record.id, 1)).toThrow();
    expect(JSON.stringify(store.get(owner, "local", record.id))).not.toContain("nsec1");
    expect(Object.keys(record)).not.toContain("value");
    const changed = store.update(owner, "local", record.id, { revision: 1, label: "New label" });
    expect(changed.label).toBe("New label");
    expect(() => store.update(owner, "local", record.id, { revision: 1, label: "Old" })).toThrow("stale_secret_revision");
  });
  test("unattended signing returns a verified event, never a key", () => {
    const record = create();
    const result = store.consume(record.id, consumer, "sign", event);
    expect(verifyEvent(result.event as never)).toBe(true);
    expect((result.event as any).pubkey).toBe(getPublicKey(key));
    expect(JSON.stringify(result)).not.toContain("nsec1");
    expect(store.get(owner, "local", record.id).lastUsedAt).not.toBeNull();
  });
  test.each([
    ["identity", { identityNpub: nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(3))) }],
    ["pipeline", { contextId: "other-pipeline" }],
    ["workspace", { workspaceId: "other-workspace" }],
    ["owner", { ownerNpub: other }],
    ["agent selection", { context: "session", identityNpub: owner, contextId: owner }],
    ["unknown context", { context: "unexpected", identityNpub: other, contextId: other }],
    ["agent conjunction", { context: "session", identityNpub: other, contextId: owner }],
  ])("denies %s independently of the other grant", (_label, overrides) => {
    const record = create();
    expect(() => store.consume(record.id, { ...consumer, ...overrides } as SecretConsumer, "sign", event)).toThrow();
  });
  test("all means authorized identity and same owner/workspace only; contexts can be disabled", () => {
    const grant = policy(); grant.pipelines = { enabled: true, mode: "all", ids: [] }; grant.agents = { enabled: true, mode: "all", ids: [] };
    const record = create("nostr", grant);
    expect(store.consume(record.id, { ...consumer, contextId: "another-pipeline" }, "sign", event).event).toBeDefined();
    expect(store.consume(record.id, { ...consumer, context: "session", identityNpub: other, contextId: other }, "sign", event).event).toBeDefined();
    expect(() => store.consume(record.id, { ...consumer, context: "unknown", identityNpub: other, contextId: other } as never, "sign", event)).toThrow("invalid_consumer_context");
    const invalid = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(4)));
    expect(() => store.consume(record.id, { ...consumer, identityNpub: invalid }, "sign", event)).toThrow();
    grant.pipelines.enabled = false;
    store.update(owner, "local", record.id, { revision: 1, policy: grant });
    expect(() => store.consume(record.id, consumer, "sign", event)).toThrow();
  });
  test("signing export is denied by default and explicit opt-in still checks context", () => {
    const record = create();
    expect(() => store.consume(record.id, consumer, "return")).toThrow("secret_export_denied");
    store.update(owner, "local", record.id, { revision: 1, policy: policy(true) });
    expect(store.consume(record.id, consumer, "return").value).toBe(nip19.nsecEncode(key));
    expect(() => store.consume(record.id, { ...consumer, contextId: "spoof" }, "return")).toThrow();
  });
  test("ordinary return requires explicit permission and replacing values works", () => {
    const record = create("secret");
    expect(() => store.consume(record.id, consumer, "return")).toThrow();
    store.update(owner, "local", record.id, { revision: 1, policy: policy(true), value: "replacement-token" });
    expect(store.consume(record.id, consumer, "return").value).toBe("replacement-token");
  });
  test("rotation resets identity-specific permissions including export", () => {
    const record = create("nostr", policy(true));
    const rotated = store.update(owner, "local", record.id, { revision: 1, value: nip19.nsecEncode(otherKey), policy: policy(true) });
    expect(rotated.publicNpub).toBe(other); expect(rotated.policy).toEqual(deniedPolicy());
    expect(() => store.consume(record.id, consumer, "sign", event)).toThrow();
  });
  test("revocation denies subsequent sign/export and erases ciphertext", () => {
    const record = create("nostr", policy(true));
    store.consume(record.id, consumer, "sign", event);
    store.revoke(owner, "local", record.id, 1);
    expect(() => store.consume(record.id, consumer, "sign", event)).toThrow();
    expect(() => store.consume(record.id, consumer, "return")).toThrow();
    expect(() => store.update(owner, "local", record.id, { revision: 2, value: nip19.nsecEncode(key) })).toThrow("secret_revoked");
  });
  test("durable encrypted reconstruction and safe audit", () => {
    const record = create(); store.consume(record.id, consumer, "sign", event);
    store.close(); store = new SecretStore(join(dir, "secrets.db"), join(dir, "master.key"));
    expect(verifyEvent(store.consume(record.id, consumer, "sign", event).event as never)).toBe(true);
    const bytes = readFileSync(join(dir, "secrets.db")).toString("utf8");
    expect(bytes).not.toContain(nip19.nsecEncode(key)); expect(bytes).not.toContain(Buffer.from(key).toString("hex"));
    expect(JSON.stringify(store.history(owner, "local", record.id))).not.toContain("nsec1");
    expect(statSync(join(dir, "master.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "secrets.db")).mode & 0o777).toBe(0o600);
  });
  test("malformed policy/key and signing requests fail closed", () => {
    expect(() => store.create(owner, "local", { label: "bad", type: "nostr", value: "00".repeat(32) })).toThrow("invalid_signing_key");
    expect(() => create("nostr", { ...policy(), identities: ["invalid"] })).toThrow("invalid_npub");
    expect(() => create("nostr", { ...policy(), kindRules: [{ ...kindRules[0]!, kind: 27235 }] })).toThrow("invalid_signing_kind");
    const record = create();
    expect(() => store.consume(record.id, consumer, "unknown" as never)).toThrow("invalid_secret_operation");
    for (const invalid of [{ ...event, kind: 7 }, { ...event, content: "x".repeat(129) }, { ...event, tags: [["unknown", "value"]] }, { ...event, created_at: 1 }]) {
      expect(() => store.consume(record.id, consumer, "sign", invalid)).toThrow("event_policy_denied");
    }
  });
});

test("missing wrapping key never silently regenerates for an existing database", () => {
  create(); unlinkSync(join(dir, "master.key"));
  expect(() => new SecretStore(join(dir, "secrets.db"), join(dir, "master.key"))).toThrow("secret_custody_key_missing");
  expect(() => statSync(join(dir, "master.key"))).toThrow();
});
