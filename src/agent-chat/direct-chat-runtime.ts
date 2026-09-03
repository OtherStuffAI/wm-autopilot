import type { AgentType } from '../config';
import { isAgentType } from '../agent-types';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
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
import { directChatTurnStore, type DirectChatTurnStore } from './direct-chat-turn-store';
import { AgentActivityPublisher, type AgentActivityContext } from './agent-activity-publisher';
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

export interface DirectChatRuntimeInput {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  event: FlightDeckPgEvent;
  channel: FlightDeckPgChannel;
  messages: FlightDeckPgMessage[];
  audienceAgentNpubs?: string[];
}

interface DirectChatRuntimeDependencies {
  defaultAgent: AgentType;
  processManager: ProcessManager;
  agentStore: AgentDefinitionStore;
  interceptStore: ChatInterceptStateStore;
  turnStore?: DirectChatTurnStore;
  publish?: typeof createFlightDeckPgChannelMessage;
  createActivityPublisher?: (context: AgentActivityContext) => AgentActivityPublisher;
  getArchivedSession?: (sessionId: string) => ArchivedSession | null;
  log?: Pick<Console, 'error' | 'warn'>;
  deliveryReconciler?: AgentDirectDeliveryReconciler;
  sendFinalResponse?: typeof sendPromptAndAwaitFinalResponse;
  dispatchOutcomeStore?: FlightDeckDispatchOutcomeStore;
  publicationFilter?: DuplicateCallbackPublicationFilter;
  withBotIdentity?: <T>(
    agent: AgentDefinitionRecord,
    operation: (identity: RuntimeBotIdentity) => Promise<T>,
  ) => Promise<T>;
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
  private readonly queued = new Map<string, DirectChatRuntimeInput>();
  private readonly deliveryWaiters = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnStore: DirectChatTurnStore;
  private readonly publish: typeof createFlightDeckPgChannelMessage;
  private readonly createActivityPublisher: (context: AgentActivityContext) => AgentActivityPublisher;
  private readonly log: Pick<Console, 'error' | 'warn'>;
  private readonly sendFinalResponse: typeof sendPromptAndAwaitFinalResponse;
  private readonly dispatchOutcomeStore: FlightDeckDispatchOutcomeStore;

  constructor(private readonly deps: DirectChatRuntimeDependencies) {
    this.turnStore = deps.turnStore ?? directChatTurnStore;
    this.publish = deps.publish ?? createFlightDeckPgChannelMessage;
    this.createActivityPublisher = deps.createActivityPublisher ?? ((context) => new AgentActivityPublisher(context));
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
      const threadId = input.messages.find((message) => message.id === eventMessage.messageId)?.thread_id
        ?? input.messages.find((message) => message.id === eventMessage.messageId)?.thread_source_message_id
        ?? eventMessage.messageId;
      const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: input.subscription.towerServiceNpub || input.subscription.backendBaseUrl,
        workspaceId: input.subscription.workspaceId || workspaceIdentity, channelId: input.channel.id, threadId, agentNpub: agent.botNpub });
      const cursor = input.event.cursor ?? (input.event.row_version != null ? String(input.event.row_version) : null);
      const upsert = this.deps.interceptStore.upsertMessage({
        routingKey, subscriptionId: input.subscription.subscriptionId, agentId: agent.agentId,
        workspaceOwnerNpub: workspaceIdentity, sourceAppNpub: input.subscription.sourceAppNpub,
        towerServiceNpub: input.subscription.towerServiceNpub ?? '', workspaceId: input.subscription.workspaceId ?? '',
        channelId: input.channel.id, threadId, botNpub: agent.botNpub, messageId: eventMessage.messageId,
        messageRevision: revisionDispatch?.revision ?? null, eventCursor: cursor,
      });
      if (upsert.wasDuplicate && !this.turnStore.getPending(routingKey)) continue;
      handled = true;
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
      }
      this.enqueue(routingKey, agent, contextPrompt, input);
    }
    return { handled, reason: handled ? 'direct_chat_queued' : 'not_activated' };
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
    if (hasRecoverableTurn && this.deps.deliveryReconciler) {
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
    this.queued.set(routingKey, input);
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
      const input = { ...this.queued.get(routingKey)!, botIdentity };
      this.queued.delete(routingKey);
      let intercept = this.deps.interceptStore.getByRoutingKey(routingKey)!;
      let activity: AgentActivityPublisher | null = null;
      let outcomeRecordIds = input.event.entity_id ? [input.event.entity_id] : [];
      let activeTurnId: string | null = null;
      try {
        const pending = this.turnStore.getPending(routingKey);
        activeTurnId = pending?.turnId ?? null;
        const pendingAwaiting = pending?.state === 'accepted' || pending?.state === 'awaiting_reply';
        if (pending?.replyBody) {
          await this.publishTurn(input, intercept, agent, pending.turnId, pending.sourceMessageIds, pending.clientRequestId,
            pending.replyBody, pending.replyReadyAt ?? undefined);
          continue;
        }
        const history = orderDirectChatMessages(input.messages);
        const undelivered = pendingAwaiting
          ? history.filter((message) => pending.sourceMessageIds.includes(message.messageId)
              || selectUndeliveredActionableMessages(history, intercept, agent.botNpub, [input.subscription.wsKeyNpub ?? ''])
                .some((undeliveredMessage) => undeliveredMessage.messageId === message.messageId))
          : selectUndeliveredActionableMessages(history, intercept, agent.botNpub, [input.subscription.wsKeyNpub ?? '']);
        const revisionDispatch = messageRevisionDispatch(input.event);
        const delta = pendingAwaiting
          ? undelivered
          : revisionDispatch
            ? history.filter((message) => message.messageId === input.event.entity_id)
          : undelivered.filter((message) => isAgentDirectMessageEligible(input.channel, message, agent.botNpub));
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
            this.queued.set(routingKey, input);
            continue;
          }
          const hasNewerHumanMessage = delta.some((message) => !pending.sourceMessageIds.includes(message.messageId));
          if (hasNewerHumanMessage) {
            if (this.deps.deliveryReconciler) {
              await this.deps.deliveryReconciler.processTurnNow(pending.turnId);
              this.queued.set(routingKey, input);
              if (this.turnStore.getPending(routingKey)?.turnId !== pending.turnId) continue;
              this.deps.deliveryReconciler.notify(pending.turnId);
              this.deferPendingInput(routingKey, agent, contextPrompt, input, pending.turnId);
              return;
            }
            this.turnStore.save({ ...pending, state: 'completed', updatedAt: new Date().toISOString() });
            this.queued.set(routingKey, input);
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
          const sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null);
          const session = sessionResolution.session;
          for (const recordId of recoverySourceMessageIds) {
            this.recordSessionOutcome(input, agent, recordId, session.id, routingKey);
          }
          intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
            sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
            state: 'active', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          activity = this.createActivityPublisher({
            backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
            appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
            channelId: intercept.channelId, threadId: intercept.threadId,
            triggerMessageId: recoverySourceMessageIds.at(-1)!, sessionId: session.id,
            agentNpub: intercept.botNpub, turnId: pending.turnId, startedAt: pending.createdAt,
          });
          await activity.publish('working');
          const recoveryPrompt = sessionResolution.bootstrap
            ? buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
                scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery })
            : intercept.lastCompletedTurnId
              ? buildDirectChatFollowUpPrompt({ routingKey, threadId: intercept.threadId, history, actionableMessages: delta })
              : buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
                  scopeId: input.channel.scope_id ?? null, history, nextMessages: delta });
          const recovered = sessionResolution.bootstrap
            ? await this.sendFinalResponse(this.deps.processManager, session.id, recoveryPrompt, {
                onPoll: () => activity?.publishLatestCommentary(this.deps.processManager),
              })
            : await awaitAcceptedFinalResponse(
                this.deps.processManager,
                session.id,
                recoveryPrompt,
                recoverySourceMessageIds,
                { acceptedAt: pending.createdAt, onPoll: () => activity?.publishLatestCommentary(this.deps.processManager) },
              );
          for (const recordId of recoverySourceMessageIds) {
            this.recordRecoveredSessionOutcome(input, agent, recordId, session.id, routingKey, 'final_turn');
          }
          const published = await this.publishTurn(input, intercept, agent, pending.turnId, recoverySourceMessageIds,
            pending.clientRequestId, recovered.content, recovered.createdAt);
          if (published) await activity.publish('completed');
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
        activity = this.createActivityPublisher({
          backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
          appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
          channelId: intercept.channelId, threadId: intercept.threadId,
          triggerMessageId: sourceMessageIds.at(-1)!, sessionId: `pending:${turnId}`,
          agentNpub: intercept.botNpub, turnId, startedAt: now,
        });
        await activity.publish('accepted');
        this.turnStore.save({ turnId, routingKey, sourceMessageIds, clientRequestId, replyBody: null,
          publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: now,
          subscriptionId: input.subscription.subscriptionId, backendBaseUrl: input.subscription.backendBaseUrl,
          towerServiceNpub: input.subscription.towerServiceNpub, workspaceId: input.subscription.workspaceId,
          sourceAppNpub: input.subscription.sourceAppNpub, channelId: intercept.channelId, threadId: intercept.threadId,
          agentId: agent.agentId, agentNpub: intercept.botNpub, sessionId: null, prompt: null, promptType: 'direct_chat',
          triggerMessageId: sourceMessageIds.at(-1) ?? null, receivedAt: delta[0]?.createdAt ?? now,
          acceptedAt: now, nextAttemptAt: now });
        let sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null);
        let session = sessionResolution.session;
        for (const recordId of sourceMessageIds) {
          this.recordSessionOutcome(input, agent, recordId, session.id, routingKey);
        }
        activity.bindSession(session.id);
        await activity.publish('working');
        intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
          sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
          state: 'active', pendingMessageCount: delta.length, lastDecision: 'pending', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        let prompt = sessionResolution.bootstrap
          ? buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
              scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery })
          : buildDirectChatFollowUpPrompt({ routingKey, threadId: intercept.threadId, history, actionableMessages: delta });
        const onAccepted = () => {
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
              updatedAt: new Date().toISOString() });
          };
        let reply;
        try {
          reply = await this.sendFinalResponse(this.deps.processManager, session.id, prompt, {
            onAccepted, onPoll: () => activity?.publishLatestCommentary(this.deps.processManager),
          });
        } catch (error) {
          if (!(error instanceof PromptBoundaryNotObservedError) || sessionResolution.bootstrap) throw error;
          const rejectedSessionId = session.id;
          await this.deps.processManager.stopSession(rejectedSessionId).catch((stopError) => {
            this.log.warn('[agent-chat] failed to retire non-accepting direct chat session', {
              routingKey, sessionId: rejectedSessionId,
              error: stopError instanceof Error ? stopError.message : String(stopError),
            });
          });
          sessionResolution = await this.resolveSession(agent, intercept, input.subscription, input.channel.scope_id ?? null,
            { forceReplacementReason: 'previous session did not accept the submitted prompt' });
          session = sessionResolution.session;
          for (const recordId of sourceMessageIds) {
            this.recordSessionOutcome(input, agent, recordId, session.id, routingKey);
          }
          intercept = this.deps.interceptStore.save({ ...intercept, sessionId: session.id,
            sessionGeneration: sessionResolution.generation, previousSessionIds: sessionResolution.previousSessionIds,
            state: 'active', lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          prompt = buildDirectChatBootstrapPrompt({ contextPrompt, subscription: input.subscription, intercept,
            scopeId: input.channel.scope_id ?? null, history, nextMessages: delta, recovery: sessionResolution.recovery });
          activity.bindSession(session.id);
          await activity.publish('working');
          reply = await this.sendFinalResponse(this.deps.processManager, session.id, prompt, {
            onAccepted, onPoll: () => activity?.publishLatestCommentary(this.deps.processManager),
          });
        }
        for (const recordId of sourceMessageIds) {
          this.recordRecoveredSessionOutcome(input, agent, recordId, session.id, routingKey, 'final_turn');
        }
        const body = reply.content;
        const published = await this.publishTurn(input, intercept, agent, turnId, sourceMessageIds, clientRequestId,
          body, reply.createdAt);
        if (published) await activity.publish('completed');
      } catch (error) {
        const awaiting = activeTurnId ? this.turnStore.get(activeTurnId) : null;
        if (awaiting && isSessionWaitTimeout(error)) {
          if (this.deps.deliveryReconciler && awaiting.leaseOwner === this.deps.deliveryReconciler.runtimeLeaseOwner) {
            this.turnStore.releaseAwaiting(awaiting.turnId, this.deps.deliveryReconciler.runtimeLeaseOwner, new Date().toISOString());
            this.deps.deliveryReconciler.notify(awaiting.turnId);
          }
          this.deps.interceptStore.save({ ...intercept, state: 'active', lastDecision: 'pending',
            lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          for (const recordId of outcomeRecordIds) {
            if (!intercept.sessionId) continue;
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
        await activity?.publish('failed');
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = (error as { code?: unknown })?.code === BROKER_KEY_NOT_PROVISIONED
          || errorMessage.startsWith(`${BROKER_KEY_NOT_PROVISIONED}:`)
          ? BROKER_KEY_NOT_PROVISIONED
          : 'dispatch_failed';
        if (activeTurnId) {
          const failedTurn = this.turnStore.get(activeTurnId);
          if (failedTurn) this.turnStore.save({ ...failedTurn, state: 'failed', updatedAt: new Date().toISOString(),
            nextAttemptAt: null, lastError: errorMessage, lastErrorClass: errorCode });
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
          if (intercept.sessionId && isSessionWaitTimeout(error)) {
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
    record = this.turnStore.freezeReply(turnId, body, candidateAt);
    let messageId: string | null;
    let suppressed = false;
    if (this.deps.deliveryReconciler) {
      record = await this.deps.deliveryReconciler.processTurnNow(turnId) ?? record;
      messageId = record.state === 'published' ? record.publishedMessageId ?? null : null;
      suppressed = record.state === 'suppressed';
      if (!messageId && !suppressed) return false;
    } else {
      const readyAt = record.replyReadyAt ?? '';
      suppressed = this.deps.publicationFilter?.evaluate({ decisionId: turnId, routingKey: intercept.routingKey,
        subscriptionId: input.subscription.subscriptionId, agentNpub: intercept.botNpub,
        body, candidateAt: readyAt }).suppress ?? false;
      if (suppressed) {
        messageId = null;
      } else {
        messageId = (await this.publish({ backendBaseUrl: input.subscription.backendBaseUrl,
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
    this.queued.set(routingKey, input);
    if (this.deliveryWaiters.has(routingKey)) return;
    const waiter = (async () => {
      while (this.turnStore.get(turnId) && this.turnStore.getPending(routingKey)?.turnId === turnId) {
        this.deps.deliveryReconciler?.notify(turnId);
        await Bun.sleep(1_000);
      }
      if (this.queued.has(routingKey)) this.enqueue(routingKey, agent, contextPrompt, this.queued.get(routingKey)!);
    })().finally(() => this.deliveryWaiters.delete(routingKey));
    this.deliveryWaiters.set(routingKey, waiter);
  }

  private async resolveSession(agent: AgentDefinitionRecord, intercept: NonNullable<ReturnType<ChatInterceptStateStore['getByRoutingKey']>>, subscription: WorkspaceSubscriptionRecord, scopeId: string | null,
    options?: { forceReplacementReason?: string }): Promise<{
    session: SessionSnapshot; bootstrap: boolean; generation: number; previousSessionIds: string[]; recovery: { previousSessionId: string; reason: string } | null;
  }> {
    const live = intercept.sessionId ? this.deps.processManager.getSession(intercept.sessionId) : null;
    const archived = !live && intercept.sessionId ? this.deps.getArchivedSession?.(intercept.sessionId) ?? null : null;
    const liveCompatible = live?.metadata?.flightdeckAgentNpub === agent.botNpub
      && live.agent === (agent.directChat?.sessionAgent || this.deps.defaultAgent)
      && live.workingDirectory === (agent.directChat?.directory || agent.workingDirectory);
    if (!options?.forceReplacementReason && liveCompatible && (live?.status === 'running' || live?.status === 'starting')) return { session: live, bootstrap: false, generation: intercept.sessionGeneration ?? 1, previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
    const resumeSource = live ?? (archived && isAgentType(archived.agent) ? { ...archived, agent: archived.agent } : null);
    if (resumeSource && !options?.forceReplacementReason) {
      try {
        const launch = resolveNativeResumeLaunch(resumeSource, isAgentType, subscription.managedByNpub);
        const resumed = await this.deps.processManager.createSession(launch.agent, launch.workingDirectory, launch.name, launch.origin, undefined, launch.ownerNpub, launch.metadata, live?.model);
        return { session: resumed, bootstrap: false, generation: intercept.sessionGeneration ?? 1, previousSessionIds: intercept.previousSessionIds ?? [], recovery: null };
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
      subscription.managedByNpub ?? undefined, { AGENT: true, sessionClass: 'flightdeck_chat',
        flightdeckTowerServiceNpub: intercept.towerServiceNpub, flightdeckWorkspaceId: intercept.workspaceId,
        flightdeckScopeId: scopeId ?? undefined, flightdeckChannelId: intercept.channelId, flightdeckThreadId: intercept.threadId,
        agentChatAgentId: agent.agentId, agentChatBotNpub: agent.botNpub,
        flightdeckAgentNpub: intercept.botNpub, flightdeckRoutingKey: intercept.routingKey, sessionGeneration: generation }, profile.model ?? undefined);
    return { session, bootstrap: true, generation, previousSessionIds,
      recovery: previous ? { previousSessionId: previous,
        reason: options?.forceReplacementReason ?? (resumeSource ? 'native resume unavailable' : 'session missing') } : null };
  }
}
