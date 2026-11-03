import { nip19 } from "nostr-tools";

/**
 * Structured Flight Deck mentions for agent writes.
 *
 * Tower routes only from structured `mentions` (visible `@[Label](mention:agent:npub)` text is not routing authority).
 * Callers pass explicit `{ type, npub, label }` values; the visible canonical tag is derived from the same value and
 * prepended when absent, so the body and the structured list never disagree.
 */
export type FlightDeckActorMention = { type: "agent" | "person"; npub: string; label: string };

const LABEL_MAX = 120;
const BODY_TAG = /@\[([^\]]+)\]\(mention:(agent|person):(npub1[0-9a-z]+)\)/g;

export function canonicalMentionTag(mention: FlightDeckActorMention): string {
  return `@[${mention.label}](mention:${mention.type}:${mention.npub})`;
}

function isNpub(value: string): boolean {
  try {
    return nip19.decode(value).type === "npub";
  } catch {
    return false;
  }
}

export function parseFlightDeckMentions(value: unknown): { mentions: FlightDeckActorMention[] } | { error: string } {
  if (value === undefined || value === null) return { mentions: [] };
  if (!Array.isArray(value)) return { error: "mentions must be an array of { type, npub, label }" };
  const mentions: FlightDeckActorMention[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const entry = item as Record<string, unknown> | null;
    const type = entry?.type;
    const npub = typeof entry?.npub === "string" ? entry.npub.trim() : "";
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    if (type !== "agent" && type !== "person") return { error: `mentions.${index}.type must be agent or person` };
    if (!isNpub(npub)) return { error: `mentions.${index}.npub must be a full valid npub` };
    if (!label || label.length > LABEL_MAX || /[[\]()]/.test(label)) return { error: `mentions.${index}.label must be 1-${LABEL_MAX} characters without brackets` };
    if (seen.has(npub)) continue;
    seen.add(npub);
    mentions.push({ type, npub, label });
  }
  return { mentions };
}

/** Canonical body tags whose npub has no structured entry: they will display but never route. */
export function unroutedMentionTags(body: string, mentions: FlightDeckActorMention[]): string[] {
  const structured = new Set(mentions.map((mention) => mention.npub));
  return [...body.matchAll(BODY_TAG)].filter((match) => !structured.has(match[3]!)).map((match) => match[3]!);
}

/**
 * Body + metadata for a write. Missing visible tags are prepended; tags without a structured entry are reported as a
 * warning (never silently promoted to routing authority).
 */
export function applyFlightDeckMentions(body: string, value: unknown):
  | { body: string; metadata: { mentions: FlightDeckActorMention[] } | null; warnings: string[] }
  | { error: string } {
  const parsed = parseFlightDeckMentions(value);
  if ("error" in parsed) return parsed;
  const missing = parsed.mentions.filter((mention) => ![...body.matchAll(BODY_TAG)].some((match) => match[3] === mention.npub && match[2] === mention.type));
  const nextBody = missing.length ? `${missing.map(canonicalMentionTag).join(" ")} ${body}` : body;
  const unrouted = unroutedMentionTags(nextBody, parsed.mentions);
  return {
    body: nextBody,
    metadata: parsed.mentions.length ? { mentions: parsed.mentions } : null,
    warnings: unrouted.length ? [`mention_tags_without_structured_mentions: ${unrouted.join(", ")}`] : [],
  };
}
