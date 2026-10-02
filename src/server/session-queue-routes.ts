/** /api/sessions/:id/queue and /api/sessions/:id/queue/:itemId/acknowledge. */
import type { SessionApiContext } from "./session-api-routes";
import type { SessionSnapshot } from "../agents/process-manager";
import type { RequestAuthContext } from "../auth/request-context";
import { PromptQueueConflict } from "../storage/prompt-queue-store";
type HttpMethod = string;

export async function handleQueueRoutes(
  request: Request,
  method: HttpMethod,
  parts: string[],
  id: string,
  ownedSession: SessionSnapshot | null,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  if (!ownedSession) return Response.json({ error: "Session not found" }, { status: 404 });
  if (method === "GET" && parts.length === 5) {
    const prompts = ctx.promptQueueStore.getSessionQueue(id);
    return Response.json({ id, queue: { prompts, handled: ctx.promptQueueStore.getHandledPrompts(id), maxSize: 21 } });
  }

  if (method === "POST" && parts.length === 7 && ["acknowledge", "reconcile"].includes(parts[6]!)) {
    if (ownedSession.status !== "running") return Response.json({ error: "Active session required" }, { status: 409 });
    if (parts[6] === "reconcile" && ctx.queueDispatchInFlight.has(id)) {
      return Response.json({ error: "Delivery attempt is still active; wait for its outcome before reconciling" }, { status: 409 });
    }
    let payload: Record<string, unknown>;
    try { payload = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "Invalid JSON payload" }, { status: 400 }); }
    if (typeof payload?.revision !== "string" || !/^[1-9][0-9]*$/.test(payload.revision)
      || typeof payload?.reason !== "string" || !payload.reason.trim()) {
      return Response.json({ error: "Exact read revision and nonempty reason are required" }, { status: 400 });
    }
    const actor = authContext.capabilitySessionId
      ? `session:${authContext.capabilitySessionId}`
      : authContext.subjectNpub ?? authContext.signerNpub ?? authContext.npub;
    if (!actor) return Response.json({ error: "Authenticated actor required" }, { status: 403 });
    try {
      if (parts[6] === "reconcile" && ctx.queueDispatchInFlight.has(id))
        return Response.json({ error: "Delivery is still in flight; wait for its outcome before reconciliation" }, { status: 409 });
      if (parts[6] === "reconcile" && (typeof payload.claimToken !== "string" || typeof payload.resolution !== "string"))
        return Response.json({ error: "Exact claimToken and resolution accepted|retry required" }, { status: 400 });
      const prompt = parts[6] === "reconcile"
        ? ctx.promptQueueStore.reconcileClaim(id, parts[5]!, payload.revision, payload.claimToken as string, payload.resolution as string, actor, payload.reason)
        : ctx.promptQueueStore.acknowledgePrompt(id, parts[5]!, payload.revision, actor, payload.reason);
      return Response.json({ id, prompt, queue: {
        prompts: ctx.promptQueueStore.getSessionQueue(id),
        handled: ctx.promptQueueStore.getHandledPrompts(id), maxSize: 21,
      } });
    } catch (error) {
      if (error instanceof PromptQueueConflict) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

  if (method === "POST" && parts.length === 5) {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";

    if (!content) {
      return Response.json({ error: "Prompt content is required" }, { status: 400 });
    }

    try {
      const prompt = ctx.promptQueueStore.addPrompt(id, { content });
      if (!prompt) {
        return Response.json({ error: "Failed to add prompt to queue" }, { status: 400 });
      }
      if (ownedSession) {
        void ctx.maybeAutoDispatchQueuedPrompt(ownedSession);
      }
      return Response.json({ id, prompt });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (method === "PUT" && parts.length === 6) {
    const promptId = parts[5];
    if (!promptId) {
      return Response.json({ error: "Prompt ID required" }, { status: 400 });
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

    const record = payload as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";

    if (!content) {
      return Response.json({ error: "Prompt content is required" }, { status: 400 });
    }

    const updated = ctx.promptQueueStore.updatePromptContent(id, promptId, content);
    if (!updated) {
      return Response.json({ error: "Prompt not found or failed to update" }, { status: 404 });
    }

    return Response.json({ id, promptId, updated: true });
  }

  if (method === "DELETE" && parts.length === 6) {
    const promptId = parts[5];
    if (!promptId) {
      return Response.json({ error: "Prompt ID required" }, { status: 400 });
    }

    const deleted = ctx.promptQueueStore.deletePromptById(id, promptId);
    if (!deleted) {
      return Response.json({ error: "Prompt not found" }, { status: 404 });
    }

    return Response.json({ id, promptId, deleted: true });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
