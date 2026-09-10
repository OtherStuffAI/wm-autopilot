import { describe, expect, test } from "bun:test";
import { validateSigningPolicyDraft } from "./signing-policy-registry";

function draft(rule: Record<string, unknown> = {}) {
  return {
    id: "synthetic-only", name: "Synthetic only", description: "Exact repository tags",
    enabled: false, operations: ["nostr.sign"], eventKinds: [30617], nip98Targets: [],
    assignments: { profileIds: [], workspaceIds: [] },
    nostrKindRules: [{
      kind: 30617, maxContentBytes: 0, maxTags: 16, maxTagBytes: 4096,
      allowedTagNames: ["d", "clone", "relays", "!"], exactTags: [["d", "synthetic"]], ...rule,
    }],
  };
}

describe("exact tag policy validation", () => {
  test.each([
    ["null", { exactTags: null }],
    ["object", { exactTags: { d: "synthetic" } }],
    ["string tag", { exactTags: ["d"] }],
    ["empty tag", { exactTags: [[]] }],
    ["empty name", { exactTags: [["", "synthetic"]] }],
    ["non-string name", { exactTags: [[1, "synthetic"]] }],
    ["non-string value", { exactTags: [["d", 1]] }],
    ["null value", { exactTags: [["d", null]] }],
    ["nested value", { exactTags: [["d", ["synthetic"]]] }],
    ["disallowed name", { exactTags: [["other", "synthetic"]] }],
    ["duplicate definition", { exactTags: [["d", "synthetic"], ["d", "synthetic"]] }],
    ["conflicting definition", { exactTags: [["d", "synthetic"], ["d", "other"]] }],
    ["required pair conflict", { requiredTags: [["d", "other"]] }],
    ["required pair in later value", { requiredTags: [["d", "other"]], exactTags: [["d", "synthetic", "other"]] }],
    ["name-only required conflict", { requiredTags: [["d", "synthetic"]], exactTags: [["d"]] }],
    ["tag count", { maxTags: 0 }],
    ["combined tag count", { maxTags: 1, requiredTags: [["clone", "repo"]] }],
    ["tag bytes", { maxTagBytes: 9 }],
    ["combined tag bytes", { maxTagBytes: 15, requiredTags: [["clone", "repo"]] }],
    ["UTF-8 tag bytes", { maxTagBytes: 4, exactTags: [["d", "🌱"]] }],
  ])("rejects %s", (_name, rule) => {
    expect(() => validateSigningPolicyDraft(draft(rule))).toThrow();
  });

  test("rejects duplicate per-kind definitions", () => {
    const input = draft();
    input.nostrKindRules.push(input.nostrKindRules[0]!);
    expect(() => validateSigningPolicyDraft(input)).toThrow("duplicate per-kind rules");
  });

  test("counts compatible required pairs once and preserves ordered full arrays", () => {
    const input = draft({
      maxTags: 1, maxTagBytes: 10, requiredTags: [["d", "synthetic"]],
    });
    expect(validateSigningPolicyDraft(input).nostrKindRules[0]!.exactTags).toEqual([["d", "synthetic"]]);
    const full = [["relays", "wss://one.example/", "wss://two.example/"], ["!"]];
    expect(validateSigningPolicyDraft(draft({ exactTags: full })).nostrKindRules[0]!.exactTags).toEqual(full);
  });

  test("omitted exactTags preserves legacy validation and pair semantics", () => {
    const input = draft({ exactTags: undefined, requiredTags: [["d", "synthetic"], ["d", "other"]] });
    const rule = validateSigningPolicyDraft(input).nostrKindRules[0]!;
    expect(Object.hasOwn(rule, "exactTags")).toBe(false);
    expect(rule.requiredTags).toEqual([["d", "synthetic"], ["d", "other"]]);
    expect(validateSigningPolicyDraft(draft({ exactTags: [] })).nostrKindRules[0]!.exactTags).toEqual([]);
  });
});
