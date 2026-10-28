import type { Nip98Constraint, SessionCapabilityPolicy } from "./capability-broker";
import { normaliseNpub } from "../identity/npub-utils";
import { hasAdminSigningBaseline, isAdminApiPath } from "./admin-signing-policy";

/** Evaluated for every request; role changes do not require a new bearer token. */
export function liveAdminSigningTargets(input: {
  botNpub: string;
  policy: SessionCapabilityPolicy;
  url: URL;
  autopilotUrl: string;
  isAdminNpub: (npub: string) => boolean;
}): NonNullable<Nip98Constraint["targets"]> {
  const origin = new URL(input.autopilotUrl).origin;
  if (!hasAdminSigningBaseline(input.policy, origin)) return [];
  if (!input.isAdminNpub(input.botNpub) || input.url.origin !== origin) return [];
  const ownerRoute = input.url.pathname.match(/^\/api\/owners\/([^/]+)(?:\/|$)/);
  if (ownerRoute && !normaliseNpub(ownerRoute[1])) return [];
  if (!isAdminApiPath(input.url.pathname)) return [];
  return [{
    origin: input.url.origin,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    pathPrefixes: [],
    exactPaths: [{ path: input.url.pathname,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      requireBodyHash: false }],
    // The API verifier requires the exact payload hash whenever bytes are sent.
    requireBodyHashMethods: [],
  }];
}
