import type { Nip98Constraint, SessionCapabilityPolicy } from "./capability-broker";
import { normaliseNpub } from "../identity/npub-utils";

/** Evaluated for every request; role changes do not require a new bearer token. */
export function liveAdminAppSigningTargets(input: {
  botNpub: string;
  policy: SessionCapabilityPolicy;
  url: URL;
  autopilotUrl: string;
  isAdminNpub: (npub: string) => boolean;
}): NonNullable<Nip98Constraint["targets"]> {
  if (input.policy.mode !== "standard-agent" && input.policy.mode !== "full-nostr") return [];
  // Only extend the normal operational baseline. A deliberately narrower/custom
  // capability keeps its own signing limits even when its principal is an admin.
  const origin = new URL(input.autopilotUrl).origin;
  const baseline = input.policy.nip98?.targets?.find((target) => target.origin === origin
    && ["/api/apps", "/api/sessions", "/api/wapps"].every((path) => target.pathPrefixes.includes(path))
    && ["GET", "POST", "PUT", "PATCH", "DELETE"].every((method) => target.methods.includes(method)));
  if (!baseline) return [];
  if (!input.isAdminNpub(input.botNpub) || input.url.origin !== new URL(input.autopilotUrl).origin) return [];
  const ownerRoute = input.url.pathname.match(/^\/api\/owners\/([^/]+)\/apps(?:\/|$)/);
  if (ownerRoute && !normaliseNpub(ownerRoute[1])) return [];
  if (!ownerRoute && !/^\/api\/admin\/(?:users|signing-policies)(?:\/|$)/.test(input.url.pathname)) return [];
  return [{
    origin: input.url.origin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pathPrefixes: [input.url.pathname],
    requireBodyHashMethods: ["POST", "PUT", "PATCH"],
  }];
}
