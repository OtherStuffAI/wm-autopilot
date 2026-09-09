import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy } from "./capability-broker";
import { FileSigningPolicyStore, SigningPolicyRegistry, type SigningPolicyDraft } from "./signing-policy-registry";
import { validateSigningPolicyDraft } from "./signing-policy-validation";

const nodeNpub = "npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74";
const origin = `http://${nodeNpub}.fips:43100`;
const roots: string[] = [];
function draft(targetOrigin = origin): SigningPolicyDraft {
  return {
    id: "mesh-policy", name: "Mesh policy", description: "Constrained mesh access", enabled: true,
    operations: ["nip98.sign"], eventKinds: [27_235], nostrKindRules: [],
    nip98Targets: [{ origin: targetOrigin, methods: ["GET", "POST"], exactPaths: ["/health"],
      pathPrefixes: ["/api/v4/flightdeck-pg/workspaces/workspace-a"], requireBodyHash: true }],
    assignments: { profileIds: ["profile-a"], workspaceIds: ["workspace-a"] },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([origin, `http://${nodeNpub}.fips:1`, `http://${nodeNpub}.fips:65535`, "https://service.example", "https://service.example:8443"])("accepts and round-trips exact origin %s", (value) => {
  const validated = validateSigningPolicyDraft(draft(value));
  expect(validated.nip98Targets[0]!.origin).toBe(value);
  expect(validateSigningPolicyDraft(validated)).toEqual(validated);
});

test.each([
  "http://service.example:43100", "http://localhost:43100", "http://127.0.0.1:43100", "http://[::1]:43100",
  "http://npub1fake.fips:43100", `http://${nodeNpub.slice(0, -1)}q.fips:43100`,
  `http://${nip19.npubEncode("ab".repeat(31))}.fips:43100`,
  `http://${nip19.npubEncode("ab".repeat(33))}.fips:43100`,
  `http://${nodeNpub.toUpperCase()}.fips:43100`, `HTTP://${nodeNpub}.fips:43100`,
  `http://${nodeNpub}.FIPS:43100`, `http://${nodeNpub}.fips.:43100`,
  `http://sub.${nodeNpub}.fips:43100`, `http://*.fips:43100`,
  `http://user@${nodeNpub}.fips:43100`, `http://user:pass@${nodeNpub}.fips:43100`,
  `http://${nodeNpub}.fips`, `http://${nodeNpub}.fips:`,
  ...["0", "80", "080", "043100", "65536", "999999", "-1", "+43100", "4.31e4", "43100.0", "0xa85c", "43100 "].map((port) => `http://${nodeNpub}.fips:${port}`),
  ...["/", "/path", "?x=1", "?", "#x", "#", "/../", "\\", "\n"].map((suffix) => origin + suffix),
  ` ${origin}`, origin.replace("npub", "%6epub"),
  "https://*.example", "https://service.example/", "https://user@service.example", "https://service.example?x=1",
])("rejects unsafe or noncanonical origin %s", (value) => {
  expect(() => validateSigningPolicyDraft(draft(value))).toThrow(/NIP-98 origin/);
});

test("FIPS policies retain assignment, path, method and body-hash validation", () => {
  const value = draft();
  expect(() => validateSigningPolicyDraft({ ...value, assignments: null as never })).toThrow(/assignments/);
  for (const change of [{ methods: ["TRACE"] }, { requireBodyHash: false }, { pathPrefixes: ["/api/v4"] }]) {
    expect(() => validateSigningPolicyDraft({ ...value, nip98Targets: [{ ...value.nip98Targets[0]!, ...change }] })).toThrow();
  }
});

test("mesh grant requires matching assignment and explicit reissue; broker enforces exact authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "wingman-fips-policy-"));
  roots.push(root);
  const registry = new SigningPolicyRegistry(new FileSigningPolicyStore(join(root, "policies.json")), { forgejoCompletionUrl: "https://tower.example/api/v4/git/oidc/authorize/complete" });
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const botNpub = nip19.npubEncode(pubkey);
  const ownerNpub = "npub1owner";
  const record = { userNpub: ownerNpub, botNpub, botPubkeyHex: pubkey } as BotKeyRecord;
  const session = { id: "session-a", status: "running", npub: ownerNpub,
    metadata: { agentProfileId: "profile-a", agentChatBotNpub: botNpub } } as SessionSnapshot;
  const baseline = buildDefaultAgentCapabilityPolicy({ towerUrl: "https://tower.example", autopilotUrl: "https://autopilot.example", ownerNpub });
  const broker = new CapabilityBroker({
    botKeyStore: { getActiveKeyForUser: () => record, getActiveKeyForBotNpub: () => record },
    keyVault: { withKey: async (_record, operation) => operation(new Uint8Array(secret)) },
    getSession: (id) => id === session.id ? session : null,
  });
  const issue = () => {
    const resolved = registry.resolve({ profileId: "profile-a", workspaceId: "workspace-a" }, baseline);
    return broker.issueSessionCapability({ sessionId: session.id, ownerNpub, botNpub,
      profileId: "profile-a", workspaceId: "workspace-a", ...resolved });
  };
  const call = (token: string, url = `${origin}/health`, method = "GET", bodyHash?: string) => {
    const endpoint = new URL("http://localhost/api/mcp/capabilities/nip98");
    return broker.handle(new Request(endpoint, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "x-wingman-capability-nonce": crypto.randomUUID(),
    }, body: JSON.stringify({ sessionId: session.id, url, method, bodyHash }) }), endpoint, "POST") as Promise<Response>;
  };
  const old = issue();
  expect((await call(old.token)).status).toBe(403);
  registry.create(draft(), "npub1admin");
  for (const context of [{ profileId: "other", workspaceId: "workspace-a" }, { profileId: "profile-a", workspaceId: "other" }, {}]) {
    expect(registry.resolve(context, baseline).policy).toEqual(baseline);
  }
  expect((await call(old.token)).status).toBe(403);
  const issued = broker.reissueSessionCapability(session.id, issue);
  expect((await call(old.token)).status).toBe(409);
  expect((await call(issued.token)).status).toBe(400);
  const allowed = await call(issued.token, `${origin}/health`, "GET", "ab".repeat(32));
  expect(allowed.status).toBe(200);
  const payload = await allowed.json() as { token: string };
  const event = JSON.parse(Buffer.from(payload.token.slice("Nostr ".length), "base64").toString());
  expect(verifyEvent(event)).toBe(true);
  expect(event.tags).toContainEqual(["u", `${origin}/health`]);
  for (const deniedUrl of [origin.replace(":43100", ":43101") + "/health", "http://localhost:43100/health", `${origin}/health/extra`, `${origin}/api/admin/signing-policies`, `${origin}/api/v4/flightdeck-pg/workspaces/workspace-ab/tasks`]) {
    expect((await call(issued.token, deniedUrl)).status).toBe(403);
  }
  expect((await call(issued.token, `${origin}/health`, "DELETE", "ab".repeat(32))).status).toBe(403);
  const path = `${origin}/api/v4/flightdeck-pg/workspaces/workspace-a/tasks`;
  expect((await call(issued.token, path, "POST")).status).toBe(400);
  expect((await call(issued.token, path, "POST", "invalid")).status).toBe(400);
  expect((await call(issued.token, path, "POST", "ab".repeat(32))).status).toBe(200);
});
