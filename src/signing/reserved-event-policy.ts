import { createHash } from "node:crypto";

/** Reserved protocols retain their validators even when event kinds are broad. */
export function reservedEventError(kind: number, content: string, tags: string[][]): string | null {
  if (kind === 445) return "Key custody transfer requires its dedicated protocol";
  if (kind === 24_242) return "Blossom authorization requires the dedicated broker operation";
  if (kind !== 33_358) return null;
  function value(name: string): string | null {
    const matches = tags.filter(tag => tag[0] === name);
    return matches.length === 1 && matches[0]?.length === 2 ? matches[0][1]! : null;
  }
  if (value("protocol") !== "flightdeck_pg_message_instruction"
    || value("body_sha256") !== createHash("sha256").update(content).digest("hex")
    || !value("workspace_id")?.trim() || !value("channel_id")?.trim()
    || tags.filter(tag => tag[0] === "thread_id").length > 1) {
    return "Flight Deck instruction requires exact content hash and protocol routing tags";
  }
  return null;
}
