import { ACCEPTED_TURN_INTERRUPTED, prepareFreshHumanSession, FreshHumanIntakeCoordinator, afterFreshHumanBoundary, assertCurrentHumanTurn } from "./fresh-human-session";
import { buildAcceptedDirectChatRecoveryPrompt } from "./direct-chat-recovery-prompt";
import { DirectChatRequestQueue } from "./direct-chat-request-queue.ts";
import { randomUUID } from "node:crypto";
import { DirectChatEnrichmentCoordinator, supplementalContext } from "./direct-chat-enrichment-coordinator.ts";
import { DirectChatEnrichmentStore } from "./direct-chat-enrichment-store.ts";
import type { EnrichDirectChat } from "./direct-chat-enrichment-service.ts";
import { DIRECT_CHAT_SUBMISSION_LEASE_MS } from './direct-chat-response';
import type { AgentType } from '../config';
import { isAgentType } from '../agent-types';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { normalizeAgentModelOverride } from '../agents/process-manager';
import type { ArchivedSession } from '../storage/session-archive-store';
import { resolveNativeResumeLaunch } from '../sessions/native-resume-launch';
import type { AgentDefinitionStore } from './agent-definition-store';
import type { ChatInterceptStateStore } from './chat-intercept-state-store';
import {
  buildDirectChatBootstrapPrompt,
  buildDirectChatClientRequestId,
  buildDirectChatFollowUpPrompt,
  buildDirectChatRoutingKey,
  buildDirectChatTurnId,
  channelDirectChatConfig,
  channelLegacyBasePrompt,
  hasCanonicalNpubMention,
  isAgentDirectMessageEligible,
  isImplicitTwoPartyDirectMessage,
  orderDirectChatMessages,
  selectUndeliveredActionableMessages,
} from './direct-chat-contract';
import { getDirectChatTurnStore, type DirectChatTurnStore } from './direct-chat-turn-store';
import { freezeOrResumeDirectChatReply } from './direct-chat-publication-observation';
import { AgentActivityPublisher, type AgentActivityContext } from './agent-activity-publisher';
import { AgentDirectLifecycleController } from './agent-direct-lifecycle-controller';
import { awaitAcceptedFinalResponse, PromptBoundaryNotObservedError, sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';
import { createFlightDeckPgChannelMessage, type FlightDeckPgChannel, type FlightDeckPgEvent, type FlightDeckPgMessage } from './tower-client';
import type { AgentDefinitionRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';
import type { AgentDirectDeliveryReconciler } from './direct-chat-delivery-reconciler';
import {
  flightDeckDispatchOutcomeStore,
  type FlightDeckDispatchOutcomeStore,
} from './flightdeck-dispatch-outcome-store';
import { isSessionWaitTimeout } from './flightdeck-dispatch-lifecycle';
import { sourceLabelForFlightDeckChat } from './flightdeck-dispatch-metadata';
import type { DuplicateCallbackPublicationFilter } from './duplicate-callback-publication-filter';
import { BROKER_KEY_NOT_PROVISIONED } from '../signing/broker-key-vault';
import { directChatSessionReplacementDecision } from './direct-chat-session-recovery';
import { isInterruptedTurnError } from './session-runtime-turns';
import { assertDirectChatWorkspaceCompatible, buildDirectChatSessionBinding } from './direct-chat-session-binding';
import type { PipelineRouterRequest } from './pipeline-router-handler';

export interface DirectChatRuntimeInput {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  event: FlightDeckPgEvent;
  channel: FlightDeckPgChannel;
  messages: FlightDeckPgMessage[];
  audienceAgentNpubs?: string[];
  instructionAuthorization: {
    verified: boolean;
    authorNpub: string | null;
    reason: string;
  };
}

interface DirectChatRuntimeDependencies {
  defaultAgent: AgentType;
  processManager: ProcessManager;
  agentStore: AgentDefinitionStore;
  interceptStore: ChatInterceptStateStore;
  turnStore?: DirectChatTurnStore;
  publish?: typeof createFlightDeckPgChannelMessage;
  createActivityPublisher?: (context: AgentActivityContext) => AgentActivityPublisher;
  createLifecycleController?: (context: AgentActivityContext, publisher: AgentActivityPublisher) => AgentDirectLifecycleController;
  getArchivedSession?: (sessionId: string) => ArchivedSession | null;
  retireSessionWork?: (sessionId: string, triggerId: string, routingKey: string) => string[] | void;
  rebindSession?: (sourceSessionId: string, targetSessionId: string) => void;
  log?: Pick<Console, 'error' | 'warn'>;
  deliveryReconciler?: AgentDirectDeliveryReconciler;
  sendFinalResponse?: typeof sendPromptAndAwaitFinalResponse;
  dispatchOutcomeStore?: FlightDeckDispatchOutcomeStore;
  publicationFilter?: DuplicateCallbackPublicationFilter;
  withBotIdentity?: <T>(
    agent: AgentDefinitionRecord,
    operation: (identity: RuntimeBotIdentity) => Promise<T>,
  ) => Promise<T>;
  enrichDirectChat?: EnrichDirectChat;
  enrichmentStore?: DirectChatEnrichmentStore;
  routePipeline?: (input: PipelineRouterRequest) => Promise<void>;
}

interface MessageRevisionDispatch {
  revision: number;
  newlyAddedMentionNpubs: Set<string>;
}

function messageRevisionDispatch(event: FlightDeckPgEvent): MessageRevisionDispatch | null {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  if (event.event_type !== 'flightdeck_pg.message.revised' && payload.event_type !== 'message.revised') return null;
  const revision = Number(payload.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const messageId = typeof event.entity_id === 'string' ? event.entity_id : null;
  const revisionKey = typeof payload.revision_idempotency_key === 'string' ? payload.revision_idempotency_key : null;
  if (!messageId
    || payload.message_id !== messageId
    || (event.entity_row_version != null && event.entity_row_version !== revision)
    || revisionKey !== `message:${messageId}:revision:${revision}`) return null;
  const mentions = Array.isArray(payload.newly_added_mentions) ? payload.newly_added_mentions : [];
  return {
    revision,
    newlyAddedMentionNpubs: new Set(mentions.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const mention = entry as Record<string, unknown>;
      return typeof mention.npub === 'string' ? [mention.npub] : [];
    })),
  };
}

function withMvpDirectChatDefault(agent: AgentDefinitionRecord): AgentDefinitionRecord {
  if (agent.directChat) return agent;
  return {
    ...agent,
    directChat: {
      enabled: true,
      sessionAgent: null,
      directory: agent.workingDirectory,
      model: null,
      idleRetentionMinutes: 60,
    },
  };
}

export class AgentDirectChatRuntime {
  private readonly running = new Map<string, Promise<void>>();
  private readonly freshIntake = new FreshHumanIntakeCoordinator();
  private readonly queued = new DirectChatRequestQueue();
  private readonly deliveryWaiters = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly submissionOwner = randomUUID();
  private readonly enrichment: DirectChatEnrichmentCoordinator;
  private readonly turnStore: DirectChatTurnStore;
  private readonly publish: typeof createFlightDeckPgChannelMessage;
  private readonly createActivityPublisher: (context: AgentActivityContext) => AgentActivityPublisher;
  private readonly createLifecycleController: (context: AgentActivityContext, publisher: AgentActivityPublisher) => AgentDirectLifecycleController;
  private readonly log: Pick<Console, 'error' | 'warn'>;
  private readonly sendFinalResponse: typeof sendPromptAndAwaitFinalResponse;
  private readonly dispatchOutcomeStore: FlightDeckDispatchOutcomeStore;

  constructor(private readonly deps: DirectChatRuntimeDependencies) {
    this.turnStore = deps.turnStore ?? getDirectChatTurnStore();
    this.enrichment = new DirectChatEnrichmentCoordinator(deps.enrichmentStore ?? new DirectChatEnrichmentStore(this.turnStore.filePath), deps.enrichDirectChat);
    this.publish = deps.publish ?? createFlightDeckPgChannelMessage;
    this.createActivityPublisher = deps.createActivityPublisher ?? ((context) => new AgentActivityPublisher(context));
    this.createLifecycleController = deps.createLifecycleController ?? ((context, publisher) => new AgentDirectLifecycleController(context, deps.processManager, publisher));
    this.log = deps.log ?? console;
    this.sendFinalResponse = deps.sendFinalResponse ?? sendPromptAndAwaitFinalResponse;
    this.dispatchOutcomeStore = deps.dispatchOutcomeStore ?? flightDeckDispatchOutcomeStore;
  }

  async handle(input: DirectChatRuntimeInput): Promise<{ handled: boolean; reason: string }> {
    const config = channelDirectChatConfig(input.channel);
    const ordered = orderDirectChatMessages(input.messages);
    const eventMessage = input.event.entity_type === 'thread'
      ? null
      : ordered.find((message) => message.messageId === input.event.entity_id) ?? null;
    const implicitDm = Boolean(eventMessage && isImplicitTwoPartyDirectMessage(
      input.channel,
      input.subscription.botNpub,
      eventMessage.userNpub,
    ));
    if (!config.enabled && !implicitDm) return { handled: false, reason: 'channel_disabled' };
    const contextPrompt = config.contextPrompt || (implicitDm ? channelLegacyBasePrompt(input.channel) : '');
    const revisionDispatch = messageRevisionDispatch(input.event);
    const isRevisionEvent = input.event.event_type === 'flightdeck_pg.message.revised'
      || input.event.payload?.event_type === 'message.revised';
    if (isRevisionEvent && !revisionDispatch) {
      return { handled: false, reason: 'invalid_message_revision_event' };
    }
    if (revisionDispatch?.newlyAddedMentionNpubs.size === 0) {
      return { handled: false, reason: 'no_new_agent_mentions' };
    }
    const workspaceIdentity = input.subscription.workspaceServiceNpub?.trim() || input.subscription.workspaceOwnerNpub;
    const audienceAgentNpubs = new Set(input.audienceAgentNpubs ?? []);
    const configuredAgents = audienceAgentNpubs.size > 0 && input.subscription.managedByNpub
      ? this.deps.agentStore.listForManagerNpub(input.subscription.managedByNpub)
      : this.deps.agentStore.listByWorkspaceAndBot(workspaceIdentity, input.subscription.botNpub);
    const agents = configuredAgents
      .filter((agent) => !input.subscription.agentProfileId || agent.agentId === input.subscription.agentProfileId)
      .filter((agent) => audienceAgentNpubs.size === 0 || audienceAgentNpubs.has(agent.botNpub))
      .filter((agent) => agent.enabled && agent.capabilities.includes('chat_intercept'))
      .map(withMvpDirectChatDefault)
      .filter((agent) => agent.directChat?.enabled);
    if (agents.length === 0) return { handled: false, reason: 'no_direct_chat_agent' };
    let handled = false;
    for (const agent of agents) {
      if (!eventMessage) continue;
      const explicitlyMentioned = hasCanonicalNpubMention(eventMessage, agent.botNpub);
      const authoredByAgent = eventMessage.userNpub === agent.botNpub
        || eventMessage.userNpub === input.subscription.wsKeyNpub;
      if (authoredByAgent && !explicitlyMentioned) continue;
      if (revisionDispatch
        ? !revisionDispatch.newlyAddedMentionNpubs.has(agent.botNpub)
        : !isAgentDirectMessageEligible(input.channel, eventMessage, agent.botNpub)) continue;
      if (!input.instructionAuthorization.verified
        || input.instructionAuthorization.authorNpub !== eventMessage.userNpub) {
        this.recordAuthorizationSuppression(input, agent, eventMessage.messageId,
          input.instructionAuthorization.reason || 'invalid_instruction_signature');
        continue;
      }
      if (!this.deps.agentStore.canInstruct(agent.agentId, input.instructionAuthorization.authorNpub)) {
        this.recordAuthorizationSuppression(input, agent, eventMessage.messageId, 'instructor_not_allowed');
        continue;
      }
      const threadId = input.messages.find((message) => message.id === eventMessage.messageId)?.thread_id
        ?? input.messages.find((message) => message.id === eventMessage.messageId)?.thread_source_message_id
        ?? eventMessage.messageId;
      const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: input.subscription.towerServiceNpub || input.subscription.backendBaseUrl,
        workspaceId: input.subscription.workspaceId || workspaceIdentity, channelId: input.channel.id, threadId, agentNpub: agent.botNpub });
      const cursor = input.event.cursor ?? (input.event.row_version != null ? String(input.event.row_version) : null);
      const beforeIntake = this.deps.interceptStore.getByRoutingKey(routingKey);
      const upsert = this.deps.interceptStore.upsertMessage({
        routingKey, subscriptionId: input.subscription.subscriptionId, agentId: agent.agentId,
        workspaceOwnerNpub: workspaceIdentity, sourceAppNpub: input.subscription.sourceAppNpub,
        towerServiceNpub: input.subscription.towerServiceNpub ?? '', workspaceId: input.subscription.workspaceId ?? '',
        channelId: input.channel.id, threadId, botNpub: agent.botNpub, messageId: eventMessage.messageId,
        messageRevision: revisionDispatch?.revision ?? null, eventCursor: cursor,
      });
      if (!upsert.wasDuplicate && !authoredByAgent && agent.directChat?.handlerMode !== 'pipeline_router') {
        await this.freshIntake.prepare({ manager: this.deps.processManager, interceptStore: this.deps.interceptStore,
          turnStore: this.turnStore, retireSessionWork: this.deps.retireSessionWork }, beforeIntake?.lastDecision === 'failed' ? { ...upsert.record, lastDecision: 'failed' } : upsert.record, eventMessage.messageId);
      }
      if (upsert.wasDuplicate && !this.turnStore.getPending(routingKey)) continue;
      handled = true;
      if (agent.directChat?.handlerMode === 'pipeline_router') {
        if (!upsert.wasDuplicate && this.deps.routePipeline) {
          const route = (botIdentity: RuntimeBotIdentity) => this.deps.routePipeline!({ agent, subscription: input.subscription,
            botIdentity, channelId: input.channel.id, threadId,
            sourceLabel: sourceLabelForFlightDeckChat({ event: input.event,
              message: input.messages.find((message) => message.id === eventMessage.messageId), messages: input.messages }),
            message: input.messages.find((message) => message.id === eventMessage.messageId)! });
          if (this.deps.withBotIdentity) await this.deps.withBotIdentity(agent, route);
          else await route(input.botIdentity);
        }
        continue;
      }
      if (!upsert.wasDuplicate) {
        this.dispatchOutcomeStore.recordSessionQueued({
          subscriptionId: input.subscription.subscriptionId,
          recordId: eventMessage.messageId,
          agentId: agent.agentId,
          receivedAt: eventMessage.createdAt || undefined,
          sourceLabel: sourceLabelForFlightDeckChat({
            event: input.event,
            message: input.messages.find((message) => message.id === eventMessage.messageId),
            messages: input.messages,
          }),
          details: {
            routing_key: routingKey,
            channel_id: input.channel.id,
            thread_id: threadId,
            agent_npub: agent.botNpub,
          },
        });
        const blockingTurn = this.turnStore.getPending(routingKey);
        if (blockingTurn && blockingTurn.turnId !== buildDirectChatTurnId(routingKey, [eventMessage.messageId])) {
          const queuedTurnId = buildDirectChatTurnId(routingKey, [eventMessage.messageId]);
          const queuedContext: AgentActivityContext = {
            backendConnectionId: input.subscription.backendConnectionId,
            subscriptionId: input.subscription.subscriptionId,
            backendBaseUrl: input.subscription.backendBaseUrl,
            workspaceId: input.subscription.workspaceId!,
            appNpub: input.subscription.sourceAppNpub,
            botIdentity: input.botIdentity,
            channelId: input.channel.id,
            threadId,
            triggerMessageId: eventMessage.messageId,
            sessionId: `pending:${queuedTurnId}`,
            agentNpub: agent.botNpub,
            turnId: queuedTurnId,
            startedAt: eventMessage.createdAt || new Date().toISOString(),
          };
          const queuedLifecycle = new AgentDirectLifecycleController(queuedContext, this.deps.processManager,
            this.createActivityPublisher(queuedContext));
          await queuedLifecycle.queued(blockingTurn.turnId, Math.max(1, upsert.record.pendingMessageCount));
        }
      }
      this.enqueue(routingKey, agent, contextPrompt, input);
    }
    return { handled, reason: handled ? 'direct_chat_queued' : 'not_activated' };
  }

  private recordAuthorizationSuppression(
    input: DirectChatRuntimeInput,
    agent: AgentDefinitionRecord,
    recordId: string,
    reason: string,
  ): void {
    this.dispatchOutcomeStore.recordHistory(input.subscription.subscriptionId, {
      at: new Date().toISOString(),
      kind: 'chat',
      action: 'chat_direct_authorization_denied',
      agentId: agent.agentId,
      sessionId: null,
      recordId,
      bindingId: input.event.thread_id ?? recordId,
      bindingType: 'thread',
      status: 'suppressed',
      suppressionReason: reason,
      details: { reason, agent_id: agent.agentId },
    });
    this.log.warn('[agent-chat] Agent Direct instruction denied', {
      agentId: agent.agentId,
      recordId,
      reason,
    });
  }

  recover(input: DirectChatRuntimeInput, routingKey: string): { handled: boolean; reason: string } {
    const pending = this.turnStore.getPending(routingKey);
    const intercept = this.deps.interceptStore.getByRoutingKey(routingKey);
    const hasRecoverableTurn = Boolean(pending);
    const hasPendingMessages = Boolean(intercept?.lastMessageIdSeen
      && intercept.pendingMessageCount > 0
      && (intercept.state === 'pending' || intercept.state === 'active' || intercept.state === 'archived'));
    if (!intercept || (!hasRecoverableTurn && !hasPendingMessages)) {
      return { handled: false, reason: 'no_recoverable_turn' };
    }
    const workspaceIdentity = input.subscription.workspaceServiceNpub?.trim() || input.subscription.workspaceOwnerNpub;
    const agent = this.deps.agentStore.getByAgentId(intercept.agentId);
    if (!agent || !agent.enabled || agent.botNpub !== intercept.botNpub || agent.workspaceOwnerNpub !== workspaceIdentity) {
      return { handled: false, reason: 'recovery_agent_missing' };
    }
    const resolvedAgent = withMvpDirectChatDefault(agent);
    if (!resolvedAgent.directChat?.enabled) return { handled: false, reason: 'recovery_agent_disabled' };
    const contextPrompt = channelDirectChatConfig(input.channel).contextPrompt || channelLegacyBasePrompt(input.channel);
    if (hasRecoverableTurn && this.deps.deliveryReconciler
      && !(pending!.state === "accepted" && !pending!.prompt && this.enrichment.store.get(pending!.turnId)?.mode === "pipeline_enrichment")) {
      this.deps.deliveryReconciler.notify(pending!.turnId);
      if (hasPendingMessages) this.deferPendingInput(routingKey, resolvedAgent, contextPrompt, input, pending!.turnId);
      return { handled: true, reason: 'direct_chat_delivery_reconciliation_queued' };
    }
    this.enqueue(routingKey, resolvedAgent, contextPrompt, input);
    return { handled: true, reason: hasRecoverableTurn ? 'direct_chat_recovery_queued' : 'direct_chat_pending_replay_queued' };
  }

  hasRecoverableTurn(routingKey: string): boolean {
    return Boolean(this.turnStore.getPending(routingKey));
  }

  async waitForIdle(): Promise<void> {
    while (this.running.size > 0 || this.deliveryWaiters.size > 0) {
      await Promise.all([...this.running.values(), ...this.deliveryWaiters.values()]);
    }
  }

  private enqueue(routingKey: string, agent: AgentDefinitionRecord, contextPrompt: string, input: DirectChatRuntimeInput): void {
    const idleTimer = this.idleTimers.get(routingKey);
    if (idleTimer) { clearTimeout(idleTimer); this.idleTimers.delete(routingKey); }
    this.queued.add(routingKey, input, { agent, contextPrompt });
    if (this.running.has(routingKey)) return;
    const run = (botIdentity: RuntimeBotIdentity) => this.run(routingKey, agent, contextPrompt, botIdentity);
    const work = (this.deps.withBotIdentity
      ? this.deps.withBotIdentity(agent, run)
      : run(input.botIdentity))
      .finally(() => this.running.delete(routingKey));
    this.running.set(routingKey, work);
    void work.catch((error) => {
      this.log.error('[agent-chat] direct chat queue failed', {
        routingKey,
        sessionId: this.deps.interceptStore.getByRoutingKey(routingKey)?.sessionId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async run(
    routingKey: string,
    agent: AgentDefinitionRecord,
    contextPrompt: string,
    botIdentity: RuntimeBotIdentity,
  ): Promise<void> {
    while (this.queued.has(routingKey)) {
      const captured = this.queued.take(routingKey);
      agent = captured.agent ?? agent;
      contextPrompt = captured.contextPrompt ?? contextPrompt;
      const input = { ...captured.input, botIdentity };
      let intercept = this.deps.interceptStore.getByRoutingKey(routingKey)!;
      let activity: AgentDirectLifecycleController | null = null;
      let outcomeRecordIds = input.event.entity_id ? [input.event.entity_id] : [];
      let activeTurnId: string | null = null;
      try {
        if (intercept.state === 'pending' && intercept.freshStartMessageId) {
          prepareFreshHumanSession({ manager: this.deps.processManager, interceptStore: this.deps.interceptStore,
            turnStore: this.turnStore, retireSessionWork: this.deps.retireSessionWork }, intercept, intercept.freshStartMessageId);
        }
        const pending = this.turnStore.getPending(routingKey);
        activeTurnId = pending?.turnId ?? null;
        const pendingAwaiting = (pending?.state === 'accepted' && (Boolean(pending.prompt) || this.enrichment.store.get(pending.turnId)?.mode !== 'pipeline_enrichment')) || pending?.state === 'awaiting_reply';
        if (pending?.replyBody) {
          const activityContext = { backendConnectionId: input.subscription.backendConnectionId, subscriptionId: input.subscription.subscriptionId, backendBaseUrl: input.subscription.backendBaseUrl,
            workspaceId: input.subscription.workspaceId!, appNpub: input.subscription.sourceAppNpub,
            botIdentity: input.botIdentity, channelId: intercept.channelId, threadId: intercept.threadId,
            triggerMessageId: pending.sourceMessageIds.at(-1)!, sessionId: `pending:${pending.turnId}`,
            agentNpub: intercept.botNpub, turnId: pending.turnId, startedAt: pending.createdAt };
          activity = this.createLifecycleController(activityContext,
            this.createActivityPublisher(activityContext));
          await activity.working((pending.sessionId ?? intercept.sessionId ?? activityContext.sessionId));
          await activity.commentary();
          const published = await this.publishTurn(input, intercept, agent, pending.turnId, pending.sourceMessageIds, pending.clientRequestId,
            pending.replyBody, pending.replyReadyAt ?? undefined);
          if (published) await activity.finish('completed');
          continue;
        }
        const completeHistory = orderDirectChatMessages(input.messages);
        const triggerIndex = completeHistory.findIndex(message => message.messageId === input.event.entity_id);
        const history = triggerIndex >= 0 ? completeHistory.slice(0, triggerIndex + 1) : completeHistory;
        const undelivered = pendingAwaiting
          ? history.filter((message) => pending.sourceMessageIds.includes(message.messageId)
              || selectUndeliveredActionableMessages(history, intercept, agent.botNpub, [input.subscription.wsKeyNpub ?? ''])
                .some((undeliveredMessage) => undeliveredMessage.messageId === message.messageId))
          : selectUndeliveredActionableMessages(history, intercept, agent.botNpub, [input.subscription.wsKeyNpub ?? '']);
        const revisionDispatch = messageRevisionDispatch(input.event);
        const delta = afterFreshHumanBoundary(history, pendingAwaiting
          ? undelivered
          : revisionDispatch
            ? history.filter((message) => message.messageId === input.event.entity_id)
          : undelivered.filter((message) => isAgentDirectMessageEligible(input.channel, message, agent.botNpub)), intercept);
        if (delta.length === 0) continue;
        if (pendingAwaiting && pending) {
          // A pre-session failure has no transcript for the delivery reconciler
          // to inspect. Older builds incorrectly converted these failed turns
          // into awaiting_reply forever. Terminalize the orphan and replay all
          // still-undelivered actionable input through normal session creation.
          if (!pending.sessionId && !intercept.sessionId) {
            this.turnStore.save({
              ...pending,
              state: 'failed',
              nextAttemptAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: pending.lastError ?? 'Agent Direct turn has no bound session and must be recreated.',
              lastErrorClass: pending.lastErrorClass ?? 'session_evidence_missing',
              updatedAt: new Date().toISOString(),
            });
            this.queued.add(routingKey, input);
            continue;
          }
          const hasNewerHumanMessage = delta.some((message) => !pending.sourceMessageIds.includes(message.messageId));
          if (hasNewerHumanMessage) {
            if (this.deps.deliveryReconciler) {
              await this.deps.deliveryReconciler.processTurnNow(pending.turnId);
              this.queued.add(routingKey, input);
              if (this.turnStore.getPending(routingKey)?.turnId !== pending.turnId) continue;
              this.deps.deliveryReconciler.notify(pending.turnId);
              this.deferPendingInput(routingKey, agent, contextPrompt, input, pending.turnId);
              return;
            }
            this.turnStore.save({ ...pending, state: 'completed', updatedAt: new Date().toISOString() });
            this.queued.add(routingKey, input);
            continue;
          }
          if (this.enrichment.store.get(pending.turnId)?.mode === "pipeline_enrichment"
            && !this.enrichment.store.claimSubmission(routingKey, this.submissionOwner, DIRECT_CHAT_SUBMISSION_LEASE_MS + 60000)) {
            this.queued.add(routingKey, input);
            await Bun.sleep(100);
            continue;
          }
          if (!intercept.sessionId) throw new Error('Accepted Agent Direct Chat turn has no bound session.');
          const recoverySourceMessageIds = delta.map((message) => message.messageId);
          outcomeRecordIds = recoverySourceMessageIds;
          this.turnStore.save({ ...pending, sourceMessageIds: recoverySourceMessageIds,
            subscriptionId: input.subscription.subscriptionId, backendBaseUrl: input.subscription.backendBaseUrl,
            towerServiceNpub: input.subscription.towerServiceNpub, workspaceId: input.subscription.workspaceId,
            sourceAppNpub: input.subscription.sourceAppNpub, channelId: intercept.channelId, threadId: intercept.threadId,
            agentId: agent.agentId, agentNpub: intercept.botNpub, sessionId: intercept.sessionId,
            updatedAt: new Date().toISOString() });
          intercept = this.deps.interceptStore.save({ ...intercept,
            lastHumanMessageIdDelivered: recoverySourceMessageIds.at(-1) ?? intercept.lastHumanMessageIdDelivered,
            pendingMessageCount: 0, updatedAt: new Date().toISOString() });
          const sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null,
            delta.at(-1)?.message ?? '');
          const session = sessionResolution.session;
          if (pending.sessionId !== session.id) {
            const rebound = sessionResolution.bootstrap
              ? { ...this.turnStore.get(pending.turnId)!, sessionId: session.id }
              : this.turnStore.save({ ...this.turnStore.get(pending.turnId)!, sessionId: session.id,
                  updatedAt: new Date().toISOString() });
            this.deps.deliveryReconciler?.notifyStatus(rebound, "recovery");
          }
          for (const recordId of recoverySourceMessageIds) {
            this.recordSessionOutcome(input, agent, recordId, session.id, routingKey);
          }
          intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
            sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
            state: 'active', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          const activityContext = {
            backendConnectionId: input.subscription.backendConnectionId, subscriptionId: input.subscription.subscriptionId,
            backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
            appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
            channelId: intercept.channelId, threadId: intercept.threadId,
            triggerMessageId: recoverySourceMessageIds.at(-1)!, sessionId: session.id,
            agentNpub: intercept.botNpub, turnId: pending.turnId, startedAt: pending.createdAt,
          };
          activity = this.createLifecycleController(activityContext,
            this.createActivityPublisher(activityContext));
          await activity.working(session.id);
          const recoveredEnrichment = sessionResolution.bootstrap
            ? await this.enrichment.prepare({ input, agent, turnId: pending.turnId,
                sourceMessageIds: recoverySourceMessageIds, sessionId: session.id }, status => {
                for (const recordId of recoverySourceMessageIds) this.dispatchOutcomeStore.recordEnrichment({
                  subscriptionId: input.subscription.subscriptionId, agentId: agent.agentId,
                  recordId, sessionId: session.id, details: status });
              })
            : null;
          const historicalRecoveryPrompt = !sessionResolution.bootstrap && pending.prompt ? pending.prompt : sessionResolution.bootstrap
            ? buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
                scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery, supplementalContext: supplementalContext(recoveredEnrichment) })
            : intercept.lastCompletedTurnId
              ? buildDirectChatFollowUpPrompt({ routingKey, threadId: intercept.threadId, history, actionableMessages: delta,
                  historyCheckpointMessageId: intercept.nativeHistoryCheckpointMessageId,
                  lastAgentMessageIdPublished: intercept.lastAgentMessageIdPublished })
              : buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
                  scopeId: input.channel.scope_id ?? null, history, nextMessages: delta });
          const recoveryPrompt = sessionResolution.bootstrap
            ? buildAcceptedDirectChatRecoveryPrompt(historicalRecoveryPrompt)
            : historicalRecoveryPrompt;
          if (sessionResolution.bootstrap) {
            this.turnStore.save({ ...this.turnStore.get(pending.turnId)!, sessionId: session.id,
              prompt: recoveryPrompt, state: 'accepted', updatedAt: new Date().toISOString() });
          }
          const recovered = sessionResolution.bootstrap
            ? await this.sendFinalResponse(this.deps.processManager, session.id, recoveryPrompt, {
                onAccepted: () => {
                  assertCurrentHumanTurn(this.turnStore, pending.turnId);
                  this.enrichment.store.accepted(pending.turnId, session.id);
                  this.turnStore.save({ ...this.turnStore.get(pending.turnId)!, state: 'awaiting_reply',
                    acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                },
                onPoll: () => { assertCurrentHumanTurn(this.turnStore, pending.turnId); return activity?.commentary(); },
              })
            : await awaitAcceptedFinalResponse(
                this.deps.processManager,
                session.id,
                recoveryPrompt,
                recoverySourceMessageIds,
                { acceptedAt: pending.createdAt, onPoll: () => { assertCurrentHumanTurn(this.turnStore, pending.turnId); return activity?.commentary(); } },
              );
          assertCurrentHumanTurn(this.turnStore, pending.turnId);
          freezeOrResumeDirectChatReply(this.turnStore, pending.turnId, recovered.content, recovered.createdAt, this.log);
          this.enrichment.store.accepted(pending.turnId, session.id);
          for (const recordId of recoverySourceMessageIds) {
            this.recordRecoveredSessionOutcome(input, agent, recordId, session.id, routingKey, 'final_turn');
          }
          await activity.commentary();
          const published = await this.publishTurn(input, intercept, agent, pending.turnId, recoverySourceMessageIds,
            pending.clientRequestId, recovered.content, recovered.createdAt);
          if (published) await activity.finish('completed');
          continue;
        }
        const sourceMessageIds = delta.map((message) => message.messageId);
        outcomeRecordIds = sourceMessageIds;
        const revisionKeys = revisionDispatch
          ? sourceMessageIds.map((messageId) => `${messageId}:revision:${revisionDispatch.revision}`)
          : sourceMessageIds;
        const turnId = pending?.turnId ?? buildDirectChatTurnId(routingKey, revisionKeys);
        activeTurnId = turnId;
        const clientRequestId = pending?.clientRequestId ?? buildDirectChatClientRequestId(routingKey, turnId);
        const now = pending?.createdAt ?? new Date().toISOString();
        const capturedEnrichment = this.enrichment.capture(turnId, agent, input.subscription.workspaceId!);
        if (capturedEnrichment.mode === "pipeline_enrichment"
          && !this.enrichment.store.claimSubmission(routingKey, this.submissionOwner, DIRECT_CHAT_SUBMISSION_LEASE_MS + 60000)) {
          this.queued.add(routingKey, input);
          await Bun.sleep(100);
          continue;
        }
        const activityContext = {
          backendConnectionId: input.subscription.backendConnectionId, subscriptionId: input.subscription.subscriptionId,
          backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
          appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
          channelId: intercept.channelId, threadId: intercept.threadId,
          triggerMessageId: sourceMessageIds.at(-1)!, sessionId: `pending:${turnId}`,
          agentNpub: intercept.botNpub, turnId, startedAt: now,
        };
        activity = this.createLifecycleController(activityContext,
          this.createActivityPublisher(activityContext));
        await activity.accepted();
        this.turnStore.save({ turnId, routingKey, sourceMessageIds, clientRequestId, replyBody: null,
          publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: now,
          subscriptionId: input.subscription.subscriptionId, backendBaseUrl: input.subscription.backendBaseUrl,
          towerServiceNpub: input.subscription.towerServiceNpub, workspaceId: input.subscription.workspaceId,
          sourceAppNpub: input.subscription.sourceAppNpub, channelId: intercept.channelId, threadId: intercept.threadId,
          agentId: agent.agentId, agentNpub: intercept.botNpub, sessionId: null, prompt: null, promptType: 'direct_chat',
          triggerMessageId: sourceMessageIds.at(-1) ?? null, receivedAt: delta[0]?.createdAt ?? now,
          acceptedAt: now, nextAttemptAt: now,
          leaseOwner: this.deps.deliveryReconciler?.runtimeLeaseOwner ?? null,
          leaseExpiresAt: this.deps.deliveryReconciler ? new Date(Date.now() + DIRECT_CHAT_SUBMISSION_LEASE_MS + 60000).toISOString() : null });
        let sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null,
          delta.at(-1)?.message ?? '');
        let session = sessionResolution.session;
        assertCurrentHumanTurn(this.turnStore, turnId);
        await activity.working(session.id);
        intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
          sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
          state: 'active', pendingMessageCount: delta.length, lastDecision: 'pending', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const prepareEnrichment = () => this.enrichment.prepare({ input, agent, turnId, sourceMessageIds, sessionId: session.id }, status => {
          for (const recordId of sourceMessageIds) this.dispatchOutcomeStore.recordEnrichment({ subscriptionId: input.subscription.subscriptionId,
            agentId: agent.agentId, recordId, sessionId: session.id, details: status });
        });
        let enrichmentResult = await prepareEnrichment();
        if (capturedEnrichment.mode === "pipeline_enrichment" && !this.enrichment.store.ownsSubmission(routingKey, this.submissionOwner)) {
          throw new Error("Enrichment lost the submission lease before prompt transport.");
        }
        let prompt = (sessionResolution.bootstrap || !intercept.nativeHistoryCheckpointMessageId)
          ? buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
              scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery, supplementalContext: supplementalContext(enrichmentResult) })
          : buildDirectChatFollowUpPrompt({ routingKey, threadId: intercept.threadId, history, actionableMessages: delta,
              historyCheckpointMessageId: intercept.nativeHistoryCheckpointMessageId,
              lastAgentMessageIdPublished: intercept.lastAgentMessageIdPublished, supplementalContext: supplementalContext(enrichmentResult) });
        const acceptedHistoryCheckpointMessageId = history.at(-1)?.messageId ?? null;
        const onAccepted = () => {
            assertCurrentHumanTurn(this.turnStore, turnId);
            this.enrichment.store.accepted(turnId, session.id);
            for (const recordId of sourceMessageIds) {
              this.recordSessionOutcome(input, agent, recordId, session.id, routingKey);
            }
            this.turnStore.save({ turnId, routingKey, sourceMessageIds, clientRequestId, replyBody: null,
              publishedMessageId: null, state: 'awaiting_reply', createdAt: now, updatedAt: new Date().toISOString(),
              subscriptionId: input.subscription.subscriptionId, backendBaseUrl: input.subscription.backendBaseUrl,
              towerServiceNpub: input.subscription.towerServiceNpub, workspaceId: input.subscription.workspaceId,
              sourceAppNpub: input.subscription.sourceAppNpub, channelId: intercept.channelId, threadId: intercept.threadId,
              agentId: agent.agentId, agentNpub: intercept.botNpub, sessionId: session.id, prompt, promptType: 'direct_chat',
              triggerMessageId: sourceMessageIds.at(-1) ?? null, receivedAt: delta[0]?.createdAt ?? now,
              acceptedAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString(),
              leaseOwner: this.deps.deliveryReconciler?.runtimeLeaseOwner ?? null,
              leaseExpiresAt: this.deps.deliveryReconciler ? new Date(Date.now() + 310_000).toISOString() : null });
            intercept = this.deps.interceptStore.save({ ...intercept,
              lastHumanMessageIdDelivered: sourceMessageIds.at(-1) ?? null, pendingMessageCount: 0,
              nativeHistoryCheckpointMessageId: acceptedHistoryCheckpointMessageId,
              updatedAt: new Date().toISOString() });
          };
        // Persist the intended prompt before transport so restart recovery can
        // inspect receipt without assuming that submission reached the agent.
        this.turnStore.save({ ...this.turnStore.get(turnId)!, sessionId: session.id, prompt,
          leaseExpiresAt: this.deps.deliveryReconciler ? new Date(Date.now() + DIRECT_CHAT_SUBMISSION_LEASE_MS + 60000).toISOString() : null,
          updatedAt: new Date().toISOString() });
        assertCurrentHumanTurn(this.turnStore, turnId);
        let reply;
        try {
          reply = await this.sendFinalResponse(this.deps.processManager, session.id, prompt, {
            onAccepted, onPoll: () => { assertCurrentHumanTurn(this.turnStore, turnId); return activity?.commentary(); },
          });
        } catch (error) {
          const failedTurn = this.turnStore.get(turnId);
          const replacePromptBoundary = error instanceof PromptBoundaryNotObservedError && !sessionResolution.bootstrap;
          const replacement = replacePromptBoundary
            ? { reason: 'previous session did not accept the submitted prompt', detail: error.message }
            : directChatSessionReplacementDecision(error);
          const promptWasAccepted = failedTurn?.state === 'awaiting_reply';
          const replacementAllowed = replacePromptBoundary || !promptWasAccepted;
          if (!replacement || !replacementAllowed) throw error;
          const rejectedSessionId = session.id;
          await this.deps.processManager.stopSession(rejectedSessionId).catch((stopError) => {
            this.log.warn('[agent-chat] failed to retire unhealthy direct chat session', {
              routingKey, sessionId: rejectedSessionId,
              error: stopError instanceof Error ? stopError.message : String(stopError),
            });
          });
          sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null,
            delta.at(-1)?.message ?? '', { forceReplacementReason: replacement.reason });
          session = sessionResolution.session;
          intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
            sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
            state: 'active', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          enrichmentResult = await prepareEnrichment();
          prompt = buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
            scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery, supplementalContext: supplementalContext(enrichmentResult) });
          await activity.working(session.id);
          await activity.progress(`Retired ${rejectedSessionId}: ${replacement.detail}`);
          this.turnStore.save({ ...this.turnStore.get(turnId)!, sessionId: session.id, prompt,
            leaseExpiresAt: this.deps.deliveryReconciler ? new Date(Date.now() + DIRECT_CHAT_SUBMISSION_LEASE_MS + 60000).toISOString() : null,
            updatedAt: new Date().toISOString() });
          reply = await this.sendFinalResponse(this.deps.processManager, session.id, prompt, {
            onAccepted, onPoll: () => { assertCurrentHumanTurn(this.turnStore, turnId); return activity?.commentary(); },
          });
        }
        assertCurrentHumanTurn(this.turnStore, turnId);
        freezeOrResumeDirectChatReply(this.turnStore, turnId, reply.content, reply.createdAt, this.log);
        for (const recordId of sourceMessageIds) {
          this.recordRecoveredSessionOutcome(input, agent, recordId, session.id, routingKey, 'final_turn');
        }
        const body = reply.content;
        await activity.commentary();
        const published = await this.publishTurn(input, intercept, agent, turnId, sourceMessageIds, clientRequestId,
          body, reply.createdAt);
        if (published) await activity.finish('completed');
      } catch (error) {
        const awaiting = activeTurnId ? this.turnStore.get(activeTurnId) : null;
        // A late waiter error cannot downgrade an authoritative delivery.
        if (awaiting?.lastErrorClass === 'fresh_human_supersession') {
          activity?.releaseObservation();
          continue;
        }
        if (awaiting && ['published', 'completed', 'suppressed'].includes(awaiting.state)) {
          await activity?.finish('completed');
          continue;
        }
        if (awaiting?.publicationPayload && this.deps.deliveryReconciler
          && !['failed', 'integrity_halt'].includes(awaiting.state)) {
          this.log.warn('[agent-chat] late observation error; frozen delivery remains recoverable', {
            turnId: awaiting.turnId, state: awaiting.state,
          });
          this.deps.deliveryReconciler.notify(awaiting.turnId);
          continue;
        }
        if (awaiting?.state === 'awaiting_reply' && (this.deps.deliveryReconciler || isSessionWaitTimeout(error))) {
          // Receipt owns execution. An observer timeout or capacity error must
          // never stop/replay an accepted turn that may still own live workers.
          activity?.releaseObservation();
          const interrupted = !isSessionWaitTimeout(error);
          if (interrupted) {
            this.turnStore.markInterrupted(awaiting.turnId, error instanceof Error ? error.message : String(error), ACCEPTED_TURN_INTERRUPTED);
            this.deps.deliveryReconciler?.notifyStatus(awaiting, 'interrupted');
            await activity?.finish('failed', 'Accepted work interrupted; retained for recovery.');
          }
          if (this.deps.deliveryReconciler && awaiting.leaseOwner === this.deps.deliveryReconciler.runtimeLeaseOwner) {
            this.turnStore.releaseAwaiting(awaiting.turnId, this.deps.deliveryReconciler.runtimeLeaseOwner, new Date().toISOString(),
              interrupted ? { message: error instanceof Error ? error.message : String(error), errorClass: ACCEPTED_TURN_INTERRUPTED } : undefined);
            this.deps.deliveryReconciler.notify(awaiting.turnId);
          }
          this.deps.interceptStore.save({ ...intercept, state: 'active', lastDecision: interrupted ? 'failed' : 'pending',
            lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          for (const recordId of outcomeRecordIds) {
            if (!intercept.sessionId || !isSessionWaitTimeout(error)) continue;
            this.dispatchOutcomeStore.recordSessionWaitTimeout({ subscriptionId: input.subscription.subscriptionId,
              recordId, agentId: agent.agentId, sessionId: intercept.sessionId,
              receivedAt: input.messages.find((message) => message.id === recordId)?.created_at ?? undefined,
              error: error instanceof Error ? error.message : String(error), details: { routing_key: routingKey } });
          }
          this.log.warn('[agent-chat] active response observation released to durable reconciliation', {
            routingKey, turnId: awaiting.turnId, sessionId: awaiting.sessionId,
          });
          continue;
        }
        await activity?.commentary();
        const errorMessage = error instanceof Error ? error.message : String(error);
        await activity?.finish(isInterruptedTurnError(error) ? 'cancelled' : 'failed',
          `${isInterruptedTurnError(error) ? 'Dispatch cancelled' : 'Dispatch failed'}: ${errorMessage}`);
        const errorCode = (error as { code?: unknown })?.code === BROKER_KEY_NOT_PROVISIONED
          || errorMessage.startsWith(`${BROKER_KEY_NOT_PROVISIONED}:`)
          ? BROKER_KEY_NOT_PROVISIONED
          : 'dispatch_failed';
        if (activeTurnId) {
          const failedTurn = this.turnStore.get(activeTurnId);
          if (failedTurn?.publicationPayload && !this.deps.deliveryReconciler) {
            this.turnStore.markIntegrityHalt(activeTurnId, errorCode, errorMessage);
          } else if (failedTurn) this.turnStore.markFailed(activeTurnId, errorCode, errorMessage);
        }
        const status = Number((error as { status?: unknown })?.status ?? 0);
        this.deps.interceptStore.save({ ...intercept, state: status === 401 || status === 403 ? 'blocked_auth' : 'pending',
          lastDecision: 'failed', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        for (const recordId of outcomeRecordIds) {
          const shared = {
            subscriptionId: input.subscription.subscriptionId,
            recordId,
            agentId: agent.agentId,
            receivedAt: input.messages.find((message) => message.id === recordId)?.created_at ?? undefined,
            sourceLabel: sourceLabelForFlightDeckChat({
              event: input.event,
              message: input.messages.find((message) => message.id === recordId),
              messages: input.messages,
            }),
            details: { routing_key: routingKey },
          };
          if (intercept.sessionId && awaiting?.state === 'awaiting_reply' && isSessionWaitTimeout(error)) {
            this.dispatchOutcomeStore.recordSessionWaitTimeout({ ...shared, sessionId: intercept.sessionId, error: errorMessage });
          } else {
            this.dispatchOutcomeStore.recordSessionFailure({ ...shared, error: errorMessage,
              ...(errorCode === BROKER_KEY_NOT_PROVISIONED ? {
                reasonCode: BROKER_KEY_NOT_PROVISIONED,
                reasonLabel: 'Stable agent key requires one-time broker vault provisioning',
              } : {}) });
          }
        }
        this.log.error('[agent-chat] direct chat turn failed', {
          routingKey,
          sessionId: intercept.sessionId,
          sessionGeneration: intercept.sessionGeneration,
          pendingMessageCount: intercept.pendingMessageCount,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.enrichment.store.releaseSubmission(routingKey, this.submissionOwner);
      }
    }
  }

  private recordSessionOutcome(
    input: DirectChatRuntimeInput,
    agent: AgentDefinitionRecord,
    recordId: string,
    sessionId: string,
    routingKey: string,
  ): void {
    this.dispatchOutcomeStore.recordSession({
      subscriptionId: input.subscription.subscriptionId,
      recordId,
      agentId: agent.agentId,
      sessionId,
      receivedAt: input.messages.find((message) => message.id === recordId)?.created_at ?? undefined,
      sourceLabel: sourceLabelForFlightDeckChat({
        event: input.event,
        message: input.messages.find((message) => message.id === recordId),
        messages: input.messages,
      }),
      details: {
        routing_key: routingKey,
        channel_id: input.channel.id,
        thread_id: this.deps.interceptStore.getByRoutingKey(routingKey)?.threadId ?? null,
      },
    });
  }

  private recordRecoveredSessionOutcome(
    input: DirectChatRuntimeInput,
    agent: AgentDefinitionRecord,
    recordId: string,
    sessionId: string,
    routingKey: string,
    evidence: 'final_turn' | 'flightdeck_delivery',
    publishedMessageId?: string | null,
  ): void {
    this.dispatchOutcomeStore.recordSessionRecovered({
      subscriptionId: input.subscription.subscriptionId,
      recordId,
      agentId: agent.agentId,
      sessionId,
      evidence,
      publishedMessageId,
      sourceLabel: sourceLabelForFlightDeckChat({
        event: input.event,
        message: input.messages.find((message) => message.id === recordId),
        messages: input.messages,
      }),
      details: { routing_key: routingKey },
    });
  }

  private async publishTurn(input: DirectChatRuntimeInput, intercept: NonNullable<ReturnType<ChatInterceptStateStore['getByRoutingKey']>>, agent: AgentDefinitionRecord, turnId: string, sourceMessageIds: string[], clientRequestId: string, body: string, candidateAt?: string): Promise<boolean> {
    let record = this.turnStore.get(turnId) ?? this.turnStore.save({ turnId, routingKey: intercept.routingKey,
      sourceMessageIds, clientRequestId, replyBody: null, publishedMessageId: null, state: 'awaiting_reply',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      subscriptionId: input.subscription.subscriptionId, backendBaseUrl: input.subscription.backendBaseUrl,
      towerServiceNpub: input.subscription.towerServiceNpub, workspaceId: input.subscription.workspaceId,
      sourceAppNpub: input.subscription.sourceAppNpub, channelId: intercept.channelId, threadId: intercept.threadId,
      agentId: agent.agentId, agentNpub: intercept.botNpub, sessionId: intercept.sessionId, promptType: 'direct_chat' });
    if (record.lastErrorClass === 'fresh_human_supersession') return false;
    record = this.deps.deliveryReconciler
      ? freezeOrResumeDirectChatReply(this.turnStore, turnId, body, candidateAt, this.log)
      : this.turnStore.freezeReply(turnId, body, candidateAt);
    let messageId: string | null;
    let suppressed = false;
    if (this.deps.deliveryReconciler) {
      record = await this.deps.deliveryReconciler.processTurnNow(turnId) ?? record;
      messageId = record.state === 'published' ? record.publishedMessageId ?? null : null;
      suppressed = record.state === 'suppressed';
      if (record.state === 'failed' || record.state === 'integrity_halt') {
        throw new Error(record.lastError ?? `Agent Direct delivery ${turnId} failed.`);
      }
      if (!messageId && !suppressed) return false;
    } else {
      const readyAt = record.replyReadyAt ?? '';
      suppressed = this.deps.publicationFilter?.evaluate({ decisionId: turnId, routingKey: intercept.routingKey,
        subscriptionId: input.subscription.subscriptionId, agentNpub: intercept.botNpub,
        body, candidateAt: readyAt }).suppress ?? false;
      if (suppressed) {
        messageId = null;
      } else {
        messageId = (await this.publish({ backendConnectionId: input.subscription.backendConnectionId, backendBaseUrl: input.subscription.backendBaseUrl,
            workspaceId: input.subscription.workspaceId!, channelId: intercept.channelId, appNpub: input.subscription.sourceAppNpub,
            botIdentity: input.botIdentity, body, threadId: intercept.threadId, clientRequestId,
            metadata: { source: 'autopilot_session', session_id: intercept.sessionId, turn_id: turnId,
              prompt_type: 'direct_chat', source_message_ids: sourceMessageIds, agent_npub: intercept.botNpub } })).message?.id ?? null;
        const publishedAt = new Date().toISOString();
        if (messageId) this.deps.publicationFilter?.recordPublished({ decisionId: turnId, routingKey: intercept.routingKey,
          candidateAt: readyAt, publishedAt, publishedMessageId: messageId });
      }
    }
    const now = new Date().toISOString();
    if (messageId && intercept.sessionId) {
      for (const recordId of sourceMessageIds) {
        this.recordRecoveredSessionOutcome(input, agent, recordId, intercept.sessionId, intercept.routingKey,
          'flightdeck_delivery', messageId);
      }
    }
    if (!this.deps.deliveryReconciler) {
      this.turnStore.save({ ...record, publishedMessageId: messageId, state: suppressed ? 'suppressed' : 'completed',
        lastError: suppressed ? 'Duplicate callback response suppressed before Tower publication.' : null,
        lastErrorClass: suppressed ? 'duplicate_callback_within_window' : null,
        updatedAt: now, publishedAt: suppressed ? null : now });
    }
    this.deps.interceptStore.save({ ...intercept,
      lastAgentMessageIdPublished: suppressed ? intercept.lastAgentMessageIdPublished : messageId,
      lastCompletedTurnId: turnId, state: 'idle', lastDecision: suppressed ? 'ignore' : 'respond', pendingMessageCount: 0,
      lastActivityAt: now, updatedAt: now });
    this.scheduleIdleStop(intercept.routingKey, agent.directChat?.idleRetentionMinutes ?? 60);
    return true;
  }

  private scheduleIdleStop(routingKey: string, minutes: number): void {
    const timer = setTimeout(async () => {
      this.idleTimers.delete(routingKey);
      const intercept = this.deps.interceptStore.getByRoutingKey(routingKey);
      if (!intercept?.sessionId || intercept.state !== 'idle') return;
      await this.deps.processManager.stopSession(intercept.sessionId).catch(() => null);
      this.deps.interceptStore.save({ ...intercept, state: 'archived', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }, Math.max(1, minutes) * 60_000);
    timer.unref?.();
    this.idleTimers.set(routingKey, timer);
  }

  private deferPendingInput(routingKey: string, agent: AgentDefinitionRecord, contextPrompt: string,
    input: DirectChatRuntimeInput, turnId: string): void {
    this.queued.add(routingKey, input);
    if (this.deliveryWaiters.has(routingKey)) return;
    const waiter = (async () => {
      while (this.turnStore.get(turnId) && this.turnStore.getPending(routingKey)?.turnId === turnId) {
        this.deps.deliveryReconciler?.notify(turnId);
        await Bun.sleep(1_000);
      }
      if (this.queued.has(routingKey)) this.enqueue(routingKey, agent, contextPrompt, this.queued.head(routingKey)!);
    })().finally(() => this.deliveryWaiters.delete(routingKey));
    this.deliveryWaiters.set(routingKey, waiter);
  }

  private async resolveSession(agent: AgentDefinitionRecord, intercept: NonNullable<ReturnType<ChatInterceptStateStore['getByRoutingKey']>>, subscription: WorkspaceSubscriptionRecord, scopeId: string | null,
    latestMessage: string,
    options?: { forceReplacementReason?: string }): Promise<{
    session: SessionSnapshot; bootstrap: boolean; generation: number; previousSessionIds: string[]; recovery: { previousSessionId: string; reason: string } | null;
  }> {
    const live = intercept.sessionId ? this.deps.processManager.getSession(intercept.sessionId) : null;
    const archived = !live && intercept.sessionId ? this.deps.getArchivedSession?.(intercept.sessionId) ?? null : null;
    const liveBindingCompatible = live?.metadata?.flightdeckAgentNpub === agent.botNpub
      && live.agent === (agent.directChat?.sessionAgent || this.deps.defaultAgent)
      && live.workingDirectory === (agent.directChat?.directory || agent.workingDirectory);
    const liveModelCompatible = normalizeAgentModelOverride(live?.model) === normalizeAgentModelOverride(agent.directChat?.model ?? undefined);
    const liveCompatible = liveBindingCompatible && liveModelCompatible;
    const currentGeneration = intercept.sessionGeneration ?? 1;
    const currentBinding = buildDirectChatSessionBinding({ subscription, intercept, agent, scopeId,
      generation: currentGeneration, latestMessage });
    if (!options?.forceReplacementReason && liveCompatible && (live?.status === 'running' || live?.status === 'starting')) {
      assertDirectChatWorkspaceCompatible(live.metadata, currentBinding, live.id);
      const rebound = this.deps.processManager.updateSessionMetadata(live.id, currentBinding);
      if (!rebound) throw new Error(`Agent Direct session ${live.id} disappeared while refreshing its Flight Deck binding.`);
      return { session: rebound, bootstrap: false, generation: currentGeneration,
        previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
    }
    const modelReplacementReason = live && liveBindingCompatible && !liveModelCompatible ? 'profile model changed' : null;
    const resumeSource = modelReplacementReason ? null : live ?? (archived && isAgentType(archived.agent) ? { ...archived, agent: archived.agent } : null);
    if (resumeSource && !options?.forceReplacementReason) {
      try {
        const launch = resolveNativeResumeLaunch(resumeSource, isAgentType, subscription.managedByNpub);
        assertDirectChatWorkspaceCompatible(launch.metadata, currentBinding, resumeSource.id);
        const resumed = await this.deps.processManager.createSession(launch.agent, launch.workingDirectory, launch.name,
          launch.origin, undefined, launch.ownerNpub, { ...launch.metadata, ...currentBinding }, live?.model);
        this.deps.rebindSession?.(resumeSource.id, resumed.id);
        return { session: resumed, bootstrap: false, generation: currentGeneration,
          previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
      } catch (error) {
        this.log.warn('[agent-chat] native direct chat resume failed; creating continuity replacement', {
          routingKey: intercept.routingKey,
          sessionId: resumeSource.id,
          sessionGeneration: intercept.sessionGeneration,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const previous = intercept.sessionId;
    const generation = previous ? (intercept.sessionGeneration ?? 1) + 1 : 1;
    const previousSessionIds = previous ? [...new Set([...(intercept.previousSessionIds ?? []), previous])] : intercept.previousSessionIds ?? [];
    const profile = agent.directChat!;
    const sessionAgent = profile.sessionAgent && isAgentType(profile.sessionAgent) ? profile.sessionAgent : this.deps.defaultAgent;
    const session = await this.deps.processManager.createSession(sessionAgent, profile.directory, `${agent.label} Direct Chat`,
      { type: 'agent-chat', id: intercept.routingKey, label: `${agent.label} Flight Deck chat` }, undefined,
      subscription.managedByNpub ?? undefined,
      buildDirectChatSessionBinding({ subscription, intercept, agent, scopeId, generation, latestMessage }),
      profile.model ?? undefined);
    if (previous) this.deps.rebindSession?.(previous, session.id);
    return { session, bootstrap: true, generation, previousSessionIds,
      recovery: previous ? { previousSessionId: previous,
        reason: options?.forceReplacementReason ?? (resumeSource ? 'native resume unavailable' : modelReplacementReason ?? 'session missing') } : null };
  }
}
