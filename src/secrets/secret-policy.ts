import { nip19 } from "nostr-tools";
import { normalizeNostrKindRules, type NostrKindConstraint } from "../signing/nostr-kind-policy";

export interface ContextSelection { enabled: boolean; mode: "all" | "selected"; ids: string[] }
export interface SecretPolicy {
  identities: string[];
  pipelines: ContextSelection;
  agents: ContextSelection;
  allowExport: boolean;
  kindRules: NostrKindConstraint[];
}
export interface SecretConsumer {
  ownerNpub: string; workspaceId: string; identityNpub: string;
  context: "pipeline" | "session"; contextId: string;
}
export class SecretError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function validatedNpub(value: unknown): string {
  if (typeof value !== "string") throw new SecretError("invalid_npub");
  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub" || nip19.npubEncode(decoded.data) !== value) throw new Error();
    return value;
  } catch { throw new SecretError("invalid_npub"); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecretError("invalid_object");
  return value as Record<string, unknown>;
}
function selection(value: unknown, agents: boolean): ContextSelection {
  const input = object(value);
  if (typeof input.enabled !== "boolean" || !["all", "selected"].includes(String(input.mode))
    || !Array.isArray(input.ids) || input.ids.length > 128) throw new SecretError("invalid_context_policy");
  const ids = input.ids.map(id => agents ? validatedNpub(id) : boundedText(id, 512));
  if (new Set(ids).size !== ids.length || (input.mode === "all" && ids.length)) throw new SecretError("invalid_context_policy");
  return { enabled: input.enabled, mode: input.mode as ContextSelection["mode"], ids };
}
export function boundedText(value: unknown, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new SecretError("invalid_text");
  return value.trim();
}
export function normalizeSecretPolicy(value: unknown): SecretPolicy {
  const input = object(value);
  if (!Array.isArray(input.identities) || input.identities.length > 128 || typeof input.allowExport !== "boolean"
    || !Array.isArray(input.kindRules) || input.kindRules.length > 16) throw new SecretError("invalid_policy");
  const identities = input.identities.map(validatedNpub);
  if (new Set(identities).size !== identities.length) throw new SecretError("invalid_policy");
  const kinds = input.kindRules.map(rule => object(rule).kind);
  // Imported credentials never mint authentication, payment or broker authority.
  const permittedKinds = [0, 1, 3, 5, 6, 7, 10002, 30023];
  if (kinds.some(kind => !permittedKinds.includes(kind as number))) throw new SecretError("invalid_signing_kind");
  let kindRules: NostrKindConstraint[];
  try { kindRules = normalizeNostrKindRules(input.kindRules, kinds as number[]); }
  catch { throw new SecretError("invalid_kind_rules"); }
  return { identities, pipelines: selection(input.pipelines, false), agents: selection(input.agents, true),
    allowExport: input.allowExport, kindRules };
}
export function deniedPolicy(): SecretPolicy {
  return { identities: [], pipelines: { enabled: false, mode: "selected", ids: [] },
    agents: { enabled: false, mode: "selected", ids: [] }, allowExport: false, kindRules: [] };
}
export function assertSecretUse(record: { ownerNpub: string; workspaceId: string; revokedAt: string | null; policy: SecretPolicy }, consumer: SecretConsumer): void {
  if (consumer.context !== "pipeline" && consumer.context !== "session") throw new SecretError("invalid_consumer_context", 403);
  const policy = normalizeSecretPolicy(record.policy);
  const context = consumer.context === "pipeline" ? policy.pipelines : policy.agents;
  if (record.revokedAt || consumer.ownerNpub !== record.ownerNpub || consumer.workspaceId !== record.workspaceId
    || !policy.identities.includes(consumer.identityNpub) || !context.enabled
    || !consumer.contextId || (context.mode === "selected" && !context.ids.includes(consumer.contextId))
    || (consumer.context === "session" && consumer.contextId !== consumer.identityNpub)) throw new SecretError("secret_use_denied", 403);
}
