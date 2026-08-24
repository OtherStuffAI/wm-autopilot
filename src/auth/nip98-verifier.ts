import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { nip19, verifyEvent, type Event } from "nostr-tools";

import { Nip98ReplayCache } from "./nip98-replay-cache";

export { Nip98ReplayCache, NIP98_REPLAY_CACHE_LIMIT } from "./nip98-replay-cache";

export const NIP98_MAX_AGE_SECONDS = 60;
export const NIP98_CLOCK_SKEW_SECONDS = 15;

export interface Nip98Verification {
  signerNpub: string;
  event: Event;
}

function singleTag(event: Event, name: string): string | null {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 && typeof tags[0]?.[1] === "string" ? tags[0][1] : null;
}

export function canonicalNip98RequestUrl(requestUrl: URL, configuredBaseUrl: string): string {
  const configured = configuredBaseUrl.trim();
  if (!configured) return requestUrl.toString();
  const base = new URL(configured);
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, base.origin).toString();
}

export async function verifyNip98Request(input: {
  request: Request;
  requestUrl: URL;
  configuredBaseUrl: string;
  replayCache: Nip98ReplayCache;
  now?: number;
}): Promise<Nip98Verification | null> {
  const authHeader = input.request.headers.get("authorization");
  if (!authHeader?.startsWith("Nostr ")) return null;

  try {
    const event = JSON.parse(atob(authHeader.slice(6))) as Event;
    if (!verifyEvent(event) || event.kind !== 27235) return null;

    const signedUrl = singleTag(event, "u");
    const signedMethod = singleTag(event, "method");
    if (!signedUrl || signedUrl !== canonicalNip98RequestUrl(input.requestUrl, input.configuredBaseUrl)) return null;
    if (!signedMethod || signedMethod !== input.request.method.toUpperCase()) return null;

    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(event.created_at)) return null;
    if (event.created_at > now + NIP98_CLOCK_SKEW_SECONDS) return null;
    if (event.created_at < now - NIP98_MAX_AGE_SECONDS) return null;

    const bodyBytes = new Uint8Array(await input.request.clone().arrayBuffer());
    const payloadTags = event.tags.filter((tag) => tag[0] === "payload");
    if (bodyBytes.length === 0) {
      if (payloadTags.length !== 0) return null;
    } else {
      if (payloadTags.length !== 1 || typeof payloadTags[0]?.[1] !== "string") return null;
      if (payloadTags[0][1].toLowerCase() !== bytesToHex(sha256(bodyBytes))) return null;
    }

    const expiresAt = event.created_at + NIP98_MAX_AGE_SECONDS + NIP98_CLOCK_SKEW_SECONDS + 1;
    if (!input.replayCache.accept(event.id, expiresAt, now)) return null;
    return { signerNpub: nip19.npubEncode(event.pubkey), event };
  } catch {
    return null;
  }
}
