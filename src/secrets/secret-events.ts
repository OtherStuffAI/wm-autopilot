import { type EventTemplate, finalizeEvent } from "nostr-tools";
import { matchesExactNostrTags, type NostrKindConstraint } from "../signing/nostr-kind-policy";
import { object, SecretError } from "./secret-policy";

export function signSecretEvent(key: Uint8Array, value: unknown, rules: NostrKindConstraint[]) {
  const event = object(value);
  const rule = rules.find(rule => rule.kind === event.kind);
  const now = Math.floor(Date.now() / 1000);
  const timestamp = event.created_at ?? now;
  if (!rule || !Number.isInteger(timestamp) || Math.abs(Number(timestamp) - now) > 300
    || typeof event.content !== "string" || Buffer.byteLength(event.content) > rule.maxContentBytes
    || !Array.isArray(event.tags) || event.tags.length > rule.maxTags
    || event.tags.some(tag => !Array.isArray(tag) || tag.length < 1 || tag.some(item => typeof item !== "string")
      || !rule.allowedTagNames.includes(tag[0]))) throw new SecretError("event_policy_denied", 403);
  const tags = event.tags as string[][];
  if (tags.reduce((total, tag) => total + tag.reduce((sum, item) => sum + Buffer.byteLength(item), 0), 0) > rule.maxTagBytes
    || !matchesExactNostrTags(tags, rule.exactTags)
    || (rule.requiredTags ?? []).some(([name, value]) => !tags.some(tag => tag[0] === name && tag[1] === value))) throw new SecretError("event_policy_denied", 403);
  return finalizeEvent({ kind: rule.kind, created_at: Number(timestamp), content: event.content, tags } as EventTemplate, key);
}
