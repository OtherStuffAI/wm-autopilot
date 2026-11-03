import type { WorkspaceSubscriptionManager } from "../agent-chat/subscription-runtime";
import { validateNStackAddress } from "../agent-chat/nstack-discovery";
import { validateNStackSelection } from "../agent-chat/nstack-connect";

export async function handleNStackConnectRoute(request: Request, url: URL,
  manager: Pick<WorkspaceSubscriptionManager, "connectNStackForManager" | "discoverNStackForManager">,
  scope: { managerNpub: string; canManage: boolean }) {
  if (!["/api/agent-chat/nstack-connect", "/api/agent-chat/nstack-connect/discover"].includes(url.pathname) || request.method !== "POST") return null;
  if (!scope.canManage) return Response.json({ error: "Connection changes require an authorized Autopilot user." }, { status: 403 });
  try {
    const body = await request.json() as { workspaces?: unknown; address?: unknown; agentProfileId?: unknown };
    if (url.pathname.endsWith("/discover")) {
      const address = validateNStackAddress(body.address);
      return Response.json(await manager.discoverNStackForManager(scope.managerNpub, address));
    }
    const workspaces = validateNStackSelection(body.workspaces);
    const agentProfileId = typeof body.agentProfileId === "string" && body.agentProfileId.trim() ? body.agentProfileId.trim() : null;
    return Response.json(await manager.connectNStackForManager(scope.managerNpub, workspaces, agentProfileId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "NStack setup failed." }, { status: 400 });
  }
}
