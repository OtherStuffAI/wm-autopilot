import { generateIdentityAlias } from '../identity/identity-alias';
import { runOpenRouterDecisions } from '../pipelines/openrouter-decisions';
import { listLatestPipelineDefinitions, type PipelineDefinitionRecord } from '../pipelines/pipeline-loader';
import { startFlightDeckPipelineRun } from '../pipelines/flightdeck-run-service';
import { resolveClassifierOpenRouterApiKey } from '../pipelines/classifier-openrouter-credentials';
import type { PipelineStore } from '../pipelines/pipeline-store';
import type { SessionApiContext } from '../server/session-api-routes';
import { createFlightDeckPgChannelMessage, type FlightDeckPgMessage } from './tower-client';
import { flightDeckDispatchOutcomeStore, type FlightDeckDispatchOutcomeStore } from './flightdeck-dispatch-outcome-store';
import type { AgentDefinitionRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';
import { authorizeLearningPipelineRoute, parseLearningPipelineCommand } from './learning-pipeline-route';

export interface PipelineRouterRequest {
  agent: AgentDefinitionRecord; subscription: WorkspaceSubscriptionRecord; botIdentity: RuntimeBotIdentity;
  channelId: string; threadId: string; message: FlightDeckPgMessage;
  sourceLabel?: string | null;
}

export function createPipelineRouterHandler(deps: { store: PipelineStore; getSessionApiContext: () => SessionApiContext; callbackOrigin: string;
  listDefinitions?: typeof listLatestPipelineDefinitions; decide?: typeof runOpenRouterDecisions;
  startRun?: typeof startFlightDeckPipelineRun; publish?: typeof createFlightDeckPgChannelMessage;
  authorizeLearning?: typeof authorizeLearningPipelineRoute;
  dispatchOutcomeStore?: FlightDeckDispatchOutcomeStore }) {
  return async (request: PipelineRouterRequest): Promise<void> => {
    const sourceMessageId = request.message.id;
    if (!deps.store.claimFlightDeckRouterSource(sourceMessageId, request.agent.botNpub)) return;
    const outcomes = deps.dispatchOutcomeStore ?? flightDeckDispatchOutcomeStore;
    const outcomeBase = { subscriptionId: request.subscription.subscriptionId, recordId: sourceMessageId,
      agentId: request.agent.agentId, receivedAt: request.message.created_at ?? undefined, sourceLabel: request.sourceLabel,
      details: { channel_id: request.channelId, thread_id: request.threadId, agent_npub: request.agent.botNpub } };
    const publish = async (body: string, status: string, evidence: Record<string, unknown>, runId?: string) => {
      await (deps.publish ?? createFlightDeckPgChannelMessage)({ backendConnectionId: request.subscription.backendConnectionId,
        subscriptionId: request.subscription.subscriptionId, backendBaseUrl: request.subscription.backendBaseUrl,
        workspaceId: request.subscription.workspaceId!, appNpub: request.subscription.sourceAppNpub,
        botIdentity: request.botIdentity, channelId: request.channelId, threadId: request.threadId, body,
        clientRequestId: `pipeline-router:${sourceMessageId}:${status}`,
        metadata: { source: 'pipeline_router', source_message_id: sourceMessageId, run_id: runId ?? null } });
      deps.store.completeFlightDeckRouterDecision(sourceMessageId, { status, runId, evidence });
    };
    if (request.botIdentity.botNpub !== request.agent.botNpub) {
      throw new Error(`Pipeline router identity ${request.botIdentity.botNpub} does not match addressed agent ${request.agent.botNpub}`);
    }
    const ownerNpub = request.subscription.managedByNpub;
    if (!ownerNpub) {
      const evidence = { error: 'owner_unavailable' };
      outcomes.recordPipelineFailure({ ...outcomeBase, status: 'error', details: { ...outcomeBase.details, ...evidence } });
      return await publish('I could not route this request because the pipeline owner is unavailable.', 'error', evidence);
    }
    let runStarted = false;
    try {
      const ownerAlias = generateIdentityAlias(ownerNpub);
      const definitions = (await (deps.listDefinitions ?? listLatestPipelineDefinitions)(ownerAlias)).filter((definition) => definition.spec.enabled !== false).filter(isChatAddressable);
      const prompt = request.message.body ?? '';
      if (!prompt) throw new Error('The source message body is unavailable');
      if (/\blearning\b/i.test(prompt)) {
        const command = parseLearningPipelineCommand(prompt);
        if (!command) {
          return await publish('Use learning <plan|question|lesson|assessment|recall> <concept-id>. Do not include answers in the chat command.',
            'no_match', { reason: 'invalid_learning_command' });
        }
        const selected = definitions.find((definition) => definition.spec.name === `learning-${command.action}`);
        if (!selected) return await publish('The requested learning pipeline is unavailable.', 'no_match', { reason: 'learning_pipeline_unavailable' });
        await (deps.authorizeLearning ?? authorizeLearningPipelineRoute)(request);
        const sessionApiContext = deps.getSessionApiContext();
        const started = await (deps.startRun ?? startFlightDeckPipelineRun)({ store: deps.store, sessionApiContext,
          definition: selected, invocation: { workspaceId: request.subscription.workspaceId!, threadId: request.threadId,
            frmNpub: request.message.sender_npub ?? request.message.created_by_actor_npub ?? '', prompt },
          trustedLearningContext: { towerUrl: request.subscription.backendBaseUrl, workspaceId: request.subscription.workspaceId!,
            goal: command.concept, concept: command.concept, idempotencyKey: `flightdeck:${sourceMessageId}` },
          ownerNpub, ownerAlias, callbackOrigin: deps.callbackOrigin,
          initiatingAgentProfileId: request.agent.agentId, initiatingAgentNpub: request.agent.botNpub, sourceMessageId,
          onRunCreated: (run) => outcomes.recordPipelineStarted({ ...outcomeBase, runId: run.id, status: run.status,
            details: { ...outcomeBase.details, run_id: run.id, pipeline_name: run.name, status: run.status } }),
          onRunCompleted: (run) => outcomes.recordPipelineCompleted({ ...outcomeBase, runId: run.id, status: run.status,
            details: { ...outcomeBase.details, run_id: run.id, pipeline_name: run.name, status: run.status,
              completed_at: run.completedAt, error: run.error } }) });
        runStarted = true;
        return await publish(`I started ${selected.spec.name}. Run: ${started.run.id}. Use the private learning CLI to inspect results.`,
          'started', { action: command.action, concept: command.concept, runId: started.run.id }, started.run.id);
      }
      const ordinaryDefinitions = definitions.filter((definition) => !/^learning-(plan|question|lesson|assessment|recall)$/.test(definition.spec.name));
      if (ordinaryDefinitions.length === 0) {
        const evidence = { catalogue: [] };
        outcomes.recordPipelineNoMatch({ ...outcomeBase, status: 'no_match', details: { ...outcomeBase.details, ...evidence } });
        return await publish('I could not find an enabled chat-addressable pipeline for this request.', 'no_match', evidence);
      }
      const criteria = Object.fromEntries([...ordinaryDefinitions.map((definition) => [definition.id,
        `${definition.spec.name}: ${definition.spec.description || 'No description provided.'}`]), ['no_match', 'None of the available pipelines is suitable for this request.']]);
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
      if (selectedId === 'no_match') {
        outcomes.recordPipelineNoMatch({ ...outcomeBase, status: 'no_match', details: { ...outcomeBase.details, ...evidence } });
        return await publish('I could not find a suitable pipeline for this request.', 'no_match', evidence);
      }
      const selected = ordinaryDefinitions.find((definition) => definition.id === selectedId);
      if (!selected) throw new Error('Jev selected a pipeline outside the eligible catalogue');
      const started = await (deps.startRun ?? startFlightDeckPipelineRun)({ store: deps.store, sessionApiContext,
        definition: selected, invocation: { workspaceId: request.subscription.workspaceId!, threadId: request.threadId,
          frmNpub: request.message.sender_npub ?? request.message.created_by_actor_npub ?? '', prompt }, ownerNpub, ownerAlias, callbackOrigin: deps.callbackOrigin,
        initiatingAgentProfileId: request.agent.agentId, initiatingAgentNpub: request.agent.botNpub, sourceMessageId,
        onRunCreated: (run) => outcomes.recordPipelineStarted({ ...outcomeBase, runId: run.id, status: run.status,
          details: { ...outcomeBase.details, run_id: run.id, pipeline_name: run.name, status: run.status } }),
        onRunCompleted: (run) => outcomes.recordPipelineCompleted({ ...outcomeBase, runId: run.id, status: run.status,
          details: { ...outcomeBase.details, run_id: run.id, pipeline_name: run.name, status: run.status,
            completed_at: run.completedAt, error: run.error } }) });
      const completeEvidence = { ...evidence, runId: started.run.id };
      runStarted = true;
      deps.store.addEvent({ runId: started.run.id, level: 'info', type: 'pipeline_router_decision', message: 'Jev pipeline routing decision', data: completeEvidence });
      await publish(`I’ve started ${selected.spec.name} with your request. Its response will return here.`, 'started', completeEvidence, started.run.id);
    } catch (error) {
      if (runStarted) throw error;
      outcomes.recordPipelineFailure({ ...outcomeBase, status: 'error', details: { ...outcomeBase.details,
        error: error instanceof Error ? error.message : String(error) } });
      const learningRequest = /\blearning\b/i.test(request.message.body ?? '');
      await publish(learningRequest ? 'I could not start the learning pipeline. Check the learner grant and Tower connection.'
        : `I could not start a pipeline for this request: ${error instanceof Error ? error.message : String(error)}`, 'error',
        learningRequest ? { sourceMessageId, reason: 'learning_route_denied' }
          : { sourceMessageId, sourceQuestion: request.message.body ?? null, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function isChatAddressable(definition: PipelineDefinitionRecord): boolean {
  const first = definition.spec.steps[0];
  return Boolean(first?.type === 'block' && first.block === 'flightdeck.threadInvocation');
}
