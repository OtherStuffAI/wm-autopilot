import type { WorkspaceSubscriptionManager } from "../agent-chat/subscription-runtime";

export async function handleTowerTransportRoute(request: Request, url: URL, manager: WorkspaceSubscriptionManager,
  scope: { canManage: boolean; managerNpub: string }): Promise<Response | null> {
  if (url.pathname === "/api/agent-chat/backend-connections" && request.method === "POST") {
    if (!scope.canManage) return Response.json({ error: "Management permission required" }, { status: 403 });
    try {
      const input = await request.json();
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a Tower connection object");
      return Response.json({ backendConnection: manager.createTowerConnectionForManager(scope.managerNpub, input as Record<string, unknown>) }, { status: 201 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Tower connection creation failed" }, { status: 400 });
    }
  }
  const match = /^\/api\/agent-chat\/backend-connections\/([^/]+)\/transport(?:\/(test))?$/.exec(url.pathname);
  if (!match) return null;
  if (!scope.canManage) return Response.json({ error: "Management permission required" }, { status: 403 });
  if (request.method !== "POST" && request.method !== "PATCH") return Response.json({ error: "Method not allowed" }, { status: 405 });
  try {
    const id = decodeURIComponent(match[1]!);
    if (match[2]) return Response.json(await manager.testTowerTransportForManager(id, scope.managerNpub));
    const body = await request.json() as { transport?: unknown };
    const backendConnection = await manager.updateTowerTransportForManager(id, scope.managerNpub, body.transport);
    return Response.json({ backendConnection });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Tower transport operation failed" },
      { status: (error as { statusCode?: number }).statusCode ?? 400 });
  }
}
