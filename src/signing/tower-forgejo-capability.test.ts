import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";

import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy } from "./capability-broker";
import {
  FileSigningPolicyStore,
  SigningPolicyRegistry,
  TOWER_FORGEJO_POLICY_ID,
  type SigningPolicyDocument,
  type SigningPolicyDraft,
} from "./signing-policy-registry";

const roots: string[] = [];
const ownerNpub = "npub1owner";
const profileId = "profile-a";
const completionUrl = "https://tower.example/api/v4/git/oidc/authorize/complete";
const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);
const botNpub = nip19.npubEncode(pubkey);
const record: BotKeyRecord = {
  id: "record-a", userNpub: ownerNpub, botNpub, botPubkeyHex: pubkey, displayName: "Agent",
  encryptedToUser: "unused", encryptedEscrow: "unused", escrowUuid: "unused", isActive: 1,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const session: SessionSnapshot = {
  id: "session-a", agent: "codex", port: 3700, name: "A", status: "running",
  startedAt: new Date().toISOString(), npub: ownerNpub, command: [], workingDirectory: "/tmp", logs: [],
  metadata: { agentProfileId: profileId, agentChatBotNpub: botNpub },
};

function draft(policy: SigningPolicyDocument): SigningPolicyDraft {
  return {
    id: policy.id, name: policy.name, description: policy.description, enabled: policy.enabled,
    operations: [...policy.operations], eventKinds: [...policy.eventKinds],
    nostrKindRules: structuredClone(policy.nostrKindRules),
    nip98Targets: structuredClone(policy.nip98Targets), assignments: structuredClone(policy.assignments),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wingman-forgejo-policy-"));
  roots.push(root);
  let now = 1_800_000_000_000;
  const registry = new SigningPolicyRegistry(new FileSigningPolicyStore(join(root, "policies.json")), {
    forgejoCompletionUrl: completionUrl,
    now: () => now,
  });
  const template = registry.get(TOWER_FORGEJO_POLICY_ID)!;
  registry.update(template.id, { ...draft(template), enabled: true, assignments: { profileIds: [profileId], workspaceIds: [] } }, "npub1admin");
  const baseline = buildDefaultAgentCapabilityPolicy({ towerUrl: "https://tower.example", autopilotUrl: "https://autopilot.example", ownerNpub });
  const resolved = registry.resolve({ profileId }, baseline);
  const audit: unknown[] = [];
  const broker = new CapabilityBroker({
    botKeyStore: { getActiveKeyForUser: () => record, getActiveKeyForBotNpub: () => record },
    keyVault: { withKey: async (_record, operation) => operation(new Uint8Array(secretKey)) },
    getSession: (id) => id === session.id ? session : null,
    now: () => now,
    audit: (entry) => audit.push(entry),
  });
  const issued = broker.issueSessionCapability({
    sessionId: session.id, ownerNpub, profileId, botNpub,
    policy: resolved.policy, policyRefs: resolved.policyRefs,
  });
  const call = (body: Record<string, unknown>, nonce = crypto.randomUUID()) => {
    const url = new URL("http://localhost/api/mcp/capabilities/nip98");
    const request = new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", "x-wingman-capability-nonce": nonce },
      body: JSON.stringify({ sessionId: session.id, ...body }),
    });
    return broker.handle(request, url, "POST") as Promise<Response>;
  };
  return { broker, registry, issued, call, audit, get now() { return now; }, set now(value) { now = value; } };
}

function challenge(requestId = "opaque-request", expiration = 1_800_000_060) {
  const rawBody = JSON.stringify({ request_id: requestId });
  return {
    url: completionUrl,
    method: "POST",
    bodyHash: createHash("sha256").update(rawBody).digest("hex"),
    tags: [["nonce", requestId], ["aud", "forgejo-client"], ["expiration", String(expiration)]],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Tower Forgejo capability", () => {
  test("produces exactly the canonical and challenge tags without the private binding tag", async () => {
    const f = fixture();
    const response = await f.call(challenge());
    expect(response.status).toBe(200);
    const result = await response.json() as { token: string };
    const event = JSON.parse(Buffer.from(result.token.slice("Nostr ".length), "base64").toString()) as { kind: number; tags: string[][] };
    expect(verifyEvent(event as never)).toBe(true);
    expect(event.kind).toBe(27_235);
    expect(event.tags).toEqual([
      ["u", completionUrl], ["method", "POST"], ["payload", challenge().bodyHash],
      ["nonce", "opaque-request"], ["aud", "forgejo-client"], ["expiration", "1800000060"],
    ]);
    expect(JSON.stringify(f.audit)).not.toContain(f.issued.token);
  });

  test.each([
    ["wrong origin", { url: "https://other.example/api/v4/git/oidc/authorize/complete" }],
    ["wrong path", { url: "https://tower.example/api/v4/git/oidc/authorize" }],
    ["wrong method", { method: "GET" }],
    ["missing tag", { tags: [["nonce", "opaque-request"], ["aud", "forgejo-client"]] }],
    ["duplicate tag", { tags: [["nonce", "opaque-request"], ["nonce", "again"], ["aud", "forgejo-client"], ["expiration", "1800000060"]] }],
    ["unapproved tag", { tags: [["nonce", "opaque-request"], ["aud", "forgejo-client"], ["expiration", "1800000060"], ["u", completionUrl]] }],
    ["blank tag value", { tags: [["nonce", "opaque-request"], ["aud", "   "], ["expiration", "1800000060"]] }],
    ["wrong body hash", { bodyHash: "ab".repeat(32) }],
    ["absent body hash", { bodyHash: undefined }],
    ["expired", { tags: [["nonce", "opaque-request"], ["aud", "forgejo-client"], ["expiration", "1799999999"]] }],
    ["far future", { tags: [["nonce", "opaque-request"], ["aud", "forgejo-client"], ["expiration", "1800000061"]] }],
  ])("denies %s", async (_label, changes) => {
    const f = fixture();
    expect((await f.call({ ...challenge(), ...changes })).status).not.toBe(200);
  });

  test("denies replay and does not grant generic kind-27235 signing", async () => {
    const f = fixture();
    expect((await f.call(challenge())).status).toBe(200);
    const reordered = challenge();
    reordered.tags.reverse();
    expect((await f.call(reordered)).status).toBe(403);
    const url = new URL("http://localhost/api/mcp/capabilities/nostr-event");
    const request = new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${f.issued.token}`, "content-type": "application/json", "x-wingman-capability-nonce": crypto.randomUUID() },
      body: JSON.stringify({ sessionId: session.id, event: { kind: 27_235, content: "", tags: [] } }),
    });
    expect((await f.broker.handle(request, url, "POST"))!.status).toBe(403);
  });

  test("reports an expired capability while its bound session remains active", () => {
    const f = fixture();
    f.now += 3 * 60 * 60_000;
    expect(f.broker.listActiveCapabilities()).toHaveLength(1);
  });

  test("keeps edited authority stale until explicit revoke and reissue", async () => {
    const f = fixture();
    const template = f.registry.get(TOWER_FORGEJO_POLICY_ID)!;
    const changed = draft(template);
    changed.description = "Shortened challenge freshness window.";
    changed.nip98Targets[0]!.challenge!.allowedTags
      .find((rule) => rule.name === "expiration")!.maxFutureSeconds = 30;
    f.registry.update(template.id, changed, "npub1admin");

    expect(f.registry.resolveReferences({ profileId })).toEqual(expect.arrayContaining([
      { id: TOWER_FORGEJO_POLICY_ID, revision: 3 },
    ]));
    expect(f.broker.listActiveCapabilities()[0]?.policyRefs).toEqual(expect.arrayContaining([
      { id: TOWER_FORGEJO_POLICY_ID, revision: 2 },
    ]));
    expect((await f.call(challenge("old-snapshot", 1_800_000_050))).status).toBe(200);

    const refreshUrl = new URL("http://localhost/api/mcp/capabilities/refresh");
    const refresh = new Request(refreshUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${f.issued.token}`, "content-type": "application/json", "x-wingman-capability-nonce": crypto.randomUUID() },
      body: JSON.stringify({ sessionId: session.id }),
    });
    const refreshed = (await f.broker.handle(refresh, refreshUrl, "POST"))!;
    expect((await refreshed.json() as { policyRefs: unknown }).policyRefs).toEqual(expect.arrayContaining([
      { id: TOWER_FORGEJO_POLICY_ID, revision: 2 },
    ]));

    const baseline = buildDefaultAgentCapabilityPolicy({ towerUrl: "https://tower.example", autopilotUrl: "https://autopilot.example", ownerNpub });
    const current = f.registry.resolve({ profileId }, baseline);
    const replacement = f.broker.reissueSessionCapability(session.id, () => f.broker.issueSessionCapability({
      sessionId: session.id, ownerNpub, profileId, botNpub, policy: current.policy, policyRefs: current.policyRefs,
    }));
    expect(replacement.policyRefs).toEqual(expect.arrayContaining([{ id: TOWER_FORGEJO_POLICY_ID, revision: 3 }]));
    expect((await f.call(challenge("revoked-old", 1_800_000_020))).status).toBe(409);

    const requestUrl = new URL("http://localhost/api/mcp/capabilities/nip98");
    const request = new Request(requestUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${replacement.token}`, "content-type": "application/json", "x-wingman-capability-nonce": crypto.randomUUID() },
      body: JSON.stringify({ sessionId: session.id, ...challenge("new-short-policy", 1_800_000_050) }),
    });
    expect((await f.broker.handle(request, requestUrl, "POST"))!.status).toBe(400);
  });
});
