import type { SessionCapabilityPolicy } from "./capability-broker";
import { DEFAULT_AGENT_NOSTR_EVENT_KINDS } from "./agent-signing-policy";

/** Recognize the ordinary operational baseline, not custom or narrowed grants. */
export function hasAdminSigningBaseline(policy: SessionCapabilityPolicy, origin?: string): boolean {
  if (policy.mode !== "standard-agent" && policy.mode !== "full-nostr") return false;
  if (policy.nip98?.bodyHashes?.length) return false;
  return Boolean(policy.nip98?.targets?.some(target => (!origin || target.origin === origin)
    && ["/api/apps", "/api/sessions", "/api/wapps"].every(path => target.pathPrefixes.includes(path))
    && ["GET", "POST", "PUT", "PATCH", "DELETE"].every(method => target.methods.includes(method))));
}

/** Live admin expansion adds event kinds without overriding per-kind constraints. */
export function adminMaySignEvent(policy: SessionCapabilityPolicy, kind: number): boolean {
  if (!hasAdminSigningBaseline(policy) || !policy.nostr) return false;
  if (!DEFAULT_AGENT_NOSTR_EVENT_KINDS.every(value => policy.nostr!.kinds.includes(value))) return false;
  // Authentication and object authorization have dedicated broker validators.
  return Number.isSafeInteger(kind) && kind >= 0 && kind <= 65_535 && kind !== 445 && kind !== 27_235 && kind !== 24_242;
}

export const ADMIN_API_FAMILIES = Object.freeze([
  "admin", "agent-chat", "apps", "archive", "artifacts", "auth", "billing", "caprover", "chats", "cloudflare",
  "config", "control-plane", "delegations", "delegate-sessions", "directories", "docs",
  "feature-flags", "git", "gitea", "identity", "instance-settings", "logs", "maple", "ngit", "nightwatch",
  "npub-projects", "owners", "pipelines", "projects", "remote-instruct", "scheduler",
  "session-dispatches", "sessions", "skills", "system", "terminal", "todos", "uploads",
  "user", "wapps", "workspace",
]);

export function isAdminApiPath(path: string): boolean {
  return ADMIN_API_FAMILIES.some(family => path === `/api/${family}` || path.startsWith(`/api/${family}/`));
}
