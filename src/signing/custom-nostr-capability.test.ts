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
  const loadRegistry = () => new SigningPolicyRegistry(new FileSigningPolicyStore(join(root, "policies.json")), {
    forgejoCompletionUrl: "https://tower.example/api/v4/git/oidc/authorize/complete",
  });
  let registry = loadRegistry();
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
  return { broker, registry, issue, call, reload: () => { registry = loadRegistry(); return registry; } };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const relay = "ws://relay.example:41007/";
const clone = "http://relay.example:41007/publisher/synthetic.git";

function syntheticDraft(): SigningPolicyDraft {
  return {
    ...customDraft(),
    eventKinds: [22242, 30617, 30618],
    nostrKindRules: [
      { kind: 22242, maxContentBytes: 0, maxTags: 2, maxTagBytes: 4096,
        allowedTagNames: ["relay", "challenge"], exactTags: [["relay", relay]] },
      { kind: 30617, maxContentBytes: 0, maxTags: 16, maxTagBytes: 4096,
        allowedTagNames: ["d", "name", "description", "clone", "relays", "web", "r", "maintainers", "t", "!"],
        exactTags: [["d", "synthetic"], ["clone", clone], ["relays", relay]] },
      { kind: 30618, maxContentBytes: 0, maxTags: 16, maxTagBytes: 4096,
        allowedTagNames: ["d", "HEAD", "refs/heads/main", "!", "r"], exactTags: [["d", "synthetic"]] },
    ],
  };
}

function syntheticTags(kind: number): string[][] {
  return kind === 30617
    ? [["d", "synthetic"], ["name", "Synthetic"], ["description", "Test repository"],
      ["clone", clone], ["relays", relay], ["r", "a".repeat(40), "euc"]]
    : [["d", "synthetic"], ["HEAD", "ref: refs/heads/main"], ["refs/heads/main", "b".repeat(40)]];
}

describe("exact Nostr tag capabilities through persisted policy compilation", () => {
  test.each([30617, 30618])("accepts synthetic kind %i and denies identifier bypasses after reload", async (kind) => {
    const f = fixture();
    const draft = syntheticDraft();
    f.registry.create(draft, "npub1admin");
    const reloaded = f.reload();
    expect(reloaded.get(draft.id)!.nostrKindRules.map((rule) => rule.exactTags))
      .toEqual(draft.nostrKindRules.map((rule) => rule.exactTags));
    expect(reloaded.getHistory(draft.id)[0]!.snapshot.nostrKindRules).toEqual(reloaded.get(draft.id)!.nostrKindRules);
    const token = f.issue().token;
    const valid = syntheticTags(kind);
    const response = await f.call(token, kind, "", valid);
    expect(response.status).toBe(200);
    expect((await response.json()).event.tags).toEqual(valid);
    const others = valid.filter((tag) => tag[0] !== "d");
    for (const identifiers of [
      [], [["d", "other"]], [["d"]], [["d", "synthetic", "other"]],
      [["d", "synthetic"], ["d", "other"]], [["d", "other"], ["d", "synthetic"]],
      [["d", "synthetic"], ["d", "synthetic"]],
    ]) {
      expect((await f.call(token, kind, "", [...identifiers, ...others])).status).toBe(403);
    }
    if (kind === 30618) {
      for (const name of ["clone", "relays"]) {
        expect((await f.call(token, kind, "", [...valid, [name, "https://public.example/"]])).status).toBe(403);
      }
    }
  });

  test.each(["clone", "relays"])("rejects missing, changed, extra and duplicate %s destinations", async (name) => {
    const f = fixture();
    f.registry.create(syntheticDraft(), "npub1admin");
    f.reload();
    const token = f.issue().token;
    const valid = syntheticTags(30617);
    const expected = valid.find((tag) => tag[0] === name)!;
    const others = valid.filter((tag) => tag[0] !== name);
    const publicTag = [name, name === "clone" ? "https://public.example/repo.git" : "wss://public.example/"];
    for (const destinations of [
      [], [publicTag], [[...expected, publicTag[1]!]], [[...expected, expected[1]!]],
      [expected, publicTag], [publicTag, expected], [expected, expected],
    ]) {
      expect((await f.call(token, 30617, "", [...others, ...destinations])).status).toBe(403);
    }
  });

  test("NIP-42 permits a changing challenge but requires one exact relay tag", async () => {
    const f = fixture();
    f.registry.create(syntheticDraft(), "npub1admin");
    const token = f.issue().token;
    for (const challenge of ["challenge-one", "challenge-two"]) {
      expect((await f.call(token, 22242, "", [["relay", relay], ["challenge", challenge]])).status).toBe(200);
    }
    for (const tags of [
      [["relay", relay.slice(0, -1)], ["challenge", "nonce"]],
      [["relay", relay, "wss://public.example/"]],
      [["relay", relay], ["relay", "wss://public.example/"]],
      [["relay", "wss://public.example/"], ["relay", relay]],
      [["relay", relay], ["relay", relay]],
    ]) expect((await f.call(token, 22242, "", tags)).status).toBe(403);
  });

  test("compares multiple values in order and supports a name-only exact tag", async () => {
    const f = fixture();
    const draft = syntheticDraft();
    const rule = draft.nostrKindRules[1]!;
    rule.exactTags = [["d", "synthetic"], ["relays", relay, "wss://second.example/"], ["!"]];
    rule.requiredTags = [["relays", relay]];
    f.registry.create(draft, "npub1admin");
    const token = f.issue().token;
    const valid = [["d", "synthetic"], ["relays", relay, "wss://second.example/"], ["!"]];
    expect((await f.call(token, 30617, "", valid)).status).toBe(200);
    for (const relays of [["relays", relay], ["relays", "wss://second.example/", relay]]) {
      expect((await f.call(token, 30617, "", [valid[0]!, relays, valid[2]!])).status).toBe(403);
    }
    expect((await f.call(token, 30617, "", [valid[0]!, valid[1]!, ["!", "extra"]])).status).toBe(403);
  });

  test("legacy requiredTags still permits matching pairs with duplicates and extra values", async () => {
    const f = fixture();
    const draft = syntheticDraft();
    for (const rule of draft.nostrKindRules) {
      rule.requiredTags = rule.exactTags!.map((tag) => [tag[0], tag[1]!]);
      delete rule.exactTags;
    }
    f.registry.create(draft, "npub1admin");
    f.reload();
    const token = f.issue().token;
    expect((await f.call(token, 30617, "", [
      ["d", "other"], ...syntheticTags(30617), ["clone", "https://public.example/repo.git"],
      ["relays", relay, "wss://public.example/"],
    ])).status).toBe(200);
  });

  test("new exact-tag revisions restrict newly issued snapshots without rewriting old ones", async () => {
    const f = fixture();
    const legacy = syntheticDraft();
    delete legacy.nostrKindRules[2]!.exactTags;
    legacy.nostrKindRules[2]!.requiredTags = [["d", "synthetic"]];
    f.registry.create(legacy, "npub1admin");
    const old = f.issue();
    f.registry.update(legacy.id, syntheticDraft(), "npub1admin");
    f.reload();
    const updated = f.issue();
    const tags = [["d", "other"], ...syntheticTags(30618)];
    expect((await f.call(old.token, 30618, "", tags)).status).toBe(200);
    expect((await f.call(updated.token, 30618, "", tags)).status).toBe(403);
  });

  test("broker rejects malformed exact rules even when issued outside the registry", async () => {
    const f = fixture();
    const policy = buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example", autopilotUrl: "https://autopilot.example", ownerNpub,
    });
    policy.nostr!.kinds.push(30618);
    policy.nostr!.kindRules = [syntheticDraft().nostrKindRules[2]!];
    policy.nostr!.kindRules[0]!.exactTags!.push(["d", "other"]);
    const issued = f.broker.issueSessionCapability({ sessionId: session.id, ownerNpub, profileId, botNpub, policy });
    expect((await f.call(issued.token, 30618, "", syntheticTags(30618))).status).toBe(403);
  });
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
