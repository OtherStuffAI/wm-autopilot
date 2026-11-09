import type { RequestAuthContext } from "../auth/request-context";
import type { SecretRoutesContext } from "../secrets/secret-routes";
import { SecretError, object } from "../secrets/secret-policy";

/** Human management shares the existing secret inventory and custody boundary. */
export async function handleModelProviderRoutes(request: Request, url: URL, auth: RequestAuthContext, ctx: SecretRoutesContext): Promise<Response | null> {
  if (url.pathname !== "/api/model-providers/tinfoil" && url.pathname !== "/api/model-providers/tinfoil/test") return null;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const owner = auth.npub;
  if (!owner || auth.delegatedByBot || auth.delegatedOwnerNpub || auth.capabilitySessionId || (auth.actorNpub && auth.actorNpub !== owner)) return reply({ error: "provider_management_denied" }, 403);
  try {
    const workspace = url.searchParams.get("workspace") ?? "local";
    const inventory = await ctx.inventory(owner);
    if (!inventory.workspaces.some(row => row.id === workspace)) throw new SecretError("workspace_denied", 403);
    if (request.method === "GET" && !url.pathname.endsWith("/test")) return reply({ connection: ctx.store.providerConnection(owner, workspace) });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 16_384) throw new SecretError("request_too_large", 413);
    const body = object(JSON.parse(raw));
    if (request.method === "PUT" && !url.pathname.endsWith("/test")) return reply({ connection: ctx.store.saveProviderConnection(owner, workspace, body) });
    if (request.method === "POST" && url.pathname.endsWith("/test")) {
      if (Object.keys(body).length !== 1 || typeof body.identityNpub !== "string") throw new SecretError("select_test_identity");
      const connection = ctx.store.providerConnection(owner, workspace);
      if (!connection?.enabled || !ctx.testModelProvider) throw new SecretError("provider_not_ready", 503);
      const result = await ctx.testModelProvider(owner, workspace, body.identityNpub);
      return reply(result);
    }
    return reply({ error: "method_not_allowed" }, 405);
  } catch (error) { return reply({ error: error instanceof SecretError ? error.code : "provider_request_failed" }, error instanceof SecretError ? error.status : 400); }
}
