import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy } from "./capability-broker";
import { FileSigningPolicyStore, SigningPolicyRegistry, type SigningPolicyDraft } from "./signing-policy-registry";

const roots: string[] = [];
const customKind = 31_337;
const ownerNpub = "npub1owner";
const profileId = "profile-a";
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

function customDraft(): SigningPolicyDraft {
  return {
    id: "custom-release-event",
    name: "Custom release event",
    description: "Allows one application event with an exact release scope tag.",
    enabled: true,
    operations: ["nostr.sign"],
    eventKinds: [customKind],
    nostrKindRules: [{
      kind: customKind,
      maxContentBytes: 12,
      maxTags: 2,
      maxTagBytes: 20,
      allowedTagNames: ["scope", "p"],
      requiredTags: [["scope", "release"]],
    }],
    nip98Targets: [],
    assignments: { profileIds: [profileId], workspaceIds: [] },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wingman-custom-nostr-policy-"));
  roots.push(root);
  const registry = new SigningPolicyRegistry(new FileSigningPolicyStore(join(root, "policies.json")), {
    forgejoCompletionUrl: "https://tower.example/api/v4/git/oidc/authorize/complete",
  });
  const baseline = buildDefaultAgentCapabilityPolicy({
    towerUrl: "https://tower.example",
    autopilotUrl: "https://autopilot.example",
    ownerNpub,
  });
  const broker = new CapabilityBroker({
    botKeyStore: { getActiveKeyForUser: () => record, getActiveKeyForBotNpub: () => record },
    keyVault: { withKey: async (_record, operation) => operation(new Uint8Array(secretKey)) },
    getSession: (id) => id === session.id ? session : null,
  });
  const issue = () => {
    const resolved = registry.resolve({ profileId }, baseline);
    return broker.issueSessionCapability({
      sessionId: session.id, ownerNpub, profileId, botNpub,
      policy: resolved.policy, policyRefs: resolved.policyRefs,
    });
  };
  const call = (token: string, kind: number, content: string, tags: string[][]) => {
    const url = new URL("http://localhost/api/mcp/capabilities/nostr-event");
    const request = new Request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-wingman-capability-nonce": crypto.randomUUID(),
      },
      body: JSON.stringify({ sessionId: session.id, event: { kind, content, tags } }),
    });
    return broker.handle(request, url, "POST") as Promise<Response>;
  };
  return { broker, registry, issue, call };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("custom Nostr kind capabilities", () => {
  test("applies tight custom-kind rules only to capabilities issued with that policy revision", async () => {
    const f = fixture();
    const existing = f.issue();
    f.registry.create(customDraft(), "npub1admin");
    const issued = f.issue();

    expect((await f.call(existing.token, customKind, "release", [["scope", "release"]])).status).toBe(403);
    expect((await f.call(issued.token, customKind, "release", [["scope", "release"]])).status).toBe(200);

    const changed = customDraft();
    changed.nostrKindRules[0]!.maxContentBytes = 4;
    f.registry.update(changed.id, changed, "npub1admin");
    const replacement = f.issue();
    expect((await f.call(issued.token, customKind, "release", [["scope", "release"]])).status).toBe(200);
    expect((await f.call(replacement.token, customKind, "release", [["scope", "release"]])).status).toBe(400);
  });

  test.each([
    ["wrong tag name", customKind, "release", [["topic", "release"]], 403],
    ["missing required tag", customKind, "release", [["p", "peer"]], 403],
    ["oversized content", customKind, "x".repeat(13), [["scope", "release"]], 400],
    ["too many tags", customKind, "release", [["scope", "release"], ["p", "a"], ["p", "b"]], 400],
    ["oversized tags", customKind, "release", [["scope", "release"], ["p", "x".repeat(20)]], 400],
    ["undeclared kind", 31_338, "release", [["scope", "release"]], 403],
    ["generic NIP-98 kind", 27_235, "", [], 403],
  ])("denies %s", async (_label, kind, content, tags, status) => {
    const f = fixture();
    f.registry.create(customDraft(), "npub1admin");
    expect((await f.call(f.issue().token, kind as number, content as string, tags as string[][])).status).toBe(status);
  });

  test("fails closed when a directly issued custom kind has a missing or overbroad rule", async () => {
    const f = fixture();
    const baseline = buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example", autopilotUrl: "https://autopilot.example", ownerNpub,
    });
    baseline.nostr!.kinds.push(customKind);
    const issued = f.broker.issueSessionCapability({ sessionId: session.id, ownerNpub, profileId, botNpub, policy: baseline });
    expect((await f.call(issued.token, customKind, "release", [["scope", "release"]])).status).toBe(403);

    baseline.nostr!.kindRules = [{
      kind: customKind,
      maxContentBytes: 65_537,
      maxTags: 2,
      maxTagBytes: 20,
      allowedTagNames: ["scope"],
      requiredTags: [["scope", "release"]],
    }];
    const overbroad = f.broker.issueSessionCapability({ sessionId: session.id, ownerNpub, profileId, botNpub, policy: baseline });
    expect((await f.call(overbroad.token, customKind, "release", [["scope", "release"]])).status).toBe(403);
  });
});
