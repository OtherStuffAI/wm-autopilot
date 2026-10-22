import type { WorkspaceSubscriptionManager } from "../agent-chat/subscription-runtime";
import { validateNStackSelection } from "../agent-chat/nstack-connect";

export async function handleNStackConnectRoute(request: Request, url: URL,
  manager: Pick<WorkspaceSubscriptionManager, "connectNStackForManager">,
  scope: { managerNpub: string; canManage: boolean }) {
  if (url.pathname !== "/api/agent-chat/nstack-connect" || request.method !== "POST") return null;
  if (!scope.canManage) return Response.json({ error: "Connection changes require an authorized Autopilot user." }, { status: 403 });
  try {
    const body = await request.json() as { workspaces?: unknown };
    const workspaces = validateNStackSelection(body.workspaces);
    return Response.json(await manager.connectNStackForManager(scope.managerNpub, workspaces));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "NStack setup failed." }, { status: 400 });
  }
}
