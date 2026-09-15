import type { AccessContext } from "./access-control";

export function isCapabilityBoundSelfSessionMetadataRead(context: AccessContext): boolean {
  if (context.auth.authMethod !== "nip98" || !context.auth.capabilitySessionId) return false;
  if (context.request.method !== "GET") return false;
  const match = context.url.pathname.match(/^\/api\/sessions\/([^/]+)\/metadata$/);
  if (!match?.[1]) return false;
  try {
    return decodeURIComponent(match[1]) === context.auth.capabilitySessionId;
  } catch {
    return false;
  }
}
