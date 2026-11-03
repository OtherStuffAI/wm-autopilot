import type { WorkspaceSubscriptionManager } from "../agent-chat/subscription-runtime";
import {
  learningGrantMappingStore, towerOriginOf, validLearnerNpub, validLearningGrantId, type LearningGrantMappingStore,
} from "../agent-chat/learning-grant-mappings";

type Manager = Pick<WorkspaceSubscriptionManager, "getAgentForManager" | "listForManager">;

const PATH = /^\/api\/agent-chat\/agents\/([^/]+)\/learning-grants$/;

/**
 * Manager-only routes for an agent's explicit Space learning grant (see learning-grant-mappings.ts):
 * - GET    → { mappings }
 * - PUT    { workspaceId, grantId, learnerNpub? } → the grant the agent names on that workspace's Tower
 * - DELETE { workspaceId } → back to Tower's implicit learner selection
 * The Tower origin always comes from the manager's own subscription for that workspace, never from the request.
 */
export async function handleLearningGrantRoute(request: Request, url: URL, manager: Manager, scope: { managerNpub: string },
  store: Pick<LearningGrantMappingStore, "listForAgent" | "save" | "remove"> = learningGrantMappingStore()): Promise<Response | null> {
  const match = url.pathname.match(PATH);
  if (!match || !["GET", "PUT", "DELETE"].includes(request.method)) return null;
  const agent = manager.getAgentForManager(decodeURIComponent(match[1]!), scope.managerNpub);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  if (request.method === "GET") return Response.json({ mappings: store.listForAgent(agent.agentId) });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId) return Response.json({ error: "workspaceId is required" }, { status: 400 });
  const subscriptions = manager.listForManager(scope.managerNpub).filter((record) => record.workspaceId === workspaceId && towerOriginOf(record.backendBaseUrl));
  const own = subscriptions.filter((record) => record.agentProfileId === agent.agentId || record.botNpub === agent.botNpub);
  const origins = [...new Set((own.length ? own : subscriptions).map((record) => towerOriginOf(record.backendBaseUrl)!))];
  if (origins.length !== 1) {
    return Response.json({ error: origins.length ? "The workspace is served by more than one Tower for this agent" : "No subscription for this workspace" },
      { status: origins.length ? 409 : 404 });
  }
  const towerOrigin = origins[0]!;
  if (request.method === "DELETE") return Response.json({ removed: store.remove(agent.agentId, towerOrigin), towerOrigin });

  if (!validLearningGrantId(body?.grantId)) return Response.json({ error: "grantId must be a learning delegation UUID" }, { status: 400 });
  if (body?.learnerNpub !== undefined && body.learnerNpub !== null && !validLearnerNpub(body.learnerNpub)) {
    return Response.json({ error: "learnerNpub must be a valid npub" }, { status: 400 });
  }
  const mapping = store.save({ agentId: agent.agentId, botNpub: agent.botNpub, towerOrigin, workspaceId, grantId: String(body!.grantId).trim(),
    learnerNpub: typeof body?.learnerNpub === "string" ? body.learnerNpub.trim() : null, managedByNpub: scope.managerNpub });
  return Response.json({ mapping });
}
