import type { EventTemplate } from "nostr-tools";
import type { SessionSnapshot } from "../agents/process-manager";
import { hasWappActivityAuthority } from "../auth/wapp-activity-authority";
import type { WappRecord } from "../wapps/types";

export interface WappLoginRequest {
  sessionId: string;
  ownerNpub: string;
  installationId: string;
  url: string;
}

export function hasWappLoginAuthority(
  input: WappLoginRequest,
  getSession: (id: string) => SessionSnapshot | null | undefined,
  getScheduledInstallationId: (id: string) => string | null | undefined,
  getInstallation: (id: string) => WappRecord | null | undefined,
): boolean {
  let url: URL;
  try { url = new URL(input.url); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || input.url !== `${url.origin}/api/auth/login`) return false;
  const installation = getInstallation(input.installationId);
  if (!installation || installation.status !== "active" || installation.recordState !== "active"
    || installation.ownerNpub !== input.ownerNpub || installation.workspaceOwnerNpub !== input.ownerNpub
    || !installation.registeredOpenOrigins.includes(url.origin)) return false;
  if (getSession(input.sessionId)?.npub !== input.ownerNpub) return false;
  return hasWappActivityAuthority({
    npub: input.ownerNpub, session: null, authMethod: "nip98", capabilitySessionId: input.sessionId,
  }, input.installationId, getSession, getScheduledInstallationId);
}

// Fetch the template ourselves: callers cannot use this route to sign arbitrary
// kind-27235 events or replay a challenge obtained from another origin.
export async function fetchWappLoginChallenge(
  loginUrl: string,
  nowMs: number,
  fetcher: typeof fetch = fetch,
): Promise<EventTemplate> {
  const response = await fetcher(new URL("/api/auth/challenge", loginUrl), {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`WApp login challenge returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("WApp login challenge has no body");
  let text = "";
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) throw new Error("WApp login challenge exceeds size limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  const event = JSON.parse(text)?.event;
  const allowedKeys = ["kind", "content", "tags", "created_at"];
  if (!event || typeof event !== "object" || Object.keys(event).some((key) => !allowedKeys.includes(key))
    || event.kind !== 27_235 || typeof event.content !== "string"
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}-login$/.test(event.content)
    || !Number.isInteger(event.created_at) || Math.abs(Math.floor(nowMs / 1000) - event.created_at) > 60
    || !Array.isArray(event.tags) || event.tags.length !== 1 || !Array.isArray(event.tags[0])
    || event.tags[0].length !== 2 || event.tags[0][0] !== "challenge"
    || typeof event.tags[0][1] !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.tags[0][1])) {
    throw new Error("WApp login challenge does not match the native login contract");
  }
  return event as EventTemplate;
}
