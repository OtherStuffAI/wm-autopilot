import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { ActiveSessionCapability, IssuedSessionCapability, SessionCapabilityPolicy } from "../signing/capability-broker";
import {
  DEFAULT_AGENT_POLICY_ID,
  buildDefaultPolicyInventory,
  type SigningPolicyDraft,
  type SigningPolicyRegistry,
} from "../signing/signing-policy-registry";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface SigningPolicyRoutesContext {
  registry: SigningPolicyRegistry;
  listCapabilities: () => ActiveSessionCapability[];
  buildBaselinePolicy: (ownerNpub?: string) => SessionCapabilityPolicy;
  reissueSessionCapability: (sessionId: string) => IssuedSessionCapability;
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: { SystemManage: AccessAction };
}

function sameRefs(left: ActiveSessionCapability["policyRefs"], right: ActiveSessionCapability["policyRefs"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sessionViews(ctx: SigningPolicyRoutesContext) {
  return ctx.listCapabilities().map((capability) => {
    const currentPolicyRefs = ctx.registry.resolveReferences({
      profileId: capability.profileId,
      workspaceId: capability.workspaceId,
    });
    return {
      ...capability,
      currentPolicyRefs,
      policyState: sameRefs(capability.policyRefs, currentPolicyRefs) ? "current" : "stale",
    };
  });
}

async function readObject(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JSON payload");
    return value as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
}

function errorResponse(error: unknown, status = 400): Response {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

function withoutToken(issued: IssuedSessionCapability): Omit<IssuedSessionCapability, "token"> {
  const { token: _token, ...safe } = issued;
  return safe;
}

export async function handleSigningPolicyApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: SigningPolicyRoutesContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/admin/signing-policies")) return null;
  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
  if (denied) return denied;

  const actorNpub = authContext.npub?.trim();
  if (!actorNpub) return Response.json({ error: "admin-only" }, { status: 403 });
  const base = "/api/admin/signing-policies";
  const suffix = url.pathname.slice(base.length).replace(/^\/+|\/+$/g, "");
  const parts = suffix ? suffix.split("/").map(decodeURIComponent) : [];

  if (parts.length === 0 && method === "GET") {
    return Response.json({
      policies: [buildDefaultPolicyInventory(ctx.buildBaselinePolicy(actorNpub)), ...ctx.registry.list()],
      sessions: sessionViews(ctx),
    });
  }

  if (parts.length === 0 && method === "POST") {
    const payload = await readObject(request);
    if (payload instanceof Response) return payload;
    try {
      return Response.json({ policy: ctx.registry.create(payload as unknown as SigningPolicyDraft, actorNpub) }, { status: 201 });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (parts[0] === "sessions" && parts[1] && parts[2] === "reissue" && parts.length === 3 && method === "POST") {
    const sessionId = parts[1];
    try {
      const issued = ctx.reissueSessionCapability(sessionId);
      return Response.json({
        success: true,
        capability: withoutToken(issued),
        consequence: "The previous bearer was revoked. The live session must adopt this explicit replacement before signing again.",
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
        recovery: "The old capability remains revoked. Restart the affected session from outside its agent process to issue a fresh capability.",
      }, { status: 409 });
    }
  }

  const policyId = parts[0] ?? "";
  if (!policyId) return Response.json({ error: "Not found" }, { status: 404 });
  if (policyId === DEFAULT_AGENT_POLICY_ID) {
    if (method === "GET" && parts.length === 1) {
      return Response.json({ policy: buildDefaultPolicyInventory(ctx.buildBaselinePolicy(actorNpub)), history: [], sessions: sessionViews(ctx) });
    }
    return Response.json({ error: "The built-in baseline is read-only" }, { status: 400 });
  }

  if (parts.length === 1 && method === "GET") {
    const policy = ctx.registry.get(policyId);
    if (!policy) return Response.json({ error: "Signing policy not found" }, { status: 404 });
    const sessions = sessionViews(ctx).filter((session) =>
      session.policyRefs.some((ref) => ref.id === policyId) || session.currentPolicyRefs.some((ref) => ref.id === policyId));
    return Response.json({ policy, history: ctx.registry.getHistory(policyId), sessions });
  }

  if (parts.length === 1 && (method === "PUT" || method === "PATCH")) {
    const payload = await readObject(request);
    if (payload instanceof Response) return payload;
    try {
      return Response.json({ policy: ctx.registry.update(policyId, payload as unknown as SigningPolicyDraft, actorNpub) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (parts.length === 2 && parts[1] === "enabled" && method === "POST") {
    const payload = await readObject(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    try {
      return Response.json({ policy: ctx.registry.setEnabled(policyId, payload.enabled, actorNpub) });
    } catch (error) {
      return errorResponse(error, 404);
    }
  }

  if (parts.length === 2 && parts[1] === "history" && method === "GET") {
    if (!ctx.registry.get(policyId)) return Response.json({ error: "Signing policy not found" }, { status: 404 });
    return Response.json({ history: ctx.registry.getHistory(policyId) });
  }

  if (parts.length === 2 && parts[1] === "sessions" && method === "GET") {
    if (!ctx.registry.get(policyId)) return Response.json({ error: "Signing policy not found" }, { status: 404 });
    return Response.json({ sessions: sessionViews(ctx).filter((session) =>
      session.policyRefs.some((ref) => ref.id === policyId) || session.currentPolicyRefs.some((ref) => ref.id === policyId)) });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
