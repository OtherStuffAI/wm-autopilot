import type { RequestAuthContext } from "../auth/request-context";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import type { AccessAction } from "../auth/access-control";
import {
  validateSignedWorkspaceDelegationEvent,
  WORKSPACE_DELEGATION_KIND,
} from "../auth/delegation-payload";
import { normaliseNpub } from "../identity/npub-utils";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface DelegationRoutesContext {
  workspaceDelegationStore: WorkspaceDelegationStore;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: {
    DelegationsManage: AccessAction;
  };
}

function getCallerNpub(authContext: RequestAuthContext): string | null {
  return normaliseNpub(authContext.subjectNpub ?? authContext.signerNpub ?? authContext.npub ?? null);
}

export async function handleDelegationApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: DelegationRoutesContext,
): Promise<Response | null> {
  const pathname = url.pathname;
  const callerNpub = getCallerNpub(authContext);

  if (pathname === "/api/delegations" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.DelegationsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    if (!callerNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    return Response.json({
      delegations: ctx.workspaceDelegationStore.listDelegationsVisibleTo(callerNpub),
    });
  }

  if (pathname === "/api/delegations" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.DelegationsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    if (!callerNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const signedEventInput = (payload as Record<string, unknown>).signedEvent;
    try {
      const { payload: delegationPayload, signedEvent } = validateSignedWorkspaceDelegationEvent(signedEventInput);
      if (normaliseNpub(delegationPayload.ownerNpub) !== callerNpub) {
        return Response.json({ error: "Only the owner can register a delegation" }, { status: 403 });
      }

      const record = ctx.workspaceDelegationStore.createDelegation({
        payload: delegationPayload,
        signedPayload: signedEvent.content,
        signature: signedEvent.sig,
        eventId: signedEvent.id,
        createdBy: callerNpub,
      });
      return Response.json(
        {
          delegation: record,
          kind: WORKSPACE_DELEGATION_KIND,
        },
        { status: 201 },
      );
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/delegations/") && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.DelegationsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    if (!callerNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    const delegationId = pathname.split("/")[3];
    if (!delegationId) {
      return Response.json({ error: "Delegation id required" }, { status: 400 });
    }
    const existing = ctx.workspaceDelegationStore.getDelegationById(delegationId);
    if (!existing) {
      return Response.json({ error: "Delegation not found" }, { status: 404 });
    }
    const isParticipant =
      normaliseNpub(existing.ownerNpub) === callerNpub ||
      normaliseNpub(existing.delegateNpub) === callerNpub;
    if (!isParticipant) {
      return Response.json({ error: "Delegation not found" }, { status: 404 });
    }
    const revoked = ctx.workspaceDelegationStore.revokeDelegation(delegationId);
    if (!revoked) {
      return Response.json({ error: "Delegation already revoked" }, { status: 409 });
    }
    return Response.json({ id: delegationId, revoked: true });
  }

  if (pathname.startsWith("/api/owners/") && pathname.endsWith("/delegations") && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.DelegationsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    if (!callerNpub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    const parts = pathname.split("/").filter(Boolean);
    const ownerNpub = normaliseNpub(parts[2] ?? null);
    if (!ownerNpub) {
      return Response.json({ error: "Owner npub is required" }, { status: 400 });
    }
    const canRead = callerNpub === ownerNpub || Boolean(ctx.workspaceDelegationStore.findActiveDelegation(ownerNpub, callerNpub));
    if (!canRead) {
      return Response.json({ error: "Delegation not found" }, { status: 404 });
    }
    return Response.json({
      ownerNpub,
      delegations: ctx.workspaceDelegationStore.listDelegationsForOwner(ownerNpub),
    });
  }

  return null;
}
