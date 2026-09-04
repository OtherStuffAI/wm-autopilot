import {
  DEFAULT_AGENT_NOSTR_EVENT_KINDS,
  type BrokerOperation,
  type Nip98ExtraTagRule,
} from "./capability-broker";
import { normalizeNostrKindRules } from "./nostr-kind-policy";
export {
  MAX_CUSTOM_NOSTR_CONTENT_BYTES,
  MAX_CUSTOM_NOSTR_TAGS,
  MAX_CUSTOM_NOSTR_TAG_BYTES,
} from "./nostr-kind-policy";
import type {
  SigningPolicyAssignment,
  SigningPolicyDraft,
  SigningPolicyNip98Target,
} from "./signing-policy-registry";

const BROKER_OPERATIONS = new Set<BrokerOperation>([
  "identity.read", "capability.refresh", "nip98.sign", "nostr.sign", "nip44.encrypt",
  "nip44.decrypt", "blossom.authorize", "wallet.read", "wallet.spend",
]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CHALLENGE_TAGS = ["nonce", "aud", "expiration"] as const;

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("NIP-98 origin must be a valid absolute URL");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.username || parsed.password || value.includes("*")) {
    throw new Error("Custom NIP-98 origins must be exact HTTPS origins without wildcards, credentials, paths, queries, or fragments");
  }
  return parsed.origin;
}

function normalizePath(value: string, field: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("*")) {
    throw new Error(`${field} must be an exact absolute path without wildcards, query, or fragment`);
  }
  const normalized = value.length > 1 ? value.replace(/\/+$/, "") : value;
  if (["/", "/api", "/api/v4"].includes(normalized)) throw new Error(`${field} is overbroad`);
  return normalized;
}

function validateAssignments(value: SigningPolicyAssignment): SigningPolicyAssignment {
  if (!value || !Array.isArray(value.profileIds) || !Array.isArray(value.workspaceIds)) {
    throw new Error("assignments.profileIds and assignments.workspaceIds are required arrays");
  }
  const normalize = (items: string[], label: string) => sortedUnique(items.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 200) throw new Error(`${label} contains an invalid ID`);
    return item.trim();
  }));
  return { profileIds: normalize(value.profileIds, "profileIds"), workspaceIds: normalize(value.workspaceIds, "workspaceIds") };
}

function validateChallenge(target: SigningPolicyNip98Target): SigningPolicyNip98Target["challenge"] {
  if (!target.challenge) return undefined;
  const names = target.challenge.allowedTags.map((rule) => rule.name);
  if (new Set(names).size !== names.length || sortedUnique(names).join(",") !== [...CHALLENGE_TAGS].sort().join(",")) {
    throw new Error("Challenge policies may allow only nonce, aud, and expiration exactly once");
  }
  if (sortedUnique(target.challenge.requiredTags).join(",") !== [...CHALLENGE_TAGS].sort().join(",")) {
    throw new Error("Challenge policies must require nonce, aud, and expiration");
  }
  const rules = target.challenge.allowedTags.map((rule) => {
    if (!CHALLENGE_TAGS.includes(rule.name)) throw new Error("Unknown challenge tag rule");
    const expectedType = rule.name === "expiration" ? "unix-timestamp" : "non-empty";
    if (rule.valueType !== expectedType) throw new Error(`Invalid ${rule.name} value rule`);
    if (!Number.isInteger(rule.maxLength) || rule.maxLength < 1 || rule.maxLength > 512) {
      throw new Error(`Invalid ${rule.name} maximum length`);
    }
    if (rule.name === "expiration") {
      if (!Number.isInteger(rule.maxFutureSeconds) || rule.maxFutureSeconds! < 1 || rule.maxFutureSeconds! > 60) {
        throw new Error("Challenge expiration window must be between 1 and 60 seconds");
      }
    } else if (rule.maxFutureSeconds !== undefined) {
      throw new Error(`Only expiration may define maxFutureSeconds`);
    }
    return { ...rule };
  });
  return { allowedTags: rules, requiredTags: [...target.challenge.requiredTags], omitSessionBinding: true };
}

export function validateSigningPolicyDraft(input: SigningPolicyDraft): SigningPolicyDraft {
  if (!input || typeof input !== "object") throw new Error("Signing policy is required");
  const id = String(input.id ?? "").trim();
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new Error("Policy ID must be 3-64 lowercase letters, numbers, or hyphens");
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  if (!name || name.length > 100) throw new Error("Policy name is required and must be at most 100 characters");
  if (!description || description.length > 1_000) throw new Error("Policy description is required and must be at most 1000 characters");
  if (typeof input.enabled !== "boolean") throw new Error("Policy enabled state must be a boolean");
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new Error("At least one broker operation is required");
  const operations = sortedUnique(input.operations.map((operation) => {
    if (!BROKER_OPERATIONS.has(operation)) throw new Error(`Unknown broker operation: ${String(operation)}`);
    return operation;
  })) as BrokerOperation[];
  if (operations.some((operation) => !["nip98.sign", "nostr.sign"].includes(operation))) {
    throw new Error("Custom policies may add only constrained NIP-98 or Nostr signing authority");
  }
  if (!Array.isArray(input.eventKinds) || input.eventKinds.length === 0 || input.eventKinds.some((kind) => !Number.isInteger(kind) || kind < 0 || kind > 65_535)) {
    throw new Error("eventKinds must contain valid non-negative integer kinds");
  }
  const eventKinds = [...new Set(input.eventKinds)].sort((left, right) => left - right);
  if (operations.includes("nostr.sign") && eventKinds.includes(27_235)) {
    throw new Error("Generic Nostr policies cannot add kind 27235");
  }
  if (operations.includes("nip98.sign") && !eventKinds.includes(27_235)) {
    throw new Error("NIP-98 policies must declare event kind 27235");
  }
  if (operations.includes("nip98.sign") && !operations.includes("nostr.sign")
    && (eventKinds.length !== 1 || eventKinds[0] !== 27_235)) {
    throw new Error("Dedicated NIP-98 policies may declare only event kind 27235");
  }
  const customKinds = operations.includes("nostr.sign")
    ? eventKinds.filter((kind) => !DEFAULT_AGENT_NOSTR_EVENT_KINDS.includes(kind))
    : [];
  const nostrKindRules = normalizeNostrKindRules(input.nostrKindRules, customKinds);
  if (!Array.isArray(input.nip98Targets)) throw new Error("nip98Targets must be an array");
  if (operations.includes("nip98.sign") !== (input.nip98Targets.length > 0)) {
    throw new Error("NIP-98 policies require targets and non-NIP-98 policies cannot define them");
  }
  const nip98Targets = input.nip98Targets.map((target) => {
    if (!target || typeof target !== "object") throw new Error("Invalid NIP-98 target");
    const origin = normalizeOrigin(target.origin);
    if (!Array.isArray(target.methods) || target.methods.length === 0) throw new Error("NIP-98 target methods are required");
    const methods = sortedUnique(target.methods.map((method) => {
      const normalized = String(method).trim().toUpperCase();
      if (!HTTP_METHODS.has(normalized)) throw new Error(`Unsafe or unknown HTTP method: ${normalized}`);
      return normalized;
    }));
    if (!Array.isArray(target.exactPaths) || !Array.isArray(target.pathPrefixes)) throw new Error("NIP-98 target paths must be arrays");
    const exactPaths = sortedUnique(target.exactPaths.map((path) => normalizePath(path, "exactPaths")));
    const pathPrefixes = sortedUnique(target.pathPrefixes.map((path) => normalizePath(path, "pathPrefixes")));
    if (exactPaths.length + pathPrefixes.length === 0) throw new Error("NIP-98 target requires an exact path or path prefix");
    if (typeof target.requireBodyHash !== "boolean") throw new Error("NIP-98 target requireBodyHash must be a boolean");
    if (methods.some((method) => MUTATING_METHODS.has(method)) && !target.requireBodyHash) {
      throw new Error("Mutating custom NIP-98 targets must require a payload hash");
    }
    const challenge = validateChallenge(target);
    if (challenge) {
      if (methods.length !== 1 || methods[0] !== "POST" || exactPaths.length !== 1 || pathPrefixes.length !== 0
        || !exactPaths[0]?.endsWith("/authorize/complete") || !target.requireBodyHash) {
        throw new Error("Forgejo challenge targets require one exact /authorize/complete path, POST, and a payload hash");
      }
    }
    return { origin, methods, exactPaths, pathPrefixes, requireBodyHash: target.requireBodyHash, ...(challenge ? { challenge } : {}) };
  });
  const targetKeys = nip98Targets.flatMap((target) => [
    ...target.exactPaths.map((path) => `${target.origin}|exact|${path}`),
    ...target.pathPrefixes.map((path) => `${target.origin}|prefix|${path}`),
  ]);
  if (new Set(targetKeys).size !== targetKeys.length) throw new Error("Signing policy contains duplicate NIP-98 targets");
  return { id, name, description, enabled: input.enabled, operations, eventKinds, nostrKindRules, nip98Targets, assignments: validateAssignments(input.assignments) };
}
