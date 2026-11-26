import { WappScopeAccessError, type ResolveWappScopeAccessInput } from "../wapps/scope-access";
import type { WappsApiContext } from "./wapps-api-routes";

export async function resolveWappScopeAccessForRequest(
  ctx: Pick<WappsApiContext, "scopeAccessResolver" | "viewerNpub" | "actorNpub" | "wappStore">,
  input: ResolveWappScopeAccessInput & { towerBindingId?: string | null },
) {
  const towerBinding = input.towerBindingId ? ctx.wappStore.getTowerBinding(input.towerBindingId) : null;
  if (input.towerBindingId && !towerBinding) {
    throw new WappScopeAccessError("invalid-scope", "Selected WApp Tower binding is unavailable");
  }
  return ctx.scopeAccessResolver.resolveWappScopeAccess({
    ...input,
    towerBinding,
    managerNpub: ctx.viewerNpub,
    actorNpub: ctx.actorNpub ?? ctx.viewerNpub,
  });
}
