import { fetchTowerRequest } from "./tower-transport-runtime";
import { signFlightDeckPgBotRequest } from "./tower-client";
import type { PipelineRouterRequest } from "./pipeline-router-handler";

export const learningActions = ["plan", "question", "lesson", "assessment", "recall"] as const;
export type LearningAction = typeof learningActions[number];

export function parseLearningPipelineCommand(body: string): { action: LearningAction; concept: string } | null {
  const match = body.match(/^\s*(?:@\[[^\]]+\]\(mention:agent:[^)]+\)|@Piper)\s+learning\s+(plan|question|lesson|assessment|recall)\s+([a-z][a-z0-9-]{1,63})\s*$/i);
  if (!match || match[2]!.includes("npub")) return null;
  return { action: match[1]!.toLowerCase() as LearningAction, concept: match[2]!.toLowerCase() };
}

export async function authorizeLearningPipelineRoute(request: PipelineRouterRequest): Promise<void> {
  const subscription = request.subscription;
  if (!subscription.workspaceId || !subscription.backendBaseUrl || !subscription.backendConnectionId) {
    throw new Error("An active Flight Deck Tower binding is required");
  }
  const url = new URL("/api/v4/learning/mastery", subscription.backendBaseUrl).toString();
  const authorization = await signFlightDeckPgBotRequest({
    backendConnectionId: subscription.backendConnectionId, subscriptionId: subscription.subscriptionId,
    botIdentity: request.botIdentity, url, method: "GET",
  });
  const response = await fetchTowerRequest(url, { method: "GET", headers: { Authorization: authorization, Accept: "application/json" } },
    { backendConnectionId: subscription.backendConnectionId, subscriptionId: subscription.subscriptionId });
  if (!response.ok) throw new Error(`Tower denied learner access (${response.status})`);
}
