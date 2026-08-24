import { agentDefinitionStore, type AgentDefinitionStore } from './agent-definition-store';
import { chatInterceptStateStore, type ChatInterceptStateStore } from './chat-intercept-state-store';
import {
  buildFailureDiagnostic,
  buildSuccessDiagnostic,
  fetchRecordHistory,
} from './tower-client';
import type {
  AgentChatDiagnostic,
  AgentDefinitionRecord,
  ChatInterceptStateRecord,
  WorkspaceSubscriptionRecord,
  YokeWorkspaceSession,
} from './types';
import { loadYokeBotHelpers } from './yoke-bot-helpers';
import { decryptRecordPayloadWithYoke } from './yoke-record-payload';

interface RoutingContext {
  recordId: string;
  workspaceId?: string | null;
  channelId: string;
  scopeId?: string | null;
  threadId: string;
  participantNpubs: string[];
  mentionedNpubs?: string[];
  towerAccessVerified?: boolean;
}

export interface ChatDispatchRoutingContext extends RoutingContext {
  messageGroupNpubs: string[];
  senderNpub: string | null;
  updaterNpub: string | null;
}

export interface RoutedChatAssignment {
  agent: AgentDefinitionRecord;
  intercept: ChatInterceptStateRecord;
  scopeId: string | null;
}

export interface RoutingEvaluationDependencies {
  interceptStore?: ChatInterceptStateStore;
  agentStore?: AgentDefinitionStore;
  resolveRoutingContext?: (input: RoutingEvaluationInput) => Promise<RoutingContext>;
  extractMessageGroupNpubs?: (chatRecord: Record<string, unknown>, chatMessage: Record<string, unknown>) => string[];
}

export interface RoutingEvaluationInput {
  subscription: WorkspaceSubscriptionRecord;
  wsSession: YokeWorkspaceSession;
  groupKeys: unknown;
  chatRecordId: string;
  chatRecord: Record<string, unknown>;
  chatMessage: Record<string, unknown>;
}

export interface RoutingEvaluationResult {
  diagnostic: AgentChatDiagnostic;
  assignments: RoutedChatAssignment[];
}

export class AgentChatRoutingEvaluator {
  private readonly interceptStore: ChatInterceptStateStore;
  private readonly agentStore: AgentDefinitionStore;
  private readonly resolveRoutingContextOverride?: RoutingEvaluationDependencies['resolveRoutingContext'];
  private readonly extractMessageGroupNpubsOverride?: RoutingEvaluationDependencies['extractMessageGroupNpubs'];

  constructor(deps: RoutingEvaluationDependencies = {}) {
    this.interceptStore = deps.interceptStore ?? chatInterceptStateStore;
    this.agentStore = deps.agentStore ?? agentDefinitionStore;
    this.resolveRoutingContextOverride = deps.resolveRoutingContext;
    this.extractMessageGroupNpubsOverride = deps.extractMessageGroupNpubs;
  }

  listInterceptsForSubscription(subscriptionId: string): ChatInterceptStateRecord[] {
    return this.interceptStore.listBySubscriptionId(subscriptionId);
  }

  async buildDispatchContext(input: RoutingEvaluationInput): Promise<ChatDispatchRoutingContext> {
    const routingContext = this.resolveRoutingContextOverride
      ? await this.resolveRoutingContextOverride(input)
      : await this.resolveRoutingContext(input);
    const messageGroupNpubs = this.extractMessageGroupNpubsOverride
      ? this.extractMessageGroupNpubsOverride(input.chatRecord, input.chatMessage)
      : extractMessageGroupNpubs(input.chatRecord, input.chatMessage);
    const senderNpub = getOptionalString(input.chatMessage.sender_npub);
    const updaterNpub = getOptionalString(input.chatRecord.signature_npub)
      ?? getOptionalString(input.chatRecord.owner_npub);
    return {
      ...routingContext,
      messageGroupNpubs,
      senderNpub,
      updaterNpub,
    };
  }

  async evaluate(input: RoutingEvaluationInput): Promise<RoutingEvaluationResult> {
    let routingContext: ChatDispatchRoutingContext;
    try {
      routingContext = await this.buildDispatchContext(input);
    } catch (error) {
      const detailCode = this.getDetailCode(error, 'thread_unresolved');
      return {
        diagnostic: buildFailureDiagnostic(
          'thread_unresolved',
          error instanceof Error ? error.message : 'The chat message thread could not be resolved.',
          detailCode,
          {
            subscription_id: input.subscription.subscriptionId,
            record_id: input.chatRecordId,
            channel_id: input.chatMessage.channel_id ?? null,
            bot_npub: input.subscription.botNpub,
          },
        ),
        assignments: [],
      };
    }

    const configuredAgents = this.agentStore
      .listByWorkspaceAndBot(getEffectiveWorkspaceNpub(input.subscription), input.subscription.botNpub)
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const enabledAgents = configuredAgents.filter((agent) => agent.enabled);
    const candidateAgents = enabledAgents.filter((agent) => agent.capabilities.includes('chat_intercept'));
    const messageGroupNpubs = routingContext.messageGroupNpubs;
    const isFlightDeckPg = Boolean(input.subscription.workspaceId && input.subscription.workspaceServiceNpub);
    const mentionedNpubs = routingContext.mentionedNpubs ?? extractMentionedNpubs(input.chatMessage);
    const pgContextMatches = isFlightDeckPg
      && routingContext.towerAccessVerified === true
      && routingContext.workspaceId === input.subscription.workspaceId;
    const matchedAgents = candidateAgents.filter((agent) => (
      isFlightDeckPg
        ? pgContextMatches && mentionedNpubs.includes(agent.botNpub)
        : intersectsSorted(agent.groupNpubs, messageGroupNpubs)
    ));
    const senderNpub = routingContext.senderNpub;
    const updaterNpub = routingContext.updaterNpub;

    const selfSuppressedAgentIds: string[] = [];
    const duplicateSuppressedAgentIds: string[] = [];
    const assignments: RoutedChatAssignment[] = [];

    for (const agent of matchedAgents) {
      const isSelfAuthored = Boolean(
        (senderNpub && senderNpub === agent.botNpub)
        || (senderNpub && senderNpub === input.subscription.wsKeyNpub)
        || (updaterNpub && (updaterNpub === agent.botNpub || updaterNpub === input.subscription.wsKeyNpub))
      );
      if (isSelfAuthored) {
        selfSuppressedAgentIds.push(agent.agentId);
        continue;
      }

      const routingKey = buildCanonicalRoutingKey({
        subscriptionId: input.subscription.subscriptionId,
        workspaceOwnerNpub: getEffectiveWorkspaceNpub(input.subscription),
        sourceAppNpub: input.subscription.sourceAppNpub,
        channelId: routingContext.channelId,
        threadId: routingContext.threadId,
        agentId: agent.botNpub,
      });
      const legacyRoutingKey = buildLegacyRoutingKey({
        workspaceOwnerNpub: getEffectiveWorkspaceNpub(input.subscription),
        sourceAppNpub: input.subscription.sourceAppNpub,
        channelId: routingContext.channelId,
        threadId: routingContext.threadId,
        agentId: agent.agentId,
      });
      const upsertResult = this.interceptStore.upsertMessage({
        routingKey,
        legacyRoutingKey,
        subscriptionId: input.subscription.subscriptionId,
        agentId: agent.agentId,
        workspaceOwnerNpub: getEffectiveWorkspaceNpub(input.subscription),
        sourceAppNpub: input.subscription.sourceAppNpub,
        channelId: routingContext.channelId,
        threadId: routingContext.threadId,
        botNpub: agent.botNpub,
        messageId: routingContext.recordId,
      });
      if (upsertResult.wasDuplicate) {
        duplicateSuppressedAgentIds.push(agent.agentId);
        continue;
      }
      assignments.push({
        agent,
        intercept: upsertResult.record,
        scopeId: routingContext.scopeId ?? null,
      });
    }

    return {
      diagnostic: buildSuccessDiagnostic('Agent-first chat routing evaluated.', {
        subscription_id: input.subscription.subscriptionId,
        record_id: input.chatRecordId,
        channel_id: routingContext.channelId,
        scope_id: routingContext.scopeId ?? null,
        thread_id: routingContext.threadId,
        participant_npubs: routingContext.participantNpubs,
        message_group_npubs: messageGroupNpubs,
        mentioned_npubs: mentionedNpubs,
        flightdeck_pg: isFlightDeckPg,
        tower_access_verified: routingContext.towerAccessVerified ?? false,
        sender_npub: senderNpub,
        updater_npub: updaterNpub,
        configured_agent_ids: configuredAgents.map((agent) => agent.agentId),
        enabled_agent_ids: enabledAgents.map((agent) => agent.agentId),
        candidate_agent_ids: candidateAgents.map((agent) => agent.agentId),
        matched_agent_ids: matchedAgents.map((agent) => agent.agentId),
        self_suppressed_agent_ids: selfSuppressedAgentIds,
        duplicate_suppressed_agent_ids: duplicateSuppressedAgentIds,
        dispatched_agent_ids: assignments.map((assignment) => assignment.agent.agentId),
        routing_keys: assignments.map((assignment) => assignment.intercept.routingKey),
      }),
      assignments,
    };
  }

  private async resolveRoutingContext(input: RoutingEvaluationInput): Promise<RoutingContext> {
    const helpers = await loadYokeBotHelpers();
    const channelRecord = await this.fetchLatestRecordVersion(
      input.subscription.backendBaseUrl,
      getEffectiveWorkspaceNpub(input.subscription),
      this.getRequiredString(input.chatMessage.channel_id, 'channel_id'),
      input.wsSession,
    );
    const channelPayload = await decryptRecordPayloadWithYoke({
      record: channelRecord,
      wsSession: input.wsSession,
      groupKeys: input.groupKeys,
    });
    const lookupMap = await this.loadThreadLookup(input, helpers);
    const routingContext = helpers.normalizeChatRoutingContext(
      {
        chatMessage: input.chatMessage,
        channel: {
          record: channelRecord,
          payload: channelPayload,
        },
      },
      {
        lookupMessage: (messageId: string) => lookupMap.get(messageId) ?? null,
      },
    );
    return {
      recordId: this.getRequiredString(routingContext.record_id, 'record_id'),
      channelId: this.getRequiredString(routingContext.channel_id, 'channel_id'),
      scopeId: getScopeId(channelPayload),
      threadId: this.getRequiredString(routingContext.thread_id, 'thread_id'),
      participantNpubs: normaliseNpubList(routingContext.participant_npubs),
    };
  }

  private async loadThreadLookup(
    input: RoutingEvaluationInput,
    helpers: Awaited<ReturnType<typeof loadYokeBotHelpers>>,
  ): Promise<Map<string, Record<string, unknown>>> {
    const lookup = new Map<string, Record<string, unknown>>();
    const rootHint = getOptionalString(input.chatMessage.thread_id);
    if (rootHint) {
      return lookup;
    }

    const selfId = this.getRequiredString(input.chatMessage.record_id, 'record_id');
    let nextParentId = getOptionalString(input.chatMessage.parent_message_id);
    const seen = new Set([selfId]);

    while (nextParentId && !lookup.has(nextParentId)) {
      if (seen.has(nextParentId)) {
        break;
      }
      seen.add(nextParentId);

      try {
        const parentRecord = await this.fetchLatestRecordVersion(
          input.subscription.backendBaseUrl,
          getEffectiveWorkspaceNpub(input.subscription),
          nextParentId,
          input.wsSession,
        );
        const parentMessage = helpers.decryptChatRecord({
          record: parentRecord,
          wsSession: input.wsSession,
          groupKeys: input.groupKeys,
        });
        const parentRecordId = this.getRequiredString(parentMessage.record_id, 'parent record_id');
        lookup.set(parentRecordId, parentMessage);
        nextParentId = getOptionalString(parentMessage.parent_message_id);
      } catch {
        break;
      }
    }

    return lookup;
  }

  private async fetchLatestRecordVersion(
    backendBaseUrl: string,
    workspaceOwnerNpub: string,
    recordId: string,
    wsSession: YokeWorkspaceSession,
  ): Promise<Record<string, unknown>> {
    const versions = await fetchRecordHistory(
      backendBaseUrl,
      workspaceOwnerNpub,
      recordId,
      wsSession,
    );
    const latest = versions
      .slice()
      .sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
    if (!latest) {
      throw Object.assign(new Error(`Record ${recordId} not found.`), { detailCode: 'record_pull_not_found' });
    }
    return latest;
  }

  private getRequiredString(value: unknown, name: string): string {
    const stringValue = getOptionalString(value);
    if (!stringValue) {
      throw Object.assign(new Error(`Missing ${name}.`), { detailCode: 'thread_unresolved' });
    }
    return stringValue;
  }

  private getDetailCode(error: unknown, fallback: string): string {
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : null;
    if (code) {
      return code;
    }
    const detailCode = typeof (error as { detailCode?: unknown })?.detailCode === 'string'
      ? (error as { detailCode: string }).detailCode
      : null;
    return detailCode || fallback;
  }
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getEffectiveWorkspaceNpub(subscription: WorkspaceSubscriptionRecord): string {
  return subscription.workspaceServiceNpub?.trim() || subscription.workspaceOwnerNpub;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function normaliseNpubList(values: unknown): string[] {
  const set = new Set<string>();
  for (const value of getStringArray(values)) {
    set.add(value);
  }
  return [...set].sort();
}

function extractMentionedNpubs(message: Record<string, unknown>): string[] {
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {};
  const mentions = Array.isArray(message.mentions)
    ? message.mentions
    : Array.isArray(metadata.mentions) ? metadata.mentions : [];
  return [...new Set(mentions.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const npub = (entry as Record<string, unknown>).npub;
    return typeof npub === 'string' && npub.trim() ? [npub.trim()] : [];
  }))].sort();
}

function getScopeId(record: Record<string, unknown>): string | null {
  return getOptionalString(record.scope_id)
    ?? getOptionalString(record.scope_l5_id)
    ?? getOptionalString(record.scope_l4_id)
    ?? getOptionalString(record.scope_l3_id)
    ?? getOptionalString(record.scope_l2_id)
    ?? getOptionalString(record.scope_l1_id);
}

function intersectsSorted(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function extractMessageGroupNpubs(
  chatRecord: Record<string, unknown>,
  chatMessage: Record<string, unknown>,
): string[] {
  const set = new Set<string>();
  for (const value of getStringArray(chatMessage.group_npubs)) {
    set.add(value);
  }
  const directGroup = getOptionalString(chatMessage.group_npub);
  if (directGroup) {
    set.add(directGroup);
  }
  const groupPayloads = Array.isArray(chatRecord.group_payloads) ? chatRecord.group_payloads : [];
  for (const payload of groupPayloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const candidate = payload as Record<string, unknown>;
    const groupNpub = getOptionalString(candidate.group_npub)
      ?? getOptionalString(candidate.current_group_npub);
    if (groupNpub) {
      set.add(groupNpub);
    }
  }
  return [...set].sort();
}

export function buildCanonicalRoutingKey(input: {
  subscriptionId: string;
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  channelId: string;
  threadId: string;
  agentId: string;
}): string {
  return [
    'agent-chat',
    'v2',
    input.subscriptionId,
    input.workspaceOwnerNpub,
    input.sourceAppNpub,
    input.channelId,
    input.threadId,
    input.agentId,
  ].join(':');
}

export function buildLegacyRoutingKey(input: {
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  channelId: string;
  threadId: string;
  agentId: string;
}): string {
  return [
    input.workspaceOwnerNpub,
    input.sourceAppNpub,
    input.channelId,
    input.threadId,
    input.agentId,
  ].join('+');
}
