import {
  type BrokerOperation,
  type Nip98ExtraTagRule,
  type PolicyRevisionRef,
  type SessionCapabilityPolicy,
} from "./capability-broker";
import type { NostrKindConstraint } from "./nostr-kind-policy";
import type { SigningPolicyStore } from "./signing-policy-store";
import { CHALLENGE_TAGS, validateSigningPolicyDraft } from "./signing-policy-validation";
export { FileSigningPolicyStore } from "./signing-policy-store";
export { validateSigningPolicyDraft } from "./signing-policy-validation";

export const DEFAULT_AGENT_POLICY_ID = "builtin-default-agent";
export const TOWER_FORGEJO_POLICY_ID = "tower-forgejo-login";
export const DEFAULT_AGENT_POLICY_REVISION = 1;

export interface SigningPolicyAssignment {
  profileIds: string[];
  workspaceIds: string[];
}

export interface SigningPolicyNip98Target {
  origin: string;
  methods: string[];
  exactPaths: string[];
  pathPrefixes: string[];
  requireBodyHash: boolean;
  challenge?: {
    allowedTags: Nip98ExtraTagRule[];
    requiredTags: Array<Nip98ExtraTagRule["name"]>;
    omitSessionBinding: true;
  };
}

export interface SigningPolicyDocument {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  revision: number;
  builtIn: "template" | false;
  operations: BrokerOperation[];
  eventKinds: number[];
  nostrKindRules: NostrKindConstraint[];
  nip98Targets: SigningPolicyNip98Target[];
  assignments: SigningPolicyAssignment;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export type SigningPolicyDraft = Pick<
  SigningPolicyDocument,
  "id" | "name" | "description" | "enabled" | "operations" | "eventKinds" | "nostrKindRules" | "nip98Targets" | "assignments"
>;

export interface SigningPolicyHistoryEntry {
  policyId: string;
  revision: number;
  action: "created" | "updated" | "enabled" | "disabled";
  actorNpub: string;
  at: string;
  snapshot: SigningPolicyDocument;
}

export interface ResolvedSigningPolicy {
  policy: SessionCapabilityPolicy;
  policyRefs: PolicyRevisionRef[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function applies(policy: SigningPolicyDocument, scope: { profileId?: string | null; workspaceId?: string | null }): boolean {
  if (!policy.enabled) return false;
  const hasProfiles = policy.assignments.profileIds.length > 0;
  const hasWorkspaces = policy.assignments.workspaceIds.length > 0;
  if (!hasProfiles && !hasWorkspaces) return false;
  return (!hasProfiles || Boolean(scope.profileId && policy.assignments.profileIds.includes(scope.profileId)))
    && (!hasWorkspaces || Boolean(scope.workspaceId && policy.assignments.workspaceIds.includes(scope.workspaceId)));
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function targetsOverlap(left: SigningPolicyNip98Target, right: SigningPolicyNip98Target): boolean {
  if (left.origin !== right.origin) return false;
  if (left.exactPaths.some((path) => right.exactPaths.includes(path))) return true;
  if (left.exactPaths.some((path) => right.pathPrefixes.some((prefix) => pathWithinPrefix(path, prefix)))) return true;
  if (right.exactPaths.some((path) => left.pathPrefixes.some((prefix) => pathWithinPrefix(path, prefix)))) return true;
  return left.pathPrefixes.some((leftPrefix) => right.pathPrefixes.some((rightPrefix) =>
    pathWithinPrefix(leftPrefix, rightPrefix) || pathWithinPrefix(rightPrefix, leftPrefix)));
}

function assertTowerForgejoContract(draft: SigningPolicyDraft): void {
  if (draft.id !== TOWER_FORGEJO_POLICY_ID) return;
  if (draft.operations.length !== 1 || draft.operations[0] !== "nip98.sign"
    || draft.eventKinds.length !== 1 || draft.eventKinds[0] !== 27_235
    || draft.nostrKindRules.length !== 0
    || draft.nip98Targets.length !== 1 || !draft.nip98Targets[0]?.challenge) {
    throw new Error("The Tower Forgejo Login template must retain its dedicated kind-27235 NIP-98 challenge contract");
  }
}

export class SigningPolicyRegistry {
  private readonly policies = new Map<string, SigningPolicyDocument>();
  private readonly history: SigningPolicyHistoryEntry[];
  private readonly now: () => number;

  constructor(private readonly store: SigningPolicyStore, options: { forgejoCompletionUrl: string; now?: () => number }) {
    this.now = options.now ?? Date.now;
    const loaded = store.load();
    this.history = clone(loaded.history);
    for (const policy of loaded.policies) {
      const validated = validateSigningPolicyDraft(policy);
      assertTowerForgejoContract(validated);
      if (this.policies.has(validated.id)) throw new Error(`Duplicate signing policy ID: ${validated.id}`);
      this.policies.set(validated.id, { ...clone(policy), ...validated });
    }
    if (!this.policies.has(TOWER_FORGEJO_POLICY_ID)) {
      const completionUrl = new URL(options.forgejoCompletionUrl);
      const timestamp = new Date(this.now()).toISOString();
      const draft = validateSigningPolicyDraft({
        id: TOWER_FORGEJO_POLICY_ID,
        name: "Tower Forgejo Login",
        description: "Signs Tower's one-minute Forgejo OIDC completion challenge for explicitly assigned agent sessions.",
        enabled: false,
        operations: ["nip98.sign"],
        eventKinds: [27_235],
        nostrKindRules: [],
        nip98Targets: [{
          origin: completionUrl.origin,
          methods: ["POST"],
          exactPaths: [completionUrl.pathname],
          pathPrefixes: [],
          requireBodyHash: true,
          challenge: {
            allowedTags: [
              { name: "nonce", valueType: "non-empty", maxLength: 256 },
              { name: "aud", valueType: "non-empty", maxLength: 256 },
              { name: "expiration", valueType: "unix-timestamp", maxLength: 12, maxFutureSeconds: 60 },
            ],
            requiredTags: [...CHALLENGE_TAGS],
            omitSessionBinding: true,
          },
        }],
        assignments: { profileIds: [], workspaceIds: [] },
      });
      const policy: SigningPolicyDocument = {
        ...draft, revision: 1, builtIn: "template", createdAt: timestamp, createdBy: "system",
        updatedAt: timestamp, updatedBy: "system",
      };
      this.policies.set(policy.id, policy);
      this.history.push({ policyId: policy.id, revision: 1, action: "created", actorNpub: "system", at: timestamp, snapshot: clone(policy) });
      this.persist();
    }
  }

  list(): SigningPolicyDocument[] {
    return [...this.policies.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id));
  }

  get(id: string): SigningPolicyDocument | null {
    const policy = this.policies.get(id);
    return policy ? clone(policy) : null;
  }

  getHistory(id: string): SigningPolicyHistoryEntry[] {
    return this.history.filter((entry) => entry.policyId === id).map(clone).sort((left, right) => right.revision - left.revision);
  }

  create(draft: SigningPolicyDraft, actorNpub: string): SigningPolicyDocument {
    const validated = validateSigningPolicyDraft(draft);
    if (validated.id === DEFAULT_AGENT_POLICY_ID || this.policies.has(validated.id)) throw new Error(`Signing policy ID already exists: ${validated.id}`);
    return this.saveRevision(validated, null, actorNpub, "created", false);
  }

  update(id: string, draft: SigningPolicyDraft, actorNpub: string): SigningPolicyDocument {
    const existing = this.policies.get(id);
    if (!existing) throw new Error("Signing policy not found");
    if (draft.id !== id) throw new Error("Signing policy ID is immutable");
    const validated = validateSigningPolicyDraft(draft);
    assertTowerForgejoContract(validated);
    return this.saveRevision(validated, existing, actorNpub, "updated", existing.builtIn);
  }

  setEnabled(id: string, enabled: boolean, actorNpub: string): SigningPolicyDocument {
    const existing = this.policies.get(id);
    if (!existing) throw new Error("Signing policy not found");
    if (existing.enabled === enabled) return clone(existing);
    return this.saveRevision({ ...existing, enabled }, existing, actorNpub, enabled ? "enabled" : "disabled", existing.builtIn);
  }

  resolve(scope: { profileId?: string | null; workspaceId?: string | null }, baseline: SessionCapabilityPolicy): ResolvedSigningPolicy {
    const selected = this.list().filter((policy) => applies(policy, scope));
    const policy = clone(baseline);
    const addedTargets: Array<{ policyId: string; target: SigningPolicyNip98Target }> = [];
    for (const fragment of selected) {
      policy.operations = sortedUnique([...policy.operations, ...fragment.operations]) as BrokerOperation[];
      if (fragment.operations.includes("nostr.sign")) {
        if (!policy.nostr) throw new Error(`Policy ${fragment.id} requires a baseline Nostr constraint`);
        const duplicateRule = fragment.nostrKindRules.find((rule) =>
          policy.nostr!.kindRules?.some((existing) => existing.kind === rule.kind));
        if (duplicateRule) throw new Error(`Policy ${fragment.id} duplicates the constraint for custom Nostr kind ${duplicateRule.kind}`);
        policy.nostr.kinds = [...new Set([...policy.nostr.kinds, ...fragment.eventKinds])].sort((left, right) => left - right);
        policy.nostr.kindRules = [
          ...(policy.nostr.kindRules ?? []),
          ...clone(fragment.nostrKindRules),
        ];
      }
      if (fragment.operations.includes("nip98.sign")) {
        if (!policy.nip98) throw new Error(`Policy ${fragment.id} requires a baseline NIP-98 constraint`);
        policy.nip98.targets ??= [];
        for (const target of fragment.nip98Targets) {
          const overlapping = addedTargets.find((candidate) => targetsOverlap(candidate.target, target));
          if (overlapping) {
            throw new Error(`Policy ${fragment.id} conflicts with ${overlapping.policyId} on an overlapping NIP-98 target`);
          }
          const translated = {
            origin: target.origin,
            methods: [...target.methods],
            pathPrefixes: [...target.pathPrefixes],
            exactPaths: target.exactPaths.map((path) => ({
              path,
              methods: [...target.methods],
              requireBodyHash: target.requireBodyHash,
              ...(target.challenge ? { extraTags: {
                allowed: clone(target.challenge.allowedTags),
                required: [...target.challenge.requiredTags],
                omitSessionBinding: true,
              } } : {}),
            })),
            requireBodyHashMethods: target.requireBodyHash ? [...target.methods] : [],
          };
          const collision = policy.nip98.targets.some((candidate) => candidate.origin === translated.origin
            && (candidate.exactPaths ?? []).some((path) => translated.exactPaths.some((added) => added.path === path.path)));
          if (collision) throw new Error(`Policy ${fragment.id} conflicts with an existing exact NIP-98 target`);
          policy.nip98.targets.push(translated);
          addedTargets.push({ policyId: fragment.id, target });
        }
      }
    }
    return {
      policy,
      policyRefs: [
        { id: DEFAULT_AGENT_POLICY_ID, revision: DEFAULT_AGENT_POLICY_REVISION },
        ...selected.map((fragment) => ({ id: fragment.id, revision: fragment.revision })),
      ],
    };
  }

  resolveReferences(scope: { profileId?: string | null; workspaceId?: string | null }): PolicyRevisionRef[] {
    return [
      { id: DEFAULT_AGENT_POLICY_ID, revision: DEFAULT_AGENT_POLICY_REVISION },
      ...this.list().filter((policy) => applies(policy, scope)).map((policy) => ({ id: policy.id, revision: policy.revision })),
    ];
  }

  private saveRevision(
    draft: SigningPolicyDraft,
    existing: SigningPolicyDocument | null,
    actorNpub: string,
    action: SigningPolicyHistoryEntry["action"],
    builtIn: SigningPolicyDocument["builtIn"],
  ): SigningPolicyDocument {
    const at = new Date(this.now()).toISOString();
    const policy: SigningPolicyDocument = {
      ...clone(draft), revision: (existing?.revision ?? 0) + 1, builtIn,
      createdAt: existing?.createdAt ?? at, createdBy: existing?.createdBy ?? actorNpub,
      updatedAt: at, updatedBy: actorNpub,
    };
    this.policies.set(policy.id, policy);
    this.history.push({ policyId: policy.id, revision: policy.revision, action, actorNpub, at, snapshot: clone(policy) });
    this.persist();
    return clone(policy);
  }

  private persist(): void {
    this.store.save({ version: 1, policies: this.list(), history: clone(this.history) });
  }
}

export function buildDefaultPolicyInventory(policy: SessionCapabilityPolicy): Record<string, unknown> {
  return {
    id: DEFAULT_AGENT_POLICY_ID,
    name: "Default Agent Capability",
    description: "Built-in baseline applied to every session capability.",
    enabled: true,
    revision: DEFAULT_AGENT_POLICY_REVISION,
    builtIn: "baseline",
    editable: false,
    operations: [...policy.operations],
    eventKinds: [...(policy.nostr?.kinds ?? [])],
    nostrKindRules: [],
    nip98Targets: clone(policy.nip98?.targets ?? []),
    assignments: { allSessions: true },
  };
}
