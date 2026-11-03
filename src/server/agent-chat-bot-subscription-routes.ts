import type { WorkspaceSubscriptionManager } from "../agent-chat/subscription-runtime";

type BotSubscriptionManager = Pick<WorkspaceSubscriptionManager, "listBotSubscriptionsForManager" | "readAgentInboxClassificationForManager">;

const CLASSIFICATION_PATH = /^\/api\/agent-chat\/subscriptions\/([^/]+)\/agent-inbox\/classification$/;

/**
 * Read-only operator routes for per-bot subscription status. Neither route changes inbox mode, classification,
 * audiences or connections; migration stays an explicit POST to `/agent-inbox`.
 */
export async function handleBotSubscriptionRoute(request: Request, url: URL, manager: BotSubscriptionManager,
  scope: { managerNpub: string }) {
  if (request.method !== "GET") return null;
  if (url.pathname === "/api/agent-chat/bot-subscriptions") {
    return Response.json({ rows: manager.listBotSubscriptionsForManager(scope.managerNpub) });
  }
  const match = url.pathname.match(CLASSIFICATION_PATH);
  if (!match) return null;
  const subscriptionId = decodeURIComponent(match[1]!);
  try {
    const result = await manager.readAgentInboxClassificationForManager(subscriptionId, scope.managerNpub);
    if (!result) return Response.json({ error: "Subscription not found" }, { status: 404 });
    return Response.json({ subscriptionId, classified: result.profile === "notification_only", ...result });
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    const code = (error as { code?: unknown })?.code;
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
      ...(typeof code === "string" ? { code } : {}),
    }, { status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 502 });
  }
}
