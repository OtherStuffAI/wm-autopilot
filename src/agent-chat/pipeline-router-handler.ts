import { generateIdentityAlias } from '../identity/identity-alias';
import { runOpenRouterDecisions } from '../pipelines/openrouter-decisions';
import { listLatestPipelineDefinitions, type PipelineDefinitionRecord } from '../pipelines/pipeline-loader';
import { startFlightDeckPipelineRun } from '../pipelines/flightdeck-run-service';
import { resolveClassifierOpenRouterApiKey } from '../pipelines/classifier-openrouter-credentials';
import type { PipelineStore } from '../pipelines/pipeline-store';
import type { SessionApiContext } from '../server/session-api-routes';
import { createFlightDeckPgChannelMessage, type FlightDeckPgMessage } from './tower-client';
import type { AgentDefinitionRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';

export interface PipelineRouterRequest {
  agent: AgentDefinitionRecord; subscription: WorkspaceSubscriptionRecord; botIdentity: RuntimeBotIdentity;
  channelId: string; threadId: string; message: FlightDeckPgMessage;
}

export function createPipelineRouterHandler(deps: { store: PipelineStore; getSessionApiContext: () => SessionApiContext; callbackOrigin: string;
  listDefinitions?: typeof listLatestPipelineDefinitions; decide?: typeof runOpenRouterDecisions;
  startRun?: typeof startFlightDeckPipelineRun; publish?: typeof createFlightDeckPgChannelMessage }) {
  return async (request: PipelineRouterRequest): Promise<void> => {
    const sourceMessageId = request.message.id;
    if (!deps.store.claimFlightDeckRouterSource(sourceMessageId, request.agent.botNpub)) return;
    const publish = async (body: string, status: string, evidence: Record<string, unknown>, runId?: string) => {
      await (deps.publish ?? createFlightDeckPgChannelMessage)({ backendConnectionId: request.subscription.backendConnectionId,
        subscriptionId: request.subscription.subscriptionId, backendBaseUrl: request.subscription.backendBaseUrl,
        workspaceId: request.subscription.workspaceId!, appNpub: request.subscription.sourceAppNpub,
        botIdentity: request.botIdentity, channelId: request.channelId, threadId: request.threadId, body,
        clientRequestId: `pipeline-router:${sourceMessageId}:${status}`,
        metadata: { source: 'pipeline_router', source_message_id: sourceMessageId, run_id: runId ?? null } });
      deps.store.completeFlightDeckRouterDecision(sourceMessageId, { status, runId, evidence });
    };
    const ownerNpub = request.subscription.managedByNpub;
    if (!ownerNpub) return await publish('I could not route this request because the pipeline owner is unavailable.', 'error', { error: 'owner_unavailable' });
    try {
      const ownerAlias = generateIdentityAlias(ownerNpub);
      const definitions = (await (deps.listDefinitions ?? listLatestPipelineDefinitions)(ownerAlias)).filter((definition) => definition.spec.enabled !== false).filter(isChatAddressable);
      if (definitions.length === 0) return await publish('I could not find an enabled chat-addressable pipeline for this request.', 'no_match', { catalogue: [] });
      const criteria = Object.fromEntries([...definitions.map((definition) => [definition.id,
        `${definition.spec.name}: ${definition.spec.description || 'No description provided.'}`]), ['no_match', 'None of the available pipelines is suitable for this request.']]);
      const prompt = request.message.body ?? '';
      if (!prompt) throw new Error('The source message body is unavailable');
      const sessionApiContext = deps.getSessionApiContext();
      const decision = await (deps.decide ?? runOpenRouterDecisions)({ state: { sourceQuestion: prompt }, model: '~typesafe/jev-latest',
        questions: { pipeline: { type: 'choice', instructions: 'Choose the single best pipeline for the exact source question, or no_match.', criteria } },
        timeoutMs: 8000, attempts: 3, apiKey: resolveClassifierOpenRouterApiKey({ ownerNpub, sessionApiContext }) });
      const answer = (decision.answers as Record<string, Record<string, unknown>>).pipeline;
      const selectedId = String(answer?.choice ?? '');
      const evidence = { selectedId, probabilities: answer?.probabilities, confidence: answer?.confidence,
        model: decision.model, usage: decision.usage,
        cost: (decision.usage as Record<string, unknown> | undefined)?.cost ?? (decision.raw as Record<string, unknown> | undefined)?.cost ?? null,
        latencyMs: decision.latencyMs, sourceMessageId, sourceQuestion: prompt };
      if (selectedId === 'no_match') return await publish('I could not find a suitable pipeline for this request.', 'no_match', evidence);
      const selected = definitions.find((definition) => definition.id === selectedId);
      if (!selected) throw new Error('Jev selected a pipeline outside the eligible catalogue');
      const started = await (deps.startRun ?? startFlightDeckPipelineRun)({ store: deps.store, sessionApiContext,
        definition: selected, invocation: { workspaceId: request.subscription.workspaceId!, threadId: request.threadId,
          frmNpub: request.message.sender_npub ?? request.message.created_by_actor_npub ?? '', prompt }, ownerNpub, ownerAlias, callbackOrigin: deps.callbackOrigin,
        initiatingAgentNpub: request.agent.botNpub, sourceMessageId });
      const completeEvidence = { ...evidence, runId: started.run.id };
      deps.store.addEvent({ runId: started.run.id, level: 'info', type: 'pipeline_router_decision', message: 'Jev pipeline routing decision', data: completeEvidence });
      await publish(`I’ve started ${selected.spec.name} with your request. Its response will return here.`, 'started', completeEvidence, started.run.id);
    } catch (error) {
      await publish(`I could not start a pipeline for this request: ${error instanceof Error ? error.message : String(error)}`, 'error',
        { sourceMessageId, sourceQuestion: request.message.body ?? null, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function isChatAddressable(definition: PipelineDefinitionRecord): boolean {
  const first = definition.spec.steps[0];
  return Boolean(first?.type === 'block' && first.block === 'flightdeck.threadInvocation');
}
