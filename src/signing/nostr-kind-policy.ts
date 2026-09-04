export const MAX_CUSTOM_NOSTR_CONTENT_BYTES = 65_536;
export const MAX_CUSTOM_NOSTR_TAGS = 64;
export const MAX_CUSTOM_NOSTR_TAG_BYTES = 16_384;
const MAX_CUSTOM_NOSTR_TAG_NAMES = 32;
const MAX_CUSTOM_NOSTR_TAG_NAME_BYTES = 64;

export interface NostrKindConstraint {
  kind: number;
  maxContentBytes: number;
  maxTags: number;
  maxTagBytes: number;
  allowedTagNames: string[];
  requiredTags?: Array<[string, string]>;
}

export function normalizeNostrKindRules(value: unknown, customKinds: number[]): NostrKindConstraint[] {
  if (value === undefined) value = [];
  if (!Array.isArray(value)) throw new Error("nostrKindRules must be an array");
  const rules = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Each custom Nostr kind requires a structured per-kind rule");
    }
    const rule = candidate as Partial<NostrKindConstraint>;
    if (!Number.isInteger(rule.kind) || !customKinds.includes(rule.kind!)) {
      throw new Error("Each Nostr kind rule must match one declared custom event kind");
    }
    if (!Number.isInteger(rule.maxContentBytes) || rule.maxContentBytes! < 0 || rule.maxContentBytes! > MAX_CUSTOM_NOSTR_CONTENT_BYTES) {
      throw new Error(`Custom Nostr maxContentBytes must be between 0 and ${MAX_CUSTOM_NOSTR_CONTENT_BYTES}`);
    }
    if (!Number.isInteger(rule.maxTags) || rule.maxTags! < 0 || rule.maxTags! > MAX_CUSTOM_NOSTR_TAGS) {
      throw new Error(`Custom Nostr maxTags must be between 0 and ${MAX_CUSTOM_NOSTR_TAGS}`);
    }
    if (!Number.isInteger(rule.maxTagBytes) || rule.maxTagBytes! < 0 || rule.maxTagBytes! > MAX_CUSTOM_NOSTR_TAG_BYTES) {
      throw new Error(`Custom Nostr maxTagBytes must be between 0 and ${MAX_CUSTOM_NOSTR_TAG_BYTES}`);
    }
    if (!Array.isArray(rule.allowedTagNames) || rule.allowedTagNames.length > MAX_CUSTOM_NOSTR_TAG_NAMES) {
      throw new Error(`Custom Nostr allowedTagNames must contain at most ${MAX_CUSTOM_NOSTR_TAG_NAMES} names`);
    }
    const allowedTagNames = rule.allowedTagNames.map((name) => {
      if (typeof name !== "string" || !name || Buffer.byteLength(name) > MAX_CUSTOM_NOSTR_TAG_NAME_BYTES) {
        throw new Error("Custom Nostr tag names must be non-empty strings of at most 64 bytes");
      }
      return name;
    });
    if (new Set(allowedTagNames).size !== allowedTagNames.length) {
      throw new Error("Custom Nostr allowedTagNames cannot contain duplicates");
    }
    const requiredTagInput = rule.requiredTags ?? [];
    if (!Array.isArray(requiredTagInput)) throw new Error("Custom Nostr requiredTags must be an array when provided");
    const requiredTags = requiredTagInput.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((item) => typeof item !== "string")) {
        throw new Error("Custom Nostr requiredTags must contain exact [name, value] pairs");
      }
      const [name, tagValue] = pair as [string, string];
      if (!allowedTagNames.includes(name)) throw new Error("Custom Nostr required tag names must also be allowed");
      if (Buffer.byteLength(name) + Buffer.byteLength(tagValue) > rule.maxTagBytes!) {
        throw new Error("Custom Nostr required tag pair exceeds maxTagBytes");
      }
      return [name, tagValue] as [string, string];
    });
    if (requiredTags.length > rule.maxTags!) throw new Error("Custom Nostr requiredTags exceed maxTags");
    const pairKeys = requiredTags.map((pair) => JSON.stringify(pair));
    if (new Set(pairKeys).size !== pairKeys.length) throw new Error("Custom Nostr requiredTags cannot contain duplicates");
    return {
      kind: rule.kind!,
      maxContentBytes: rule.maxContentBytes!,
      maxTags: rule.maxTags!,
      maxTagBytes: rule.maxTagBytes!,
      allowedTagNames,
      requiredTags,
    };
  });
  const ruleKinds = rules.map((rule) => rule.kind);
  if (new Set(ruleKinds).size !== ruleKinds.length) throw new Error("Custom Nostr kinds cannot have duplicate per-kind rules");
  if (ruleKinds.length !== customKinds.length || customKinds.some((kind) => !ruleKinds.includes(kind))) {
    throw new Error("Every declared custom Nostr kind requires exactly one matching per-kind rule");
  }
  return rules.sort((left, right) => left.kind - right.kind);
}
