import type { RequestAuthContext } from "../auth/request-context";
import { object, SecretError } from "./secret-policy";
import type { SecretStore } from "./secret-store";
import type { HostedSiteSigner } from "../signing/hosted-site-signer";
import { handleHostedSiteManagement } from "../signing/hosted-site-routes";

export interface SecretInventory {
  apps?: Array<{ id: string; label: string; root: string }>;
  workspaces: Array<{ id: string; label: string }>;
  identities: Array<{ npub: string; label: string; type: "user" | "bot" }>;
  pipelines: Array<{ id: string; label: string }>;
}
export interface SecretRoutesContext {
  hostedSiteSigner?: HostedSiteSigner;
  store: SecretStore;
  inventory: (owner: string) => Promise<SecretInventory>;
}
function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
export async function handleSecretRoutes(request: Request, url: URL, auth: RequestAuthContext, ctx: SecretRoutesContext): Promise<Response | null> {
  if (url.pathname !== "/api/secrets" && !url.pathname.startsWith("/api/secrets/")) return null;
  if (ctx.hostedSiteSigner) {
    const response = await handleHostedSiteManagement(request, url, auth, ctx.hostedSiteSigner);
    if (response) return response;
  }
  // Management requires the real authenticated owner, never delegated/broker agent identity.
  const owner = auth.npub;
  if (!owner || auth.delegatedByBot || auth.delegatedOwnerNpub || auth.capabilitySessionId
    || (auth.actorNpub && auth.actorNpub !== owner)) return response({ error: "secret_management_denied" }, 403);
  try {
    const inventory = await ctx.inventory(owner);
    const workspace = url.searchParams.get("workspace") ?? "local";
    if (!inventory.workspaces.some(item => item.id === workspace)) throw new SecretError("workspace_denied", 403);
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    if (parts.length === 3 && id === "inventory" && request.method === "GET") return response(inventory);
    if (parts.length === 2 && request.method === "GET") return response({ secrets: ctx.store.list(owner, workspace) });
    if (parts.length === 3 && request.method === "GET") return response({ secret: ctx.store.get(owner, workspace, id!) });
    if (parts.length === 4 && parts[3] === "audit" && request.method === "GET") return response({ audit: ctx.store.history(owner, workspace, id!) });
    if (Number(request.headers.get("content-length")) > 100_000) throw new SecretError("request_too_large", 413);
    const text = await request.text();
    if (Buffer.byteLength(text) > 100_000) throw new SecretError("request_too_large", 413);
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(text)); } catch { throw new SecretError("invalid_request"); }
    if (parts.length === 2 && request.method === "POST") return response({ secret: ctx.store.create(owner, workspace, body) }, 201);
    if (parts.length === 3 && request.method === "PUT") return response({ secret: ctx.store.update(owner, workspace, id!, body) });
    if (parts.length === 3 && request.method === "DELETE") return response({ secret: ctx.store.revoke(owner, workspace, id!, body.revision) });
    return response({ error: "not_found" }, 404);
  } catch (error) {
    // Parse, crypto and caller-supplied exceptions must never echo the request/value.
    return response({ error: error instanceof SecretError ? error.code : "secret_request_failed" }, error instanceof SecretError ? error.status : 400);
  }
}
