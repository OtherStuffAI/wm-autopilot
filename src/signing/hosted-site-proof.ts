import { createHash } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools";
import { SignerError } from "./application-signer";

export const HOSTED_WORKSPACE_PATH = "/api/v4/flightdeck-pg/hosted/workspaces";
export function hostedSignupTarget(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== HOSTED_WORKSPACE_PATH || url.href !== value) throw new SignerError("target_denied");
  return value;
}
export function exactProofTag(event: Event, name: string): string | null {
  const tags = event.tags.filter(tag => tag[0] === name);
  return tags.length === 1 && tags[0]?.length === 2 ? tags[0][1]! : null;
}
export function verifyHostedUserProof(input: { url: string; method: string; payload: string; bodyHash: string; userEventId: string; userEvent: Event }, now: number): Event {
  if (input.method !== "POST") throw new SignerError("method_denied");
  if (typeof input.payload !== "string" || Buffer.byteLength(input.payload) > 2048) throw new SignerError("payload_denied");
  const hash = createHash("sha256").update(input.payload).digest("hex");
  if (input.bodyHash !== hash) throw new SignerError("payload_hash_mismatch");
  let body;
  try { body = JSON.parse(input.payload); } catch { throw new SignerError("payload_denied"); }
  if (!body || Object.keys(body).sort().join(",") !== "idempotency_key,terms_version,workspace_name"
    || typeof body.workspace_name !== "string" || body.workspace_name !== body.workspace_name.trim()
    || body.workspace_name.length < 1 || body.workspace_name.length > 80
    || typeof body.idempotency_key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotency_key)
    || body.terms_version !== "hosted-usd-v1") throw new SignerError("payload_denied");
  // Clone before verification: never trust nostr-tools' cached verification symbol.
  let event: Event;
  try {
    event = JSON.parse(JSON.stringify(input.userEvent));
    if (!verifyEvent(event)) throw new Error();
  } catch { throw new SignerError("user_proof_invalid"); }
  if (event.kind !== 27235 || !Number.isSafeInteger(event.created_at) || Math.abs(event.created_at - now) > 60
    || event.id !== input.userEventId || exactProofTag(event, "u") !== input.url
    || exactProofTag(event, "method") !== "POST" || exactProofTag(event, "payload") !== hash
    || event.tags.some(tag => ["user_event_id", "wm-session-capability", "delegation"].includes(tag[0] ?? ""))) {
    throw new SignerError("user_proof_invalid");
  }
  return event;
}
