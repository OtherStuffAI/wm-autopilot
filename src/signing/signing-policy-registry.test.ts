import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildDefaultAgentCapabilityPolicy } from "./capability-broker";
import {
  DEFAULT_AGENT_POLICY_ID,
  FileSigningPolicyStore,
  SigningPolicyRegistry,
  TOWER_FORGEJO_POLICY_ID,
  type SigningPolicyDocument,
  type SigningPolicyDraft,
} from "./signing-policy-registry";

const roots: string[] = [];
const completionUrl = "https://tower.example/api/v4/git/oidc/authorize/complete";
const baseline = buildDefaultAgentCapabilityPolicy({
  towerUrl: "https://tower.example",
  autopilotUrl: "https://autopilot.example",
  ownerNpub: "npub1owner",
});

function registry(now = 1_800_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), "wingman-signing-policy-"));
  roots.push(root);
  const path = join(root, "policies.json");
  return { path, registry: new SigningPolicyRegistry(new FileSigningPolicyStore(path), { forgejoCompletionUrl: completionUrl, now: () => now }) };
}

function narrowDraft(id = "custom-nip98"): SigningPolicyDraft {
  return {
    id,
    name: "Narrow API writer",
    description: "Allows one body-bound application endpoint.",
    enabled: true,
    operations: ["nip98.sign"],
    eventKinds: [27_235],
    nostrKindRules: [],
    nip98Targets: [{
      origin: "https://service.example",
      methods: ["POST"],
      exactPaths: ["/api/v4/items/create"],
      pathPrefixes: [],
      requireBodyHash: true,
    }],
    assignments: { profileIds: ["profile-a"], workspaceIds: [] },
  };
}

function customNostrDraft(): SigningPolicyDraft {
  return {
    id: "custom-nostr",
    name: "Custom Nostr event",
    description: "Allows a constrained application event kind.",
    enabled: true,
    operations: ["nostr.sign"],
    eventKinds: [31_337],
    nostrKindRules: [{
      kind: 31_337,
      maxContentBytes: 1_024,
      maxTags: 8,
      maxTagBytes: 2_048,
      allowedTagNames: ["scope", "p"],
      requiredTags: [["scope", "release"]],
    }],
    nip98Targets: [],
    assignments: { profileIds: ["profile-a"], workspaceIds: [] },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SigningPolicyRegistry", () => {
  test("preserves the built-in baseline when no custom assignment applies", () => {
    const { registry: policies } = registry();
    const resolved = policies.resolve({ profileId: "unassigned" }, baseline);
    expect(resolved.policy).toEqual(baseline);
    expect(resolved.policyRefs).toEqual([{ id: DEFAULT_AGENT_POLICY_ID, revision: 1 }]);
    expect(policies.get(TOWER_FORGEJO_POLICY_ID)).toMatchObject({ enabled: false, revision: 1, builtIn: "template" });
  });

  test("persists revisions, actors, and immutable snapshots across reconstruction", () => {
    const { path, registry: first } = registry();
    first.create(narrowDraft(), "npub1admin");
    first.update("custom-nip98", { ...narrowDraft(), description: "Revision two remains narrow." }, "npub1pete");
    const second = new SigningPolicyRegistry(new FileSigningPolicyStore(path), { forgejoCompletionUrl: completionUrl });
    expect(second.get("custom-nip98")).toMatchObject({ revision: 2, updatedBy: "npub1pete" });
    expect(second.getHistory("custom-nip98").map((entry) => [entry.revision, entry.actorNpub, entry.snapshot.description])).toEqual([
      [2, "npub1pete", "Revision two remains narrow."],
      [1, "npub1admin", "Allows one body-bound application endpoint."],
    ]);
  });

  test("resolves profile and workspace assignments with deterministic AND scoping and ID order", () => {
    const { registry: policies } = registry();
    policies.create({ ...narrowDraft("z-policy"), assignments: { profileIds: ["profile-a"], workspaceIds: ["workspace-a"] } }, "npub1admin");
    policies.create({ ...narrowDraft("a-policy"), nip98Targets: [{ ...narrowDraft().nip98Targets[0]!, exactPaths: ["/api/v4/items/other"] }], assignments: { profileIds: ["profile-a"], workspaceIds: [] } }, "npub1admin");
    expect(policies.resolveReferences({ profileId: "profile-a", workspaceId: "workspace-a" }).map((ref) => ref.id)).toEqual([
      DEFAULT_AGENT_POLICY_ID, "a-policy", "z-policy",
    ]);
    expect(policies.resolveReferences({ profileId: "profile-a", workspaceId: "workspace-b" }).map((ref) => ref.id)).toEqual([
      DEFAULT_AGENT_POLICY_ID, "a-policy",
    ]);
    expect(policies.resolveReferences({ profileId: "profile-b", workspaceId: "workspace-a" })).toEqual([
      { id: DEFAULT_AGENT_POLICY_ID, revision: 1 },
    ]);
  });

  test("fails closed when two assigned fragments overlap", () => {
    const { registry: policies } = registry();
    policies.create(narrowDraft("first-policy"), "npub1admin");
    policies.create({
      ...narrowDraft("second-policy"),
      nip98Targets: [{ ...narrowDraft().nip98Targets[0]!, exactPaths: [], pathPrefixes: ["/api/v4/items"] }],
    }, "npub1admin");
    expect(() => policies.resolve({ profileId: "profile-a" }, baseline)).toThrow(/overlapping NIP-98 target/);
  });

  test.each([
    ["wildcard origin", { origin: "https://*.example" }],
    ["non-HTTPS origin", { origin: "http://tower.example" }],
    ["unsafe method", { methods: ["TRACE"] }],
    ["overbroad prefix", { exactPaths: [], pathPrefixes: ["/api/v4"] }],
    ["missing body hash", { requireBodyHash: false }],
  ])("rejects %s", (_label, targetChange) => {
    const { registry: policies } = registry();
    const draft = narrowDraft();
    draft.nip98Targets[0] = { ...draft.nip98Targets[0]!, ...targetChange };
    expect(() => policies.create(draft, "npub1admin")).toThrow();
  });

  test("rejects generic kind 27235, unknown operations, malformed challenge tags, and long expiry", () => {
    const { registry: policies } = registry();
    expect(() => policies.create({ ...narrowDraft(), operations: ["nostr.sign"], eventKinds: [27_235], nip98Targets: [] }, "npub1admin")).toThrow(/27235/);
    expect(() => policies.create({ ...narrowDraft(), operations: ["unknown" as never] }, "npub1admin")).toThrow(/Unknown/);
    const template = policies.get(TOWER_FORGEJO_POLICY_ID)!;
    const malformed = draftFrom(template);
    malformed.nip98Targets[0]!.challenge!.allowedTags.push({ name: "nonce", valueType: "non-empty", maxLength: 2 });
    expect(() => policies.update(template.id, malformed, "npub1admin")).toThrow(/only nonce, aud, and expiration/);
    const longExpiry = draftFrom(template);
    longExpiry.nip98Targets[0]!.challenge!.allowedTags.find((rule) => rule.name === "expiration")!.maxFutureSeconds = 61;
    expect(() => policies.update(template.id, longExpiry, "npub1admin")).toThrow(/1 and 60/);
  });

  test("requires one bounded matching rule for every custom Nostr kind", () => {
    const { registry: policies } = registry();
    expect(policies.create(customNostrDraft(), "npub1admin")).toMatchObject({
      eventKinds: [31_337],
      nostrKindRules: [{ kind: 31_337, maxContentBytes: 1_024 }],
    });
    expect(() => policies.create({ ...customNostrDraft(), id: "missing-rule", nostrKindRules: [] }, "npub1admin")).toThrow(/exactly one matching/);
    expect(() => policies.create({
      ...customNostrDraft(), id: "duplicate-rule",
      nostrKindRules: [customNostrDraft().nostrKindRules[0]!, customNostrDraft().nostrKindRules[0]!],
    }, "npub1admin")).toThrow(/duplicate per-kind rules/);
    expect(() => policies.create({
      ...customNostrDraft(), id: "mismatched-rule",
      nostrKindRules: [{ ...customNostrDraft().nostrKindRules[0]!, kind: 31_338 }],
    }, "npub1admin")).toThrow(/match one declared/);
    expect(() => policies.create({
      ...customNostrDraft(), id: "broad-rule",
      nostrKindRules: [{ ...customNostrDraft().nostrKindRules[0]!, maxContentBytes: 65_537 }],
    }, "npub1admin")).toThrow(/between 0 and 65536/);
    expect(() => policies.create({
      ...customNostrDraft(), id: "malformed-rule",
      nostrKindRules: [{ ...customNostrDraft().nostrKindRules[0]!, requiredTags: [["other", "value"]] }],
    }, "npub1admin")).toThrow(/must also be allowed/);
  });
});

function draftFrom(policy: SigningPolicyDocument): SigningPolicyDraft {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    enabled: policy.enabled,
    operations: [...policy.operations],
    eventKinds: [...policy.eventKinds],
    nostrKindRules: structuredClone(policy.nostrKindRules),
    nip98Targets: structuredClone(policy.nip98Targets),
    assignments: structuredClone(policy.assignments),
  };
}
