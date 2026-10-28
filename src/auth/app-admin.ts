import type { AppRecord } from "../apps/app-registry";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import { getEffectiveOwnerAuthContext, getEffectiveOwnerNpub } from "./effective-owner";
import { allow, type AccessRule } from "./access-control";
import type { RequestAuthContext } from "./request-context";
import { normaliseNpub } from "../identity/npub-utils";

/** Instance authority belongs to the authenticated principal, never its custodian. */
export function isAppAdmin(
  auth: RequestAuthContext,
  isAdminNpub: (npub: string | null | undefined) => boolean,
): boolean {
  return isAdminNpub(normaliseNpub(auth.subjectNpub ?? auth.signerNpub ?? auth.actorNpub ?? auth.npub));
}

export function withAppAdminAccess(rule: AccessRule, isAdminNpub: (npub: string | null | undefined) => boolean): AccessRule {
  return (context) => isAppAdmin(context.auth, isAdminNpub) ? allow() : rule(context);
}

export function resolveAppAuthority(input: {
  auth: RequestAuthContext;
  isAdminNpub: (npub: string | null | undefined) => boolean;
  resolveWorkspace: (auth: RequestAuthContext) => WorkspaceScope;
  workspaceScopeOverride?: WorkspaceScope;
  canAccessAppOverride?: (app: AppRecord) => boolean;
}) {
  const admin = isAppAdmin(input.auth, input.isAdminNpub);
  const auth = getEffectiveOwnerAuthContext(admin ? { ...input.auth, delegatedOwnerNpub: null } : input.auth);
  const workspaceScope = { ...(input.workspaceScopeOverride ?? input.resolveWorkspace(auth)), isAdmin: admin };
  const viewerNpub = getEffectiveOwnerNpub(auth);
  return {
    workspaceScope,
    viewerNpub,
    canManageCore: admin,
    canAccessApp: (app: AppRecord) => input.canAccessAppOverride
      ? input.canAccessAppOverride(app)
      : admin || Boolean(viewerNpub && normaliseNpub(app.ownerNpub) === viewerNpub),
  };
}
