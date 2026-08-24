import { isAbsolute, normalize, resolve as resolvePath, sep } from "node:path";

import type { AppRecord } from "../apps/app-registry";
import type { RequestAuthContext } from "./request-context";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { WorkspaceDelegationRecord } from "../storage/workspace-delegation-store";
import { normaliseNpub } from "../identity/npub-utils";

export const DelegationScopes = {
  SessionsRead: "sessions:read",
  SessionsCreate: "sessions:create",
  SessionsManage: "sessions:manage",
  SessionsMessage: "sessions:message",
  AppsRead: "apps:read",
  AppsManage: "apps:manage",
  AppsOperate: "apps:operate",
  AppsConfigure: "apps:configure",
  AppsBuild: "apps:build",
  DeploymentsManage: "deployments:manage",
  WappsRead: "wapps:read",
  WappsInstall: "wapps:install",
  WappsAssign: "wapps:assign",
  FilesRead: "files:read",
  FilesWrite: "files:write",
} as const;

export type DelegationScope = (typeof DelegationScopes)[keyof typeof DelegationScopes];

export interface OwnerAccessResolution {
  ownerNpub: string;
  subjectNpub: string;
  signerNpub: string;
  selfAccess: boolean;
  delegation: WorkspaceDelegationRecord | null;
}

function normalisePathList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => normalize(value)),
    ),
  );
}

function isPathWithin(target: string, base: string): boolean {
  const normalizedTarget = normalize(target);
  const normalizedBase = normalize(base);
  return (
    normalizedTarget === normalizedBase ||
    normalizedTarget.startsWith(
      normalizedBase.endsWith(sep) ? normalizedBase : `${normalizedBase}${sep}`,
    )
  );
}

function getCallerSubjectNpub(authContext: RequestAuthContext): string | null {
  return normaliseNpub(authContext.subjectNpub ?? authContext.signerNpub ?? authContext.actorNpub ?? authContext.npub ?? null);
}

function getCallerSignerNpub(authContext: RequestAuthContext): string | null {
  return normaliseNpub(authContext.signerNpub ?? authContext.actorNpub ?? authContext.npub ?? null);
}

export function createOwnerScopedAuthContext(
  authContext: RequestAuthContext,
  ownerNpub: string,
  access?: OwnerAccessResolution,
  executionScope?: string,
): RequestAuthContext {
  return {
    ...authContext,
    targetOwnerNpub: ownerNpub,
    delegatedOwnerNpub: access && !access.selfAccess ? ownerNpub : null,
    delegateRelationshipId: access?.delegation?.id ?? null,
    delegateScopes: access?.delegation?.scopes ?? null,
    delegateExecutionScope: executionScope ?? null,
  };
}

export function resolveOwnerAccess(
  authContext: RequestAuthContext,
  ownerNpub: string,
  findActiveDelegation: (ownerNpub: string, delegateNpub: string, scope?: string) => WorkspaceDelegationRecord | null,
  scope: string,
): OwnerAccessResolution | null {
  const normalizedOwner = normaliseNpub(ownerNpub);
  const subjectNpub = getCallerSubjectNpub(authContext);
  const signerNpub = getCallerSignerNpub(authContext);
  if (!normalizedOwner || !subjectNpub || !signerNpub) {
    return null;
  }

  if (normalizedOwner === subjectNpub) {
    return {
      ownerNpub: normalizedOwner,
      subjectNpub,
      signerNpub,
      selfAccess: true,
      delegation: null,
    };
  }

  const delegation =
    findActiveDelegation(normalizedOwner, subjectNpub, scope) ??
    (scope.startsWith("apps:") && scope !== DelegationScopes.AppsRead
      ? findActiveDelegation(normalizedOwner, subjectNpub, DelegationScopes.AppsManage)
      : null);
  if (!delegation) {
    return null;
  }

  return {
    ownerNpub: normalizedOwner,
    subjectNpub,
    signerNpub,
    selfAccess: false,
    delegation,
  };
}

export function hasDelegationScope(
  delegation: WorkspaceDelegationRecord | null | undefined,
  scope: string,
): boolean {
  return Boolean(delegation && delegation.scopes.includes(scope));
}

export function getDelegatedBillingNpub(
  authContext: RequestAuthContext,
  ownerNpub: string,
  delegation: WorkspaceDelegationRecord | null,
): string | null {
  const subjectNpub = getCallerSubjectNpub(authContext);
  const normalizedOwner = normaliseNpub(ownerNpub);
  if (!subjectNpub || !normalizedOwner) {
    return null;
  }
  if (!delegation) {
    return normalizedOwner;
  }
  return delegation.billingMode === "owner" ? normalizedOwner : subjectNpub;
}

export function buildDelegatedWorkspaceScope(
  baseScope: WorkspaceScope,
  delegation: WorkspaceDelegationRecord | null,
): WorkspaceScope {
  if (!delegation?.resourceFilters) {
    return baseScope;
  }
  const filters = delegation.resourceFilters;
  const limitedDirectories = normalisePathList([
    ...(filters.pathPrefixes ?? []),
    ...(filters.projectRoots ?? []),
    ...(filters.appRoots ?? []),
  ]).filter((candidate) =>
    baseScope.allowedDirectories.some((allowed) => isPathWithin(candidate, allowed)),
  );

  if (limitedDirectories.length === 0) {
    return baseScope;
  }

  const defaultDirectory = limitedDirectories.find((path) => isPathWithin(baseScope.defaultDirectory, path))
    ? baseScope.defaultDirectory
    : limitedDirectories[0]!;

  return {
    ...baseScope,
    allowedDirectories: limitedDirectories,
    defaultDirectory,
  };
}

export function delegationAllowsPath(
  delegation: WorkspaceDelegationRecord | null,
  ownerScope: WorkspaceScope,
  candidatePath: string | null | undefined,
): boolean {
  if (!delegation || !candidatePath) {
    return true;
  }
  const filters = delegation.resourceFilters;
  if (!filters) {
    return true;
  }

  const relevantPrefixes = normalisePathList([
    ...(filters.pathPrefixes ?? []),
    ...(filters.projectRoots ?? []),
    ...(filters.appRoots ?? []),
  ]);
  if (relevantPrefixes.length === 0) {
    return true;
  }

  const absoluteCandidate = normalize(
    isAbsolute(candidatePath)
      ? candidatePath
      : resolvePath(ownerScope.docsRoot, candidatePath),
  );
  if (!isPathWithin(absoluteCandidate, ownerScope.docsRoot)) {
    return false;
  }
  return relevantPrefixes.some((prefix) => isPathWithin(absoluteCandidate, prefix));
}

export function delegationAllowsApp(
  delegation: WorkspaceDelegationRecord | null,
  app: Pick<AppRecord, "id" | "root">,
): boolean {
  if (!delegation) {
    return true;
  }
  const filters = delegation.resourceFilters;
  if (!filters) {
    return true;
  }
  if (filters.appIds?.includes(app.id)) {
    return true;
  }
  const root = normalize(app.root);
  const allowedRoots = normalisePathList([
    ...(filters.appRoots ?? []),
    ...(filters.projectRoots ?? []),
    ...(filters.pathPrefixes ?? []),
  ]);
  if (allowedRoots.length === 0) {
    return !filters.appIds || filters.appIds.length === 0;
  }
  return allowedRoots.some((allowedRoot) => isPathWithin(root, allowedRoot));
}
