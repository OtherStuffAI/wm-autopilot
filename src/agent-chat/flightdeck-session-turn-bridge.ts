import { createHash } from 'node:crypto';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { AgentActivityPublisher } from './agent-activity-publisher';
import { flightDeckSessionTurnStore, type FlightDeckSessionTurnRecord, type FlightDeckSessionTurnStore } from './flightdeck-session-turn-store';
import { awaitAcceptedFinalResponse } from './session-runtime-session-ops';
import { createFlightDeckPgChannelMessage } from './tower-client';
import type { RuntimeBotIdentity } from './types';
import { buildDirectChatRoutingKey } from './direct-chat-contract';
import type { DuplicateCallbackPublicationFilter } from './duplicate-callback-publication-filter';

export interface FlightDeckTurnDeliveryContext {
  subscriptionId: string;
  backendBaseUrl: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
}

export interface FlightDeckSessionBinding extends FlightDeckTurnDeliveryContext {
  towerServiceNpub: string;
  workspaceId: string;
  channelId: string;
  threadId: string;
  agentNpub: string;
}

export type FlightDeckBindingResolver = (session: SessionSnapshot) => FlightDeckTurnDeliveryContext | null;
export type FlightDeckTriggerResolver = (session: SessionSnapshot) => string | null;

const requiredKeys = ['flightdeckTowerServiceNpub', 'flightdeckWorkspaceId', 'flightdeckChannelId',
  'flightdeckThreadId', 'flightdeckAgentNpub'] as const;

export function resolveFlightDeckSessionBinding(session: SessionSnapshot, delivery: FlightDeckTurnDeliveryContext | null): FlightDeckSessionBinding | null {
  if (session.metadata?.sessionClass !== 'flightdeck_chat') return null;
  const missing = requiredKeys.filter((key) => !session.metadata?.[key]?.trim());
  if (missing.length > 0) throw new Error(`Flight Deck-bound session ${session.id} is missing required binding metadata: ${missing.join(', ')}`);
  if (!delivery) throw new Error(`Flight Deck-bound session ${session.id} has no active delivery identity for its explicit binding.`);
  return { ...delivery, towerServiceNpub: session.metadata.flightdeckTowerServiceNpub!,
    workspaceId: session.metadata.flightdeckWorkspaceId!, channelId: session.metadata.flightdeckChannelId!,
    threadId: session.metadata.flightdeckThreadId!, agentNpub: session.metadata.flightdeckAgentNpub! };
}

export function buildFlightDeckSessionTurnId(sessionId: string, boundaryIdentity: string): string {
  return createHash('sha256').update(`${sessionId}\0${boundaryIdentity}`).digest('hex');
}

function finalIdentity(content: string, createdAt: string): string {
  return createHash('sha256').update(`${createdAt}\0${content}`).digest('hex');
}

export class FlightDeckSessionTurnBridge {
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly deps: { manager: ProcessManager; resolveDelivery: FlightDeckBindingResolver;
    store?: FlightDeckSessionTurnStore; publish?: typeof createFlightDeckPgChannelMessage;
    resolveTriggerMessageId?: FlightDeckTriggerResolver;
    createActivity?: (context: ConstructorParameters<typeof AgentActivityPublisher>[0]) => AgentActivityPublisher;
    publicationFilter?: DuplicateCallbackPublicationFilter;
    log?: Pick<Console, 'error'> }) {}

  accept(input: { session: SessionSnapshot; prompt: string; promptType: string; boundaryIdentity: string;
    sourceMessageIds?: string[]; acceptedAt?: string; turnId?: string; clientRequestId?: string }): FlightDeckSessionTurnRecord | null {
    if (input.session.metadata?.sessionClass !== 'flightdeck_chat') return null;
    resolveFlightDeckSessionBinding(input.session, this.deps.resolveDelivery(input.session));
    const turnId = input.turnId ?? buildFlightDeckSessionTurnId(input.session.id, input.boundaryIdentity);
    const existing = this.store.get(turnId);
    if (existing) return existing;
    const now = input.acceptedAt ?? new Date().toISOString();
    return this.store.save({ turnId, sessionId: input.session.id, prompt: input.prompt, promptType: input.promptType,
      sourceMessageIds: input.sourceMessageIds ?? [],
      triggerMessageId: input.sourceMessageIds?.at(-1) ?? this.deps.resolveTriggerMessageId?.(input.session) ?? null,
      clientRequestId: input.clientRequestId ?? `flightdeck-session-turn:${turnId}`,
      replyBody: null, finalMessageIdentity: null, replyCreatedAt: null, publishedMessageId: null, state: 'accepted', lastError: null,
      createdAt: now, updatedAt: now });
  }

  observe(record: FlightDeckSessionTurnRecord): void {
    if (record.state === 'completed') return;
    const prior = this.running.get(record.sessionId) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(async () => {
      const latest = this.store.get(record.turnId) ?? record;
      if (latest.state !== 'completed') await this.process(latest);
    }).finally(() => {
      if (this.running.get(record.sessionId) === work) this.running.delete(record.sessionId);
    });
    this.running.set(record.sessionId, work);
    void work.catch((error) => this.deps.log?.error('[flightdeck-turn] publication failed', {
      sessionId: record.sessionId, turnId: record.turnId, error: error instanceof Error ? error.message : String(error) }));
  }

  async publishKnownFinal(record: FlightDeckSessionTurnRecord, content: string, createdAt: string): Promise<string | null> {
    if (record.state === 'completed' || record.state === 'suppressed') return record.publishedMessageId;
    const ready = this.store.save({ ...record, replyBody: content, finalMessageIdentity: finalIdentity(content, createdAt),
      replyCreatedAt: createdAt, state: 'reply_ready', lastError: null, updatedAt: new Date().toISOString() });
    return await this.publish(ready);
  }

  recover(): void { for (const record of this.store.listRecoverable()) this.observe(record); }
  async waitForIdle(): Promise<void> { await Promise.all([...this.running.values()]); }

  private async process(record: FlightDeckSessionTurnRecord): Promise<void> {
    if (record.replyBody) { await this.publish(record); return; }
    const session = this.deps.manager.getSession(record.sessionId);
    if (!session) throw new Error(`Flight Deck turn ${record.turnId} cannot recover because session ${record.sessionId} is missing.`);
    const binding = resolveFlightDeckSessionBinding(session, this.deps.resolveDelivery(session));
    if (!binding) return;
    const triggerMessageId = record.triggerMessageId ?? record.sourceMessageIds.at(-1)
      ?? this.deps.resolveTriggerMessageId?.(session) ?? null;
    if (!triggerMessageId) {
      throw new Error(`Flight Deck turn ${record.turnId} has no valid trigger message in its bound thread.`);
    }
    if (triggerMessageId !== record.triggerMessageId) {
      record = this.store.save({ ...record, triggerMessageId, updatedAt: new Date().toISOString() });
    }
    const activity = (this.deps.createActivity ?? ((context) => new AgentActivityPublisher(context)))({
      ...binding, triggerMessageId,
      sessionId: session.id, turnId: record.turnId, startedAt: record.createdAt,
    });
    await this.publishActivity(record, 'accepted', () => activity.publish('accepted'));
    try {
      const reply = await awaitAcceptedFinalResponse(this.deps.manager, session.id, record.prompt, record.sourceMessageIds,
        { acceptedAt: record.createdAt,
          onPoll: () => this.publishActivity(record, 'commentary', () => activity.publishLatestCommentary(this.deps.manager)) });
      await this.publishKnownFinal(record, reply.content, reply.createdAt);
      await this.publishActivity(record, 'completed', () => activity.publish('completed'));
    } catch (error) {
      const latest = this.store.get(record.turnId) ?? record;
      this.store.save({ ...latest, state: 'failed', lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
      await this.publishActivity(record, 'failed', () => activity.publish('failed'));
      throw error;
    }
  }

  private async publishActivity(record: FlightDeckSessionTurnRecord, phase: string, publish: () => Promise<void>): Promise<void> {
    try {
      await publish();
    } catch (error) {
      this.deps.log?.error('[flightdeck-turn] transient activity publication failed', {
        sessionId: record.sessionId, turnId: record.turnId, phase,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async publish(record: FlightDeckSessionTurnRecord): Promise<string | null> {
    if (record.state === 'completed' || record.state === 'suppressed') return record.publishedMessageId;
    const session = this.deps.manager.getSession(record.sessionId);
    if (!session) throw new Error(`Flight Deck turn ${record.turnId} has no session ${record.sessionId}.`);
    const binding = resolveFlightDeckSessionBinding(session, this.deps.resolveDelivery(session));
    if (!binding || !record.replyBody) return null;
    const routingKey = buildDirectChatRoutingKey(binding);
    const candidateAt = record.replyCreatedAt ?? '';
    const evaluation = this.deps.publicationFilter?.evaluate({ decisionId: record.turnId, routingKey,
      subscriptionId: binding.subscriptionId, agentNpub: binding.agentNpub,
      body: record.replyBody, candidateAt });
    if (evaluation?.suppress) {
      this.store.save({ ...record, publishedMessageId: null, state: 'suppressed',
        lastError: 'duplicate_callback_within_window', updatedAt: new Date().toISOString() });
      return null;
    }
    const result = await (this.deps.publish ?? createFlightDeckPgChannelMessage)({ ...binding, body: record.replyBody,
      threadId: binding.threadId, clientRequestId: record.clientRequestId,
      metadata: { source: 'autopilot_session', session_id: record.sessionId, turn_id: record.turnId,
        prompt_type: record.promptType, source_message_ids: record.sourceMessageIds, agent_npub: binding.agentNpub } });
    const messageId = result.message?.id ?? null;
    const publishedAt = new Date().toISOString();
    if (messageId) this.deps.publicationFilter?.recordPublished({ decisionId: record.turnId, routingKey,
      candidateAt, publishedAt, publishedMessageId: messageId });
    this.store.save({ ...record, publishedMessageId: messageId, state: 'completed', lastError: null, updatedAt: publishedAt });
    return messageId;
  }

  private get store(): FlightDeckSessionTurnStore { return this.deps.store ?? flightDeckSessionTurnStore; }
}
