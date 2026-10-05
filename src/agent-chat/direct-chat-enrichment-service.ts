import { generateIdentityAlias } from "../identity/identity-alias.ts";
import { listLatestPipelineDefinitions, type PipelineDefinitionRecord } from "../pipelines/pipeline-loader.ts";
import { resolveChildDefinition } from "../pipelines/child-pipeline.ts";
import { startDeclarativePipeline } from "../pipelines/pipeline-runner.ts";
import { resolveClassifierOpenRouterApiKey } from "../pipelines/classifier-openrouter-credentials.ts";
import { searchGraphWithTransport } from "../pipelines/functions.ts";
import { readFlightDeckHistory } from "../flightdeck-pg/thread-history.ts";
import { prepareTowerRequestUrl, fetchTowerRequest } from "./tower-transport-runtime.ts";
import { signFlightDeckPgBotRequest } from "./tower-client.ts";
import { boundRouterContext } from "./pipeline-router-context.ts";
import { pipelineRecommendations, toolRecommendations } from "./context-recommendation-catalogue.ts";
import { createEnrichmentFunctions, ENRICHMENT_FUNCTION_NAMES, runOpenRouterDecisions } from "./direct-chat-enrichment-functions.ts";
import type { DirectChatEnrichmentConfig } from "./direct-chat-enrichment-config.ts";
import type { DirectChatRuntimeInput } from "./direct-chat-runtime.ts";
import type { AgentDefinitionRecord } from "./types.ts";
import type { PipelineStore, JsonObject } from "../pipelines/pipeline-store.ts";
import type { SessionApiContext } from "../server/session-api-routes.ts";

export interface DirectChatEnrichmentRequest {
  input: DirectChatRuntimeInput; agent: AgentDefinitionRecord; sourceMessageIds: string[];
  turnId: string; sessionId: string; config: DirectChatEnrichmentConfig; manifest: JsonObject[];
  signal: AbortSignal; onRunStarted: (id: string) => void;
}
export type EnrichDirectChat = (request: DirectChatEnrichmentRequest) => Promise<JsonObject>;

export function assertEnrichmentDefinition(definition: PipelineDefinitionRecord) {
  if (!definition.spec.tags?.includes("agent-direct-enrichment") || definition.spec.steps.some(step =>
    step.type !== "code" || !ENRICHMENT_FUNCTION_NAMES.includes(step.function))) {
    throw new Error("Enrichment pipelines may only use approved context functions; no agent, dispatch, publication or arbitrary code steps.");
  }
  const names = definition.spec.steps.map(s => s.type === "code" ? s.function : "");
  if (names.join("|") !== ENRICHMENT_FUNCTION_NAMES.join("|")) throw new Error("Enrichment pipeline must load conversation, judge needs, recall memory, find capabilities and return context in order.");
}

export function createDirectChatEnrichmentService(deps: {
  store: PipelineStore; getSessionApiContext: () => SessionApiContext; callbackOrigin: string;
  resolveDefinition?: typeof resolveChildDefinition;
  listDefinitions?: typeof listLatestPipelineDefinitions;
  readHistory?: typeof readFlightDeckHistory;
  decide?: typeof runOpenRouterDecisions;
  graph?: typeof searchGraphWithTransport;
}): EnrichDirectChat {
  return async request => {
    const { subscription, botIdentity } = request.input;
    if (!subscription.workspaceId || !subscription.workspaceOwnerNpub || !subscription.managedByNpub) throw new Error("Enrichment requires the exact workspace, workspace owner and pipeline owner.");
    if (botIdentity.botNpub !== request.agent.botNpub) throw new Error("Enrichment requires the addressed agent's stable broker-vault identity.");
    const ownerAlias = generateIdentityAlias(subscription.managedByNpub);
    const definition = await (deps.resolveDefinition ?? resolveChildDefinition)(request.config.pipeline, request.config.version, ownerAlias);
    request.signal.throwIfAborted();
    assertEnrichmentDefinition(definition);
    const ctx = deps.getSessionApiContext();
    const registry = createEnrichmentFunctions({ config: request.config, manifest: request.manifest, signal: request.signal,
      conversation: async () => {
        const history = await (deps.readHistory ?? readFlightDeckHistory)({ backendConnectionId: subscription.backendConnectionId,
          backendBaseUrl: subscription.backendBaseUrl, subscriptionId: subscription.subscriptionId, workspaceId: subscription.workspaceId!,
          channelId: request.input.channel.id, threadId: request.input.messages.find(m => request.sourceMessageIds.includes(m.id))?.effective_thread_id
            ?? request.input.messages.find(m => request.sourceMessageIds.includes(m.id))?.thread_id ?? "",
          appNpub: subscription.sourceAppNpub, botIdentity });
        const messages = request.sourceMessageIds.map(id => {
          const source = request.input.messages.find(m => m.id === id);
          const current = history.messages.find(m => m.id === id);
          if (!source || !current || source.body !== current.body) throw new Error(`Enrichment source ${id} changed or is missing.`);
          return source;
        });
        const last = messages.at(-1)!;
        const bound = boundRouterContext(history.messages, { agent: request.agent, subscription, botIdentity,
          channelId: request.input.channel.id, threadId: last.effective_thread_id ?? last.thread_id!, message: last });
        return { newMessages: messages.map(m => ({ id: m.id, body: m.body, senderNpub: m.sender_npub ?? m.created_by_actor_npub,
          createdAt: m.created_at, bodyTruncated: (m.body ?? "").length > 4000 })).map(m => ({ ...m, body: (m.body ?? "").slice(0, 4000) })), recentConversation: bound.messages,
          conversationSource: { tower: subscription.towerServiceNpub, workspaceId: subscription.workspaceId,
            channelId: request.input.channel.id, threadId: last.thread_id, loadedAt: new Date().toISOString() }, truncated: bound.truncated };
      },
      catalogue: async () => [
        ...(request.config.recommendPipelines ? pipelineRecommendations(await (deps.listDefinitions ?? listLatestPipelineDefinitions)(ownerAlias)) : []),
        ...await toolRecommendations(request.config.toolNames),
      ],
      decide: async (state, questions) => (deps.decide ?? runOpenRouterDecisions)({ state, questions,
        model: "~typesafe/jev-latest", timeoutMs: Math.min(request.config.timeoutMs, 8000), attempts: 1,
        apiKey: resolveClassifierOpenRouterApiKey({ ownerNpub: subscription.managedByNpub, sessionApiContext: ctx }) }),
      graph: async query => {
        const memory = request.config.memory;
        if (!memory) return { matches: [], warnings: [], searchedAt: new Date().toISOString() };
        const graph = await (deps.graph ?? searchGraphWithTransport)({ towerBaseUrl: subscription.backendBaseUrl,
          workspaceOwnerNpub: subscription.workspaceOwnerNpub, graphOwnerNpub: memory.ownerNpub,
          sourceAppNpub: memory.sourceAppNpub ?? subscription.sourceAppNpub, groupId: memory.groupId,
          source: memory.source, label: memory.label, actorNpub: memory.actorNpub, visibility: memory.visibility,
          entities: [{ name: query, type: "conversation", query }], maxMatches: 20 }, {
          signal: request.signal,
          sign: async url => {
            const actualUrl = await prepareTowerRequestUrl(url, subscription);
            return await signFlightDeckPgBotRequest({ ...subscription, botIdentity, url: actualUrl, method: "GET" });
          },
          fetch: (url, init) => fetchTowerRequest(String(url), init, subscription),
        });
        if (graph.graphMemoryAvailable === false) throw new Error(`Tower graph recall unavailable: ${(graph.warnings as string[]).join("; ")}`);
        for (const match of (graph.matches ?? []) as JsonObject[]) {
          if (match.workspaceOwnerNpub && match.workspaceOwnerNpub !== subscription.workspaceOwnerNpub) throw new Error("Tower graph returned a memory from the wrong workspace owner.");
          if (match.ownerNpub && match.ownerNpub !== memory.ownerNpub) throw new Error("Tower graph returned a memory from the wrong graph owner.");
        }
        return graph;
      },
    });
    return await new Promise<JsonObject>((resolve, reject) => {
      let runId: string | null = null;
      const abort = () => {
        if (runId) deps.store.cancelRun(runId, "Agent Direct enrichment timed out or lost its lease.");
        reject(new Error("Agent Direct enrichment timed out or lost its lease."));
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      try {
        startDeclarativePipeline({ store: deps.store, sessionApiContext: ctx, definition, registry,
          input: { turnId: request.turnId, workspaceId: subscription.workspaceId, sourceMessageIds: request.sourceMessageIds,
            sessionId: request.sessionId, config: request.config }, ownerNpub: subscription.managedByNpub, ownerAlias,
          callbackOrigin: deps.callbackOrigin, initiatingAgentProfileId: request.agent.agentId, initiatingAgentNpub: request.agent.botNpub,
          onRunCreated: run => { runId = run.id; request.onRunStarted(run.id); },
          onRunCompleted: run => {
            request.signal.removeEventListener("abort", abort);
            if (request.signal.aborted) return;
            if (run.status !== "ok" || !run.result?.enrichment) reject(new Error(run.error ?? "Enrichment pipeline returned no context result."));
            else resolve(run.result.enrichment as JsonObject);
          } });
      } catch (error) { request.signal.removeEventListener("abort", abort); reject(error); }
    });
  };
}
