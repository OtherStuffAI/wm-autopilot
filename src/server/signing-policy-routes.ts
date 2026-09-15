import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { ActiveSessionCapability, IssuedSessionCapability, SessionCapabilityPolicy } from "../signing/capability-broker";
import { AGENT_SIGNING_MODE_PRESETS, type AgentSigningMode } from "../signing/agent-signing-policy";
import type { AgentSigningModeSnapshot } from "../signing/agent-signing-mode-settings";
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
  getActiveMode: () => AgentSigningModeSnapshot;
  setActiveMode: (mode: AgentSigningMode | string, actorNpub: string) => AgentSigningModeSnapshot;
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
  const activeMode = ctx.getActiveMode().mode;
  return ctx.listCapabilities().map((capability) => {
    const currentPolicyRefs = ctx.registry.resolveReferences({
      profileId: capability.profileId,
      workspaceId: capability.workspaceId,
    });
    const refsCurrent = sameRefs(capability.policyRefs, currentPolicyRefs);
    const modeCurrent = capability.policyMode === activeMode;
    return {
      ...capability,
      currentPolicyRefs,
      currentMode: activeMode,
      policyState: refsCurrent && modeCurrent ? "current" : "stale",
      staleReasons: [
        ...(refsCurrent ? [] : ["policy-revisions"]),
        ...(modeCurrent ? [] : ["signing-mode"]),
      ],
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

function reissueActiveSessions(ctx: SigningPolicyRoutesContext) {
  const sessionIds = [...new Set(ctx.listCapabilities().map((capability) => capability.sessionId))].sort();
  return sessionIds.map((sessionId) => {
    try {
      return {
        sessionId,
        status: "replacement-issued",
        restartRequired: false,
        adoption: "broker-client-adopts-on-next-signing-call",
        capability: withoutToken(ctx.reissueSessionCapability(sessionId)),
      };
    } catch (error) {
      return {
        sessionId,
        status: "restart-required",
        restartRequired: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function sessionsReferencingPolicy(ctx: SigningPolicyRoutesContext, policyId: string) {
  return sessionViews(ctx).filter((session) =>
    session.policyRefs.some((ref) => ref.id === policyId) || session.currentPolicyRefs.some((ref) => ref.id === policyId));
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
    const baseline = ctx.buildBaselinePolicy(actorNpub);
    const mode = ctx.getActiveMode();
    return Response.json({
      modes: AGENT_SIGNING_MODE_PRESETS,
      mode,
      activeMode: mode.mode,
      policies: [buildDefaultPolicyInventory(baseline), ...ctx.registry.list()],
      sessions: sessionViews(ctx),
    });
  }

  if (parts.length === 1 && parts[0] === "mode" && method === "GET") {
    return Response.json({ modes: AGENT_SIGNING_MODE_PRESETS, mode: ctx.getActiveMode(), sessions: sessionViews(ctx) });
  }

  if (parts.length === 1 && parts[0] === "mode" && (method === "PUT" || method === "POST" || method === "PATCH")) {
    const payload = await readObject(request);
    if (payload instanceof Response) return payload;
    if (typeof payload.mode !== "string") return Response.json({ error: "mode is required" }, { status: 400 });
    try {
      const mode = ctx.setActiveMode(payload.mode, actorNpub);
      const sessions = reissueActiveSessions(ctx);
      const restartRequired = sessions.filter((session) => session.restartRequired);
      return Response.json({
        success: restartRequired.length === 0,
        mode,
        activeMode: mode.mode,
        sessions,
        consequence: restartRequired.length
          ? "The signing mode is active for new capabilities. Some live sessions need an external restart before they can sign with the selected mode."
          : "The signing mode is active for new capabilities. Active sessions received explicit replacements; broker clients adopt them on the next signing call.",
      });
    } catch (error) {
      return errorResponse(error);
    }
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
    return Response.json({ policy, history: ctx.registry.getHistory(policyId), sessions: sessionsReferencingPolicy(ctx, policyId) });
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

  if (parts.length === 1 && method === "DELETE") {
    try {
      const deleted = ctx.registry.delete(policyId, actorNpub);
      return Response.json({
        deleted: { id: deleted.id, revision: deleted.revision, name: deleted.name },
        history: ctx.registry.getHistory(policyId),
        sessions: sessionsReferencingPolicy(ctx, policyId),
        consequence: "New and reissued sessions will not receive this policy. Existing issued capabilities are not mutated here and may keep their prior permissions until reissued, restarted, revoked, or expired.",
      });
    } catch (error) {
      return errorResponse(error, error instanceof Error && error.message === "Signing policy not found" ? 404 : 400);
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
    const history = ctx.registry.getHistory(policyId);
    if (!ctx.registry.get(policyId) && history.length === 0) return Response.json({ error: "Signing policy not found" }, { status: 404 });
    return Response.json({ history });
  }

  if (parts.length === 2 && parts[1] === "sessions" && method === "GET") {
    if (!ctx.registry.get(policyId)) return Response.json({ error: "Signing policy not found" }, { status: 404 });
    return Response.json({ sessions: sessionViews(ctx).filter((session) =>
      session.policyRefs.some((ref) => ref.id === policyId) || session.currentPolicyRefs.some((ref) => ref.id === policyId)) });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
