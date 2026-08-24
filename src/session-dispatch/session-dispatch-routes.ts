import type { AgentType } from "../agent-types";
import type { SessionDispatchService } from "./session-dispatch-service";
import type { DispatchState } from "./session-dispatch-store";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export async function handleSessionDispatchApi(request: Request, url: URL, method: Method,
  service: SessionDispatchService): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/session-dispatches")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const callerSessionId = request.headers.get("x-wingman-session-id");
  const legacyReadSessionId = callerSessionId || url.searchParams.get("sessionId");
  try {
    if (parts.length === 2 && method === "POST") {
      const body = await request.json() as Record<string, unknown>;
      const callback = (body.callback ?? {}) as Record<string, unknown>;
      const enabled = callback.enabled !== false;
      const callbackSessionId = typeof callback.sessionId === "string" ? callback.sessionId : callerSessionId;
      const record = await service.create({ agent: body.agent as AgentType, directory: body.directory as string | undefined,
        name: body.name as string | undefined, prompt: String(body.prompt ?? ""), callbackEnabled: enabled,
        callbackSessionId: enabled ? callbackSessionId : null,
        reportingContext: body.reportingContext as Record<string, unknown> | undefined });
      return Response.json(record, { status: 201 });
    }
    if (parts.length === 2 && method === "GET") {
      return Response.json(service.list(legacyReadSessionId, { state: url.searchParams.get("state") as DispatchState | undefined }));
    }
    if (parts[2] === "inbox" && parts.length === 3 && method === "GET") {
      if (!callerSessionId) return Response.json({ error: "SESSION_ID is required" }, { status: 400 });
      return Response.json(service.getInbox(callerSessionId));
    }
    const id = parts[2];
    if (id && parts.length === 3 && method === "GET") return Response.json(service.get(id, legacyReadSessionId));
    if (id && parts.length === 4 && method === "POST") {
      if (!callerSessionId) return Response.json({ error: "SESSION_ID is required" }, { status: 400 });
      if (parts[3] === "acknowledge") return Response.json(service.acknowledge(id, callerSessionId));
      if (parts[3] === "close") return Response.json(service.close(id, callerSessionId));
      if (parts[3] === "retry-callback") return Response.json(await service.retryCallback(id, callerSessionId));
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const message = (error as Error).message;
    const status = /not found/i.test(message) ? 404 : /owner|Only the callback/i.test(message) ? 403 : 400;
    return Response.json({ error: message }, { status });
  }
}
