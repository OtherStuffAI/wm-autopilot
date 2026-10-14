import { createHash } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools";
import type { ActivityWebhookEvent } from "./activity-webhook-contract.ts";

/** Reference validation for receivers. App authorization and durable dedup remain receiver responsibilities. */
export function verifyActivityWebhookRequest(input: {
  url: string; method: string; body: string | Uint8Array; headers: Headers; signerPubkey: string; now?: number;
}): ActivityWebhookEvent {
  const bytes = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
  if (input.method !== "POST" || bytes.byteLength > 65_536) throw new Error("Invalid activity request");
  const auth = input.headers.get("authorization");
  if (!auth?.startsWith("Nostr ") || auth.length > 8192) throw new Error("Missing activity authentication");
  const signed = JSON.parse(Buffer.from(auth.slice(6), "base64").toString("utf8")) as Event;
  if (!verifyEvent(signed) || signed.kind !== 27235 || signed.content !== "" || signed.pubkey !== input.signerPubkey) throw new Error("Invalid activity signer");
  const expected: Record<string, string> = { u: input.url, method: "POST", payload: createHash("sha256").update(bytes).digest("hex") };
  function tag(name: string): string {
    const entries = signed.tags.filter(entry => entry[0] === name);
    if (entries.length !== 1 || entries[0]!.length !== 2) throw new Error(`Invalid activity authentication tag: ${name}`);
    return entries[0]![1]!;
  }
  for (const [key, value] of Object.entries(expected)) if (tag(key) !== value) throw new Error("Activity request authentication mismatch");
  if (!Number.isInteger(signed.created_at) || Math.abs(Math.floor((input.now ?? Date.now()) / 1000) - signed.created_at) > 90) throw new Error("Expired activity authentication");
  const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ActivityWebhookEvent;
  if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).sort().join(",") !== "content,correlation,eventId,runId,sequence,sessionId,stepId,timestamp,turnId,type,version") throw new Error("Invalid activity envelope");
  if (event.version !== 1 || !/^[a-f0-9]{64}$/.test(event.eventId) || !Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > 257 ||
    !["commentary", "tools", "completed", "failed"].includes(event.type) || typeof event.content !== "string" || !event.content.trim() || event.content.length > 4000 ||
    typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp))) throw new Error("Invalid activity event");
  for (const value of [event.runId, event.stepId, event.turnId, ...(event.sessionId === null ? [] : [event.sessionId])]) {
    if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Invalid activity binding");
  }
  if (!event.correlation || typeof event.correlation !== "object" || Array.isArray(event.correlation) || Object.keys(event.correlation).length > 16 ||
    Object.entries(event.correlation).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || typeof value !== "string" || !value.trim() || value.length > 200)) throw new Error("Invalid activity correlation");
  if ((event.type === "tools" && event.content !== "Using tools") || (event.type === "completed" && event.content !== "Completed") || (event.type === "failed" && event.content !== "Failed")) throw new Error("Invalid activity indicator");
  if (tag("event") !== event.eventId || tag("run") !== event.runId || input.headers.get("x-wingman-event-id") !== event.eventId || input.headers.get("x-wingman-run-id") !== event.runId) throw new Error("Activity header/body mismatch");
  return event;
}
