import { allow, deny, type AccessRule } from "./access-control";
import { normaliseNpub } from "../identity/npub-utils";

const resolveSelfSessionTarget = (pathname: string): { sessionId: string; operation: "metadata" | "stop" } | null => {
  const metadataMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/metadata$/);
  if (metadataMatch?.[1]) {
    try {
      return { sessionId: decodeURIComponent(metadataMatch[1]), operation: "metadata" };
    } catch {
      return null;
    }
  }
  const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (stopMatch?.[1]) {
    try {
      return { sessionId: decodeURIComponent(stopMatch[1]), operation: "stop" };
    } catch {
      return null;
    }
  }
  return null;
};

const allowsCapabilityBoundSelfSessionOperation = (
  context: Parameters<AccessRule>[0],
  kind: "apps" | "sessions",
): boolean => {
  if (kind !== "sessions" || context.auth.authMethod !== "nip98" || !context.auth.capabilitySessionId) {
    return false;
  }
  const target = resolveSelfSessionTarget(context.url.pathname);
  if (!target || target.sessionId !== context.auth.capabilitySessionId) return false;
  return (target.operation === "metadata" && context.request.method === "PATCH") ||
    (target.operation === "stop" && context.request.method === "DELETE");
};

export interface ExecutionAuditEntry {
  actorNpub: string | null;
  ownerNpub: string | null;
  delegationId: string | null;
  scope: string | null;
  target: string;
  action: string;
  outcome: "allowed" | "denied";
  timestamp: string;
}

export function createTrustedExecutionRule(input: {
  kind: "apps" | "sessions";
  isAdminNpub: (npub: string | null | undefined) => boolean;
  isApprovedNpub?: (npub: string | null | undefined) => boolean;
  audit?: (entry: ExecutionAuditEntry) => void;
  now?: () => Date;
}): AccessRule {
  return (context) => {
    const actorNpub = normaliseNpub(
      context.auth.subjectNpub ?? context.auth.signerNpub ?? context.auth.actorNpub ?? context.auth.npub ?? null,
    );
    const ownerNpub = normaliseNpub(context.auth.targetOwnerNpub ?? context.auth.npub ?? null);
    const directAdmin = Boolean(actorNpub && input.isAdminNpub(actorNpub) && actorNpub === ownerNpub);
    const directApprovedSessionUser = Boolean(
      input.kind === "sessions" &&
      actorNpub &&
      actorNpub === ownerNpub &&
      input.isApprovedNpub?.(actorNpub),
    );
    const scope = context.auth.delegateExecutionScope ?? null;
    const delegated = Boolean(
      actorNpub &&
      ownerNpub &&
      input.isAdminNpub(ownerNpub) &&
      context.auth.delegateRelationshipId &&
      scope &&
      (context.auth.delegateScopes?.includes(scope) ||
        (input.kind === "apps" && context.auth.delegateScopes?.includes("apps:manage"))),
    );
    const selfSession = allowsCapabilityBoundSelfSessionOperation(context, input.kind);
    const allowed = directAdmin || directApprovedSessionUser || delegated || selfSession;
    input.audit?.({
      actorNpub,
      ownerNpub,
      delegationId: context.auth.delegateRelationshipId ?? null,
      scope: directAdmin
        ? `${input.kind}:admin`
        : directApprovedSessionUser
          ? "sessions:approved"
          : selfSession
            ? "sessions:self"
            : scope,
      target: context.url.pathname,
      action: `${context.request.method} ${context.url.pathname}`,
      outcome: allowed ? "allowed" : "denied",
      timestamp: (input.now?.() ?? new Date()).toISOString(),
    });
    return allowed ? allow() : deny("admin-or-execution-delegation-required", 403);
  };
}
