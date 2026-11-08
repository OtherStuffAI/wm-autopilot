import { canonicalMentionTag, parseFlightDeckMentions, type FlightDeckActorMention } from "../mcp/flightdeck-mentions.ts";

export type ActorMention = FlightDeckActorMention;

export function parseCliMentions(raw: string | null): ActorMention[] {
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("--mentions-json must be a JSON array of actor mentions."); }
  if (!Array.isArray(value)) throw new Error("--mentions-json must be a JSON array of actor mentions.");
  const parsed = parseFlightDeckMentions(value);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.mentions;
}

export function withCliMentions(body: string, mentions: ActorMention[] = []) {
  for (const mention of mentions) {
    const tag = canonicalMentionTag(mention);
    if (!body.includes(tag)) body = `${body}\n\n${tag}`;
  }
  const routed = new Set(mentions.map(mention => `${mention.type}:${mention.npub}`));
  for (const match of body.matchAll(/@\[[^\]]+\]\(mention:(agent|person):([^\)]+)\)/g)) {
    if (!routed.has(`${match[1]}:${match[2]}`)) throw new Error("Visible actor mention requires a matching --mentions-json entry.");
  }
  return { body, mentions };
}
