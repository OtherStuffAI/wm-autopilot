import { randomBytes } from "node:crypto";
import { finalizeEvent } from "nostr-tools";
import { prepareTowerRequestUrl } from "./tower-transport-runtime";
import { fetchPgRequest, signFlightDeckPgBotRequest, type FlightDeckPgBotIdentity } from "./tower-client";
import { learningGrantMappingStore, towerOriginOf, type LearningGrantMappingStore } from "./learning-grant-mappings";
import type { PipelineRouterRequest } from "./pipeline-router-handler";

export const learningActions = ["plan", "question", "lesson", "assessment", "recall"] as const;
export type LearningAction = typeof learningActions[number];

export function parseLearningPipelineCommand(body: string): { action: LearningAction; concept: string } | null {
  const match = body.match(/^\s*(?:@\[[^\]]+\]\(mention:agent:[^)]+\)|@Piper)\s+learning\s+(plan|question|lesson|assessment|recall)\s+([a-z][a-z0-9-]{1,63})\s*$/i);
  if (!match || match[2]!.includes("npub")) return null;
  return { action: match[1]!.toLowerCase() as LearningAction, concept: match[2]!.toLowerCase() };
}

/**
 * NIP-98 for a learning request that names its explicit delegation: the `learning_grant_id` tag is part of the signed
 * event (the `x-learning-grant-id` header alone is not), so Tower can bind the learner choice to the signer.
 */
export async function signLearningNip98(identity: FlightDeckPgBotIdentity, url: string, method: string, grantId: string,
  context: { backendConnectionId?: string | null; subscriptionId?: string | null }): Promise<string> {
  const actualUrl = identity.towerTransport ? (await identity.towerTransport.prepare(url)).toString() : await prepareTowerRequestUrl(url, context);
  const tags = [["u", actualUrl], ["method", method], ["nonce", randomBytes(16).toString("hex")], ["learning_grant_id", grantId]];
  const template = { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags };
  const event = "botSecret" in identity ? finalizeEvent(template, identity.botSecret) : await identity.signNostrEvent(template);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

/**
 * Router precheck for learning commands. With an operator-set grant for this agent on this Tower, the request names
 * it explicitly (header + signed tag) and the grant id is returned for the run's trusted context; without one, the
 * existing implicit learner selection is used unchanged.
 */
export async function authorizeLearningPipelineRoute(request: PipelineRouterRequest,
  grants: Pick<LearningGrantMappingStore, "forBot"> = learningGrantMappingStore()): Promise<{ grantId: string | null }> {
  const subscription = request.subscription;
  if (!subscription.workspaceId || !subscription.backendBaseUrl || !subscription.backendConnectionId) {
    throw new Error("An active Flight Deck Tower binding is required");
  }
  const url = new URL("/api/v4/learning/mastery", subscription.backendBaseUrl).toString();
  const grant = grants.forBot(request.agent.botNpub, towerOriginOf(subscription.backendBaseUrl));
  const context = { backendConnectionId: subscription.backendConnectionId, subscriptionId: subscription.subscriptionId };
  const authorization = grant
    ? await signLearningNip98(request.botIdentity, url, "GET", grant.grantId, context)
    : await signFlightDeckPgBotRequest({ ...context, botIdentity: request.botIdentity, url, method: "GET" });
  const response = await fetchPgRequest({ ...context, botIdentity: request.botIdentity }, url, { method: "GET", headers: {
    Authorization: authorization, Accept: "application/json", ...(grant ? { "x-learning-grant-id": grant.grantId } : {}) } });
  if (!response.ok) throw new Error(`Tower denied learner access (${response.status})`);
  return { grantId: grant?.grantId ?? null };
}
