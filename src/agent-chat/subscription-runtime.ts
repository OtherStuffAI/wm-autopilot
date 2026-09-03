import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { nip19, verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { normaliseNpub } from '../identity/npub-utils';
import { generateBotKey } from '../identity/bot-key-manager';
import { createBrokeredAgentIdentity } from '../identity/brokered-agent-identity';
import type { BrokerKeyVaultBackend } from '../signing/broker-key-vault';
import { createSubscriptionBotIdentityResolver } from './subscription-bot-identity';
import {
  AgentWorkSessionRuntime,
  evaluateTaskDispatchEligibility,
  normaliseInboundApprovalRecord,
  normaliseInboundTaskRecord,
} from '../agent-work/session-runtime';
import { agentDefinitionStore, type AgentDefinitionStore } from './agent-definition-store';
import { AgentCommentSessionRuntime } from './comment-session-runtime';
import {
  isDocumentCommentTarget,
  isTaskCommentTarget,
  commentMentionsAgent,
  extractCommentGroupNpubs,
  normaliseInboundCommentRecord,
  selectDocumentCommentAgents,
} from './comment-records';
import {
  AgentCommentDispatchRuntime,
  agentCommentDispatchRuntime,
} from './comment-dispatch-runtime';
import {
  buildAgentConnectImportResult,
  validateAgentConnectPackage,
} from './agent-connect-import';
import { backendConnectionStore, type BackendConnectionStore } from './backend-connection-store';
import { AgentChatRoutingEvaluator } from './routing-evaluator';
import {
  type AgentProfileWorkspaceBundle,
  type AgentWorkspaceAppendedContextRecord,
  type AgentWorkspaceContextKind,
  type AgentWorkspaceEventPolicyRecord,
  type AgentWorkspaceEventType,
  type AgentWorkspacePipelineOverrideRecord,
  type AgentWorkspacePipelineOverrideTarget,
  type ResolvedAgentWorkspaceRuntimeSettings,
  type ResolvedAppendedContext,
  agentProfilePolicyStore,
  type AgentProfilePolicyStore,
} from './agent-profile-policy-store';
import type { DispatchPipelineRuntime, DispatchPipelineRuntimeResult } from './dispatch-pipelines/runtime';
import type { AgentChatSessionRuntime } from './session-runtime';
import type { TaskDirectRuntime } from './task-direct-runtime';
import { isTaskDirectEvent } from './task-direct-contract';
import type { DocumentDirectRuntime } from './document-direct-runtime';
import { isDocumentDirectEvent } from './document-direct-contract';
import { workspaceSubscriptionStore, type WorkspaceSubscriptionStore } from './workspace-subscription-store';
import type { DecodedAccessGrant, TowerRevocationVerificationResult } from '../access-grants/sbip0009';
import { parseSseEvents } from './sse-events';
import { chatInterceptStateStore } from './chat-intercept-state-store';
import {
  flightDeckDispatchOutcomeStore,
  type FlightDeckDispatchOutcomeStore,
} from './flightdeck-dispatch-outcome-store';
import {
  buildFlightDeckChatSourceLabel,
  sourceLabelForFlightDeckChat,
} from './flightdeck-dispatch-metadata';
import type { WingmanInstanceIdentity } from '../identity/wingman-instance-identity';
import type { SignedNostrEvent } from '../identity/bot-identity-publisher';
import {
  buildChatMessageFamilyHash,
  buildRecordFamilyHash,
  connectFlightDeckPgEventStream,
  decodeFlightDeckPgEventCursor,
  encodeFlightDeckPgEventCursor,
  buildFailureDiagnostic,
  buildStreamUrl,
  buildSuccessDiagnostic,
  checkBackendConnectionHealth,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgChannel,
  fetchFlightDeckPgWorkroomContext,
  fetchFlightDeckPgEvents,
  fetchFlightDeckPgWorkspaceMe,
  reconcileFlightDeckPgEventSubscriptionAgents,
  fetchWorkspaceKeyMappings,
  fetchRecordHistory,
  normaliseBackendBaseUrl,
  parseTowerError,
  registerWorkspaceKeyWithTower,
  type FlightDeckPgEvent,
  type FlightDeckPgMessage,
  type FlightDeckPgWorkroomContext,
} from './tower-client';
import { loadYokeBotHelpers } from './yoke-bot-helpers';
import { decryptRecordPayloadWithYoke } from './yoke-record-payload';
import { hydrateDirectChatThread, hydrateFlightDeckPgChatEvent } from './direct-chat-tower-hydration';
import { normaliseDirectChatMessage } from './direct-chat-contract';
import {
  DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
  normalisePromptTemplate,
} from './prompt-templates';
import type {
  AgentChatDispatchHistoryEntry,
  AgentChatSseEventDiagnostic,
  AgentCapability,
  AgentDefinitionRecord,
  BackendConnectionRecord,
  BotKeyStoreRecord,
  ChatInterceptStateRecord,
  CreateDispatchRouteInput,
  InboundApprovalRecord,
  CreateAgentDefinitionInput,
  CreateWorkspaceSubscriptionInput,
  DispatchRouteRecord,
  InboundCommentRecord,
  InboundTaskRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
  YokeWorkspaceSession,
} from './types';
import {
  FLIGHT_DECK_PG_EVENT_POLL_STALE_CODE,
  FlightDeckPgEventFreshnessWatchdog,
  resolveFlightDeckPgEventWatchdogTiming,
} from './flightdeck-pg-event-watchdog';
import {
  FLIGHT_DECK_PG_ACCESS_FAILED_CODE,
  FLIGHT_DECK_PG_ACCESS_RETRY_CODE,
  flightDeckPgReconnectDelayMs,
  isRetryableTowerAccessError,
} from './flightdeck-pg-access-recovery';

interface RuntimeContext {
  abortController: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  botIdentity: RuntimeBotIdentity;
  wsSession: YokeWorkspaceSession | null;
  groupKeys: unknown | null;
  wrappedKeyRows: unknown[];
  flightDeckPgActorId: string | null;
  removed: boolean;
}

type RuntimeFailureState = 'blocked_auth' | 'blocked_decrypt' | null;
const MAX_RECENT_SSE_EVENTS = 100;
const MAX_RECENT_DISPATCHES = 10;
const CHAT_ADVISORY_RECORD_PULL_TIMEOUT_MS = 30_000;
const CHAT_ADVISORY_RECORD_PULL_MAX_ATTEMPTS = 3;
const CHAT_ADVISORY_RECORD_PULL_RETRY_DELAY_MS = 1_000;
const CHAT_ADVISORY_DECRYPT_TIMEOUT_MS = 15_000;
const CHAT_ADVISORY_ROUTING_TIMEOUT_MS = 20_000;
const CHAT_ADVISORY_PIPELINE_TIMEOUT_MS = 60_000;
const WORKSPACE_KEY_MAPPING_CACHE_MS = 30_000;
const FLIGHT_DECK_PG_EVENT_POLL_INTERVAL_MS = 2_100;
const FLIGHT_DECK_PG_EVENT_POLL_TIMEOUT_MS = 10_000;
const FLIGHT_DECK_PG_EVENT_RECONNECT_BASE_MS = 1_000;
const FLIGHT_DECK_PG_EVENT_RECONNECT_MAX_MS = 60_000;
const AGENT_INSTRUCTION_SIGNATURE_METADATA_KEY = 'agent_instruction_signature';
const AGENT_INSTRUCTION_SIGNATURE_PROTOCOL = 'flightdeck_pg_message_instruction';
const AGENT_INSTRUCTION_SIGNATURE_KIND = 33358;
const DEFAULT_33357_AGENT_CAPABILITIES: AgentCapability[] = [
  'chat_intercept',
  'task_dispatch',
  'comment_dispatch',
];

const DEFAULT_DISPATCH_PIPELINE_ROUTES: Array<{
  triggerKind: CreateDispatchRouteInput['triggerKind'];
  capability: CreateDispatchRouteInput['capability'];
  pipelineDefinitionId: string;
  pipelineVersionPolicy?: CreateDispatchRouteInput['pipelineVersionPolicy'];
  flightDeckPgPipelineDefinitionId?: string;
}> = [
  {
    triggerKind: 'chat',
    capability: 'chat_intercept',
    pipelineDefinitionId: 'fd-agent-dispatch-chat',
    pipelineVersionPolicy: 'latest',
  },
  {
    triggerKind: 'task',
    capability: 'task_dispatch',
    pipelineDefinitionId: 'fd-agent-dispatch-task-response',
    pipelineVersionPolicy: 'latest',
  },
  {
    triggerKind: 'comment',
    capability: 'comment_dispatch',
    pipelineDefinitionId: 'fd-agent-dispatch-comment-response',
    pipelineVersionPolicy: 'latest',
  },
];

function getDefaultDispatchPipelineDefinitionId(
  subscription: WorkspaceSubscriptionRecord,
  routeConfig: (typeof DEFAULT_DISPATCH_PIPELINE_ROUTES)[number],
): string {
  return routeConfig.pipelineDefinitionId;
}

export class WorkspaceSubscriptionAccessError extends Error {
  readonly statusCode = 403;
  readonly code = 'backend_connection_forbidden';
}

export class BackendConnectionNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'backend_connection_not_found';
}

function trimRecentEntries<T>(entries: T[], max: number): T[] {
  return entries.slice(-max);
}

function getOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getOptionalTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

async function resolveWorkroomContextForChat(input: {
  record: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  channelId: string | null;
  threadId: string | null;
  actorNpub: string | null;
  fetchContext?: typeof fetchFlightDeckPgWorkroomContext;
}): Promise<FlightDeckPgWorkroomContext> {
  if (!input.record.workspaceId || !input.channelId || !input.threadId) {
    return { isWorkroom: false, workroom: null, participant: null, appTargets: [], recentEvents: [], recentLinks: [], openApprovals: [] };
  }
  try {
    return await (input.fetchContext ?? fetchFlightDeckPgWorkroomContext)({
      backendBaseUrl: input.record.backendBaseUrl,
      workspaceId: input.record.workspaceId,
      channelId: input.channelId,
      threadId: input.threadId,
      actorNpub: input.actorNpub,
      appNpub: input.record.sourceAppNpub,
      botIdentity: input.botIdentity,
    });
  } catch (error) {
    // A Tower deployment may not have the companion route yet. Network-level
    // absence is compatible with ordinary chat; authenticated HTTP failures
    // remain visible so a real workroom lookup problem is not hidden.
    if (error instanceof TypeError) {
      return { isWorkroom: false, workroom: null, participant: null, appTargets: [], recentEvents: [], recentLinks: [], openApprovals: [] };
    }
    throw error;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function getNostrTagValue(event: NostrEvent, tagName: string): string | null {
  const tag = event.tags.find((entry) => entry[0] === tagName);
  return getOptionalText(tag?.[1]);
}

function isNostrEventLike(value: unknown): value is NostrEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<NostrEvent>;
  return typeof candidate.id === 'string'
    && typeof candidate.pubkey === 'string'
    && typeof candidate.created_at === 'number'
    && typeof candidate.kind === 'number'
    && Array.isArray(candidate.tags)
    && typeof candidate.content === 'string'
    && typeof candidate.sig === 'string';
}

function verifyFlightDeckPgInstructionSignature(input: {
  signature: unknown;
  body: string;
  actorNpub: string | null;
  workspaceId: string | null;
  channelId: string | null;
  threadId: string | null;
}): { ok: boolean; reason: string; signerNpub: string | null } {
  const wrapper = input.signature && typeof input.signature === 'object' && !Array.isArray(input.signature)
    ? input.signature as Record<string, unknown>
    : null;
  if (!wrapper) {
    return { ok: false, reason: 'missing_instruction_signature', signerNpub: null };
  }
  const event = isNostrEventLike(wrapper.nostr_event) ? wrapper.nostr_event : null;
  if (!event) {
    return { ok: false, reason: 'invalid_instruction_signature_event', signerNpub: null };
  }
  const signerNpub = nip19.npubEncode(event.pubkey);
  const bodySha256 = sha256Hex(input.body);
  if (wrapper.version !== 1) {
    return { ok: false, reason: 'unsupported_instruction_signature_version', signerNpub };
  }
  if (event.kind !== AGENT_INSTRUCTION_SIGNATURE_KIND) {
    return { ok: false, reason: 'invalid_instruction_signature_kind', signerNpub };
  }
  if (getNostrTagValue(event, 'protocol') !== AGENT_INSTRUCTION_SIGNATURE_PROTOCOL) {
    return { ok: false, reason: 'invalid_instruction_signature_protocol', signerNpub };
  }
  if (!verifyEvent(event)) {
    return { ok: false, reason: 'invalid_instruction_signature', signerNpub };
  }
  if (event.content !== input.body) {
    return { ok: false, reason: 'instruction_body_mismatch', signerNpub };
  }
  if (wrapper.body_sha256 !== bodySha256 || getNostrTagValue(event, 'body_sha256') !== bodySha256) {
    return { ok: false, reason: 'instruction_body_hash_mismatch', signerNpub };
  }
  if (!input.actorNpub || signerNpub !== input.actorNpub || wrapper.signer_npub !== input.actorNpub) {
    return { ok: false, reason: 'instruction_signer_mismatch', signerNpub };
  }
  if (input.workspaceId && getNostrTagValue(event, 'workspace_id') !== input.workspaceId) {
    return { ok: false, reason: 'instruction_workspace_mismatch', signerNpub };
  }
  if (input.channelId && getNostrTagValue(event, 'channel_id') !== input.channelId) {
    return { ok: false, reason: 'instruction_channel_mismatch', signerNpub };
  }
  const signatureThreadId = getNostrTagValue(event, 'thread_id');
  if (signatureThreadId && input.threadId && signatureThreadId !== input.threadId) {
    return { ok: false, reason: 'instruction_thread_mismatch', signerNpub };
  }
  return { ok: true, reason: 'verified', signerNpub };
}

function safeJsonParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function defaultActionForEventType(eventType: AgentWorkspaceEventType) {
  if (eventType === 'task_assigned' || eventType === 'task_invocation' || eventType === 'document_invocation') return 'work';
  if (eventType === 'task_comment' || eventType === 'document_comment_tagged') return 'respond';
  if (eventType === 'approval_assigned') return 'notify';
  if (eventType === 'flow_step_assigned') return 'run_flow_handler';
  if (eventType === 'document_created') return 'index';
  if (eventType === 'chat_observe' || eventType === 'document_comment_observe') return 'observe';
  return eventType === 'direct_message' || eventType === 'chat_mention' ? 'respond' : 'ignore';
}

function profilePolicyAllowsDispatch(decision: AgentProfileRuntimeDecision | null): boolean {
  if (!decision) {
    return true;
  }
  const policy = decision.settings.policy;
  if (policy?.enabled === false || policy?.quietMode === true) {
    return false;
  }
  const action = policy?.defaultAction ?? defaultActionForEventType(decision.eventType);
  return action !== 'ignore' && action !== 'observe' && action !== 'index';
}

function flightDeckPgChatTargetsAgent(input: {
  message: FlightDeckPgMessage;
  botNpub: string;
  profileDecision: AgentProfileRuntimeDecision | null;
}): { eligible: boolean; reason: string; mentionedNpubs: string[] } {
  const mentionedNpubs = [...new Set(normaliseDirectChatMessage(input.message).mentions
    .map((mention) => mention.npub?.trim() ?? '')
    .filter(Boolean))].sort();
  if (mentionedNpubs.length > 0) {
    return {
      eligible: mentionedNpubs.includes(input.botNpub),
      reason: mentionedNpubs.includes(input.botNpub) ? 'explicit_agent_mention' : 'different_agent_mentioned',
      mentionedNpubs,
    };
  }
  const source = input.profileDecision?.settings.pipeline.source;
  const participatesByStableContext = source === 'channel_override' || source === 'scope_override';
  return {
    eligible: participatesByStableContext,
    reason: participatesByStableContext ? `${source}_participation` : 'mention_or_channel_policy_required',
    mentionedNpubs,
  };
}

function isRevokedWorkspaceSubscription(record: WorkspaceSubscriptionRecord): boolean {
  return record.wsKeyStatus === 'revoked'
    || (!isFlightDeckPgSubscription(record) && record.groupKeyStatus === 'revoked')
    || record.lastErrorCode === 'workspace_access_revoked';
}

function isFlightDeckPgSubscription(record: WorkspaceSubscriptionRecord): boolean {
  return Boolean(record.workspaceId && record.workspaceServiceNpub);
}

function isFlightDeckPgMessageRevisionEvent(event: FlightDeckPgEvent): boolean {
  return event.event_type === 'flightdeck_pg.message.revised'
    || event.payload?.event_type === 'message.revised';
}

function normaliseFlightDeckPgChatPayload(
  message: FlightDeckPgMessage,
  event: FlightDeckPgEvent,
): Record<string, unknown> {
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata
    : {};
  const eventPayload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const senderNpub = getOptionalText(metadata.sender_npub)
    ?? getOptionalText(message.sender_npub)
    ?? getOptionalText(message.created_by_actor_npub)
    ?? getOptionalText(eventPayload.sender_npub)
    ?? getOptionalText(eventPayload.actor_npub);
  return {
    id: message.id,
    record_id: message.id,
    body: message.body ?? '',
    message_signature: metadata[AGENT_INSTRUCTION_SIGNATURE_METADATA_KEY] ?? null,
    sender_npub: senderNpub,
    sender_actor_id: message.created_by_actor_id ?? event.actor_id ?? null,
    actor_id: event.actor_id ?? message.created_by_actor_id ?? null,
    channel_id: message.channel_id ?? event.channel_id ?? null,
    scope_id: message.scope_id ?? event.scope_id ?? null,
    thread_id: message.thread_id ?? message.thread_source_message_id ?? message.id,
    parent_message_id: message.thread_id ?? null,
    row_version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
    version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
    created_at: message.created_at ?? event.created_at ?? event.timestamp ?? null,
    updated_at: message.updated_at ?? event.created_at ?? event.timestamp ?? null,
    metadata,
    flightdeck_pg_event: {
      id: event.event_id ?? event.id ?? null,
      event_type: event.event_type ?? null,
      entity_type: event.entity_type ?? null,
      operation: event.operation ?? null,
      cursor: event.cursor ?? null,
    },
  };
}

function normaliseFlightDeckPgInvocationPayload(event: FlightDeckPgEvent): {
  invocationId: string | null;
  prompt: string;
  status: string | null;
  recipients: Array<Record<string, unknown>>;
  targets: Array<Record<string, unknown>>;
  target: Record<string, unknown> | null;
  targetType: string | null;
  targetId: string | null;
  targetTitle: string | null;
  actorNpub: string | null;
  scopeId: string | null;
  channelId: string | null;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const eventPayload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  const recipients = Array.isArray(eventPayload.recipients)
    ? eventPayload.recipients.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
  const targets = Array.isArray(eventPayload.targets)
    ? eventPayload.targets.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
  const target = targets[0] ?? null;
  const metadata = eventPayload.metadata && typeof eventPayload.metadata === 'object' && !Array.isArray(eventPayload.metadata)
    ? eventPayload.metadata as Record<string, unknown>
    : {};
  const targetType = getOptionalText(target?.type) ?? getOptionalText(eventPayload.target_type);
  const targetId = getOptionalText(target?.id) ?? getOptionalText(target?.target_id) ?? getOptionalText(eventPayload.target_id);
  const targetTitle = getOptionalText(target?.title) ?? getOptionalText(metadata.target_title);
  const prompt = getOptionalText(eventPayload.prompt) ?? '';
  const scopeId = getOptionalText(event.scope_id) ?? getOptionalText(eventPayload.scope_id);
  const channelId = getOptionalText(event.channel_id) ?? getOptionalText(eventPayload.channel_id);
  const actorNpub = getOptionalText(eventPayload.created_by_npub) ?? getOptionalText(eventPayload.actor_npub);
  const invocationId = getOptionalText(eventPayload.invocation_id) ?? getOptionalText(event.entity_id);

  return {
    invocationId,
    prompt,
    status: getOptionalText(eventPayload.status),
    recipients,
    targets,
    target,
    targetType,
    targetId,
    targetTitle,
    actorNpub,
    scopeId,
    channelId,
    metadata,
    payload: {
      id: invocationId,
      record_id: invocationId,
      invocation_id: invocationId,
      prompt,
      status: getOptionalText(eventPayload.status),
      recipients,
      targets,
      target,
      target_type: targetType,
      target_id: targetId,
      target_title: targetTitle,
      task_id: targetType === 'task' ? targetId : null,
      title: targetTitle ?? (targetType === 'task' ? 'Invoked task' : 'Invoked document'),
      description: prompt,
      state: 'invoked',
      scope_id: scopeId,
      channel_id: channelId,
      created_by_npub: actorNpub,
      metadata,
      flightdeck_pg_event: {
        id: event.event_id ?? event.id ?? null,
        event_type: event.event_type ?? null,
        entity_type: event.entity_type ?? null,
        operation: event.operation ?? null,
        cursor: event.cursor ?? null,
      },
    },
  };
}

function flightDeckPgInvocationTargetsBot(recipients: Array<Record<string, unknown>>, botNpub: string | null | undefined): boolean {
  const cleanBotNpub = getOptionalText(botNpub);
  if (!cleanBotNpub) return false;
  return recipients.some((recipient) => {
    const type = getOptionalText(recipient.type);
    const npub = firstNpub(getOptionalText(recipient.npub), getOptionalText(recipient.agent_npub));
    return type === 'agent' && npub === cleanBotNpub;
  });
}

function profilePolicyAllowsLegacyPrompt(decision: AgentProfileRuntimeDecision | null): boolean {
  if (!profilePolicyAllowsDispatch(decision)) {
    return false;
  }
  const action = decision?.settings.policy?.defaultAction ?? (decision ? defaultActionForEventType(decision.eventType) : 'respond');
  return action === 'respond' || action === 'work' || action === 'process' || action === 'run_flow_handler';
}

function formatResolvedProfileRuntimeContext(contexts: ResolvedAppendedContext[]): string | null {
  const rows = contexts
    .map((context) => {
      const text = getOptionalText(context.contextText);
      if (!text) {
        return null;
      }
      const target = context.targetId ? ` ${context.targetId}` : '';
      const event = context.eventType ? ` ${context.eventType}` : '';
      return `[${context.kind}${target}${event}]\n${text}`;
    })
    .filter((row): row is string => Boolean(row));
  return rows.length > 0 ? rows.join('\n\n') : null;
}

function getTaskScopeId(task: InboundTaskRecord): string | null {
  return task.scopeId ?? task.scopeL5Id ?? task.scopeL4Id ?? task.scopeL3Id ?? task.scopeL2Id ?? task.scopeL1Id;
}

function eventTypeForTaskDispatchMode(mode: TaskDispatchMode): AgentWorkspaceEventType {
  if (mode === 'flow_dispatch') {
    return 'flow_step_assigned';
  }
  return 'task_assigned';
}

function getRecordUpdaterNpub(record: Record<string, unknown>): string | null {
  return getOptionalText(record.signature_npub)
    ?? getOptionalText(record.owner_npub);
}

function isSelfUpdater(subscription: WorkspaceSubscriptionRecord, agent: AgentDefinitionRecord, updaterNpub: string | null): boolean {
  if (!updaterNpub) {
    return false;
  }
  return updaterNpub === agent.botNpub || updaterNpub === subscription.wsKeyNpub;
}

function isSelfCommentEvent(
  subscription: WorkspaceSubscriptionRecord,
  comment: InboundCommentRecord,
  updaterNpub: string | null,
): boolean {
  const selfNpubs = new Set([subscription.botNpub, subscription.wsKeyNpub].filter((value): value is string => Boolean(value)));
  return Boolean(
    (updaterNpub && selfNpubs.has(updaterNpub))
    || (comment.senderNpub && selfNpubs.has(comment.senderNpub)),
  );
}

function isSelfCommentAuthor(
  subscription: WorkspaceSubscriptionRecord,
  agent: AgentDefinitionRecord,
  comment: InboundCommentRecord,
  updaterNpub: string | null,
): boolean {
  if (isSelfUpdater(subscription, agent, updaterNpub) || isSelfCommentEvent(subscription, comment, updaterNpub)) {
    return true;
  }
  return Boolean(comment.senderNpub && comment.senderNpub === agent.botNpub);
}

function isManagerAuthoredComment(
  subscription: WorkspaceSubscriptionRecord,
  comment: InboundCommentRecord,
  updaterNpub: string | null,
): boolean {
  const managerNpub = subscription.managedByNpub;
  if (!managerNpub) {
    return false;
  }
  return updaterNpub === managerNpub || comment.senderNpub === managerNpub;
}

function firstNpub(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normaliseNpub(value ?? null);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function getRecordUpdatedAtMs(record: Record<string, unknown> | null | undefined): number | null {
  return parseTimestampMs(record?.updated_at)
    ?? parseTimestampMs(record?.updatedAt);
}

function shouldSkipExistingCommentAdvisory(
  subscription: WorkspaceSubscriptionRecord,
  record: Record<string, unknown> | null | undefined,
): boolean {
  const startupReloadAt = parseTimestampMs(subscription.lastSuccessfulStartupReloadAt);
  const recordUpdatedAt = getRecordUpdatedAtMs(record);
  return startupReloadAt != null && recordUpdatedAt != null && recordUpdatedAt <= startupReloadAt;
}

interface TaskDispatchSnapshot {
  title: string;
  description: string | null;
  assignedTo: string | null;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: string | null;
  scopeId: string | null;
  scopeL1Id: string | null;
  scopeL2Id: string | null;
  scopeL3Id: string | null;
  scopeL4Id: string | null;
  scopeL5Id: string | null;
  predecessorTaskIds: string[];
}

function buildTaskDispatchSnapshot(task: InboundTaskRecord): TaskDispatchSnapshot {
  return {
    title: task.title.trim(),
    description: task.description?.trim() || null,
    assignedTo: task.assignedTo,
    flowId: task.flowId,
    flowRunId: task.flowRunId,
    flowStep: task.flowStep,
    scopeId: task.scopeId,
    scopeL1Id: task.scopeL1Id,
    scopeL2Id: task.scopeL2Id,
    scopeL3Id: task.scopeL3Id,
    scopeL4Id: task.scopeL4Id,
    scopeL5Id: task.scopeL5Id,
    predecessorTaskIds: [...task.predecessorTaskIds].sort(),
  };
}

function diffTaskDispatchSnapshots(
  current: TaskDispatchSnapshot,
  previous: TaskDispatchSnapshot | null,
): string[] {
  if (!previous) {
    return ['new_task'];
  }
  const changed: string[] = [];
  const entries: Array<[keyof TaskDispatchSnapshot, unknown, unknown]> = [
    ['title', current.title, previous.title],
    ['description', current.description, previous.description],
    ['assignedTo', current.assignedTo, previous.assignedTo],
    ['flowId', current.flowId, previous.flowId],
    ['flowRunId', current.flowRunId, previous.flowRunId],
    ['flowStep', current.flowStep, previous.flowStep],
    ['scopeId', current.scopeId, previous.scopeId],
    ['scopeL1Id', current.scopeL1Id, previous.scopeL1Id],
    ['scopeL2Id', current.scopeL2Id, previous.scopeL2Id],
    ['scopeL3Id', current.scopeL3Id, previous.scopeL3Id],
    ['scopeL4Id', current.scopeL4Id, previous.scopeL4Id],
    ['scopeL5Id', current.scopeL5Id, previous.scopeL5Id],
    ['predecessorTaskIds', current.predecessorTaskIds.join('|'), previous.predecessorTaskIds.join('|')],
  ];
  for (const [key, left, right] of entries) {
    if (left !== right) {
      changed.push(String(key));
    }
  }
  return changed;
}

type TaskDispatchMode = 'task_dispatch' | 'flow_dispatch' | 'task_review';
type TaskDispatchEligibility =
  | 'dispatch'
  | 'skip_terminal'
  | 'skip_assignment'
  | 'skip_not_ready'
  | 'skip_not_kickoff'
  | 'skip_not_review';

interface AgentProfileRuntimeDecision {
  profileWorkspaceId: string;
  eventType: AgentWorkspaceEventType;
  settings: ResolvedAgentWorkspaceRuntimeSettings;
  contextText: string | null;
}

const TERMINAL_TASK_STATES = new Set([
  'done',
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'archived',
  'deleted',
]);

function normaliseTaskIdentity(value: string | null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function decodeNpubToHex(npub: string | null): string | null {
  if (!npub) {
    return null;
  }
  try {
    const decoded = nip19.decode(npub);
    return decoded.type === 'npub' && typeof decoded.data === 'string' ? decoded.data.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isAssignedToAgent(task: InboundTaskRecord, agent: AgentDefinitionRecord): boolean {
  const assignedTo = normaliseTaskIdentity(task.assignedTo);
  if (!assignedTo) {
    return false;
  }
  return assignedTo === normaliseTaskIdentity(agent.botNpub) || assignedTo === decodeNpubToHex(agent.botNpub);
}

function isTerminalTask(task: InboundTaskRecord, recordState: string | null): boolean {
  if (recordState === 'deleted' || task.deleted || task.done) {
    return true;
  }
  return Boolean(task.state && TERMINAL_TASK_STATES.has(task.state));
}

function resolveTaskDispatchMode(task: InboundTaskRecord): TaskDispatchMode {
  if (task.state === 'new' && task.flowId && !task.flowRunId) {
    return 'flow_dispatch';
  }
  if (task.state === 'review') {
    return 'task_review';
  }
  return 'task_dispatch';
}

function dispatchModeToTriggerKind(mode: TaskDispatchMode): CreateDispatchRouteInput['triggerKind'] {
  if (mode === 'flow_dispatch') {
    return 'flow';
  }
  if (mode === 'task_review') {
    return 'task_review';
  }
  return 'task';
}

function dispatchModeToHistoryKind(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['kind'] {
  if (mode === 'flow_dispatch') {
    return 'flow';
  }
  if (mode === 'task_review') {
    return 'review';
  }
  return 'task';
}

function dispatchModeToBindingId(mode: TaskDispatchMode, task: InboundTaskRecord): string {
  if (mode === 'flow_dispatch') {
    return task.taskId;
  }
  return task.flowRunId ?? task.taskId;
}

function dispatchModeToBindingType(mode: TaskDispatchMode, task: InboundTaskRecord): AgentChatDispatchHistoryEntry['bindingType'] {
  return mode === 'task_dispatch' && task.flowRunId ? 'flow_run' : 'task';
}

function dispatchModeToAction(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['action'] {
  if (mode === 'flow_dispatch') {
    return 'flow_dispatch';
  }
  if (mode === 'task_review') {
    return 'task_review';
  }
  return 'task_dispatch';
}

function dispatchModeToSelfSkipAction(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['action'] {
  if (mode === 'flow_dispatch') {
    return 'flow_dispatch_skip_self_update';
  }
  if (mode === 'task_review') {
    return 'task_review_skip_self_update';
  }
  return 'task_skip_self_update';
}

function dispatchModeToNullSkipAction(mode: TaskDispatchMode): AgentChatDispatchHistoryEntry['action'] {
  if (mode === 'flow_dispatch') {
    return 'flow_dispatch_skip_runtime_returned_null';
  }
  if (mode === 'task_review') {
    return 'task_review_skip_runtime_returned_null';
  }
  return 'task_skip_runtime_returned_null';
}

function evaluateTaskPipelineEligibility(input: {
  task: InboundTaskRecord;
  recordState: string | null;
  mode: TaskDispatchMode;
  agent: AgentDefinitionRecord;
}): TaskDispatchEligibility {
  if (isTerminalTask(input.task, input.recordState)) {
    return 'skip_terminal';
  }
  if (!isAssignedToAgent(input.task, input.agent)) {
    return 'skip_assignment';
  }
  if (input.mode === 'flow_dispatch') {
    return input.task.state === 'new' && Boolean(input.task.flowId) && !input.task.flowRunId
      ? 'dispatch'
      : 'skip_not_kickoff';
  }
  if (input.mode === 'task_review') {
    return input.task.state === 'review' ? 'dispatch' : 'skip_not_review';
  }
  return evaluateTaskDispatchEligibility(input);
}

export interface WorkspaceSubscriptionManagerDependencies {
  store?: WorkspaceSubscriptionStore;
  agentStore?: AgentDefinitionStore;
  backendStore?: BackendConnectionStore;
  profilePolicyStore?: AgentProfilePolicyStore;
  dispatchOutcomeStore?: Pick<FlightDeckDispatchOutcomeStore, 'recordHistory' | 'listPage'>;
  routingEvaluator?: AgentChatRoutingEvaluator;
  chatRuntime?: AgentChatSessionRuntime | null;
  taskDirectRuntime?: TaskDirectRuntime | null;
  documentDirectRuntime?: DocumentDirectRuntime | null;
  agentWorkRuntime?: AgentWorkSessionRuntime | null;
  agentCommentRuntime?: AgentCommentSessionRuntime | null;
  commentDispatchRuntime?: AgentCommentDispatchRuntime | null;
  dispatchPipelineRuntime?: DispatchPipelineRuntime | null;
  fetchRecordHistory?: typeof fetchRecordHistory;
  fetchWorkspaceKeyMappings?: typeof fetchWorkspaceKeyMappings;
  fetchFlightDeckPgWorkspaceMe?: typeof fetchFlightDeckPgWorkspaceMe;
  fetchFlightDeckPgEvents?: typeof fetchFlightDeckPgEvents;
  connectFlightDeckPgEventStream?: typeof connectFlightDeckPgEventStream;
  reconcileFlightDeckPgEventSubscriptionAgents?: typeof reconcileFlightDeckPgEventSubscriptionAgents;
  fetchFlightDeckPgChannelMessages?: typeof fetchFlightDeckPgChannelMessages;
  fetchFlightDeckPgChannel?: typeof fetchFlightDeckPgChannel;
  fetchFlightDeckPgWorkroomContext?: typeof fetchFlightDeckPgWorkroomContext;
  decryptRecordPayload?: typeof decryptRecordPayloadWithYoke;
  checkBackendHealth?: typeof checkBackendConnectionHealth;
  flightDeckPgEventPollIntervalMs?: number;
  flightDeckPgEventPollTimeoutMs?: number;
  flightDeckPgEventReconnectBaseMs?: number;
  flightDeckPgEventReconnectMaxMs?: number;
  flightDeckPgEventPollFreshnessThresholdMs?: number;
  flightDeckPgEventPollStartupGraceMs?: number;
  flightDeckPgEventPollWatchdogIntervalMs?: number;
  chatRecordPullTimeoutMs?: number;
  chatRecordPullMaxAttempts?: number;
  chatRecordPullRetryDelayMs?: number;
  dispatchAgentWorkingDirectory?: string;
  isAuthorizedDispatchActorNpub?: (npub: string) => boolean;
  validateWorkingDirectory?: (directory: string) => Promise<string>;
  botKeyStore: {
    getActiveKeyForUser: (npub: string) => BotKeyStoreRecord | null;
    getActiveKeyForBotNpub: (botNpub: string) => BotKeyStoreRecord | null;
    createKey?: (input: {
      userNpub: string;
      botPubkeyHex: string;
      botNpub: string;
      displayName: string;
      encryptedToUser: string;
      encryptedEscrow: string;
      escrowUuid: string;
    }) => BotKeyStoreRecord;
    deactivateKey?: (id: string) => void;
    deleteKey?: (id: string) => void;
  };
  brokerKeyVault?: Pick<BrokerKeyVaultBackend, 'provision' | 'remove' | 'withKey'>;
  getInstanceIdentity?: () => WingmanInstanceIdentity | null;
}

export type AgentProfileCreationFailureStage = 'vault' | 'persistence';

export class AgentProfileCreationError extends Error {
  readonly code: string;

  constructor(readonly stage: AgentProfileCreationFailureStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Agent profile ${stage} failed: ${detail}`, { cause });
    this.name = 'AgentProfileCreationError';
    this.code = `agent_profile_${stage}_failed`;
  }
}

export type AgentProfileDeletionKeyDisposition =
  | 'deleted_from_vault'
  | 'deactivated_in_vault'
  | 'env_configuration_retained'
  | 'instance_identity_retained';

export interface AgentProfileDeletionResult {
  agent: AgentDefinitionRecord;
  keyDisposition: AgentProfileDeletionKeyDisposition;
}

function getErrorDetailCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const detailCode = (error as { detailCode?: unknown }).detailCode;
  return typeof detailCode === 'string' && detailCode.trim().length > 0 ? detailCode.trim() : null;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  detailCode: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(Object.assign(new Error(`${detailCode} after ${timeoutMs}ms`), { detailCode }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function mapFailureState(detailCode: string | null): RuntimeFailureState {
  switch (detailCode) {
    case 'workspace_key_register_failed':
    case 'workspace_auth_failed':
    case 'workspace_key_missing':
    case 'workspace_access_denied':
    case 'workspace_key_revoked':
    case 'workspace_key_invalid':
    case 'sse_stream_forbidden':
      return 'blocked_auth';
    case 'record_pull_forbidden':
    case 'group_membership_revoked':
    case 'group_key_epoch_stale':
    case 'group_key_missing':
    case 'record_decrypt_failed':
      return 'blocked_decrypt';
    default:
      return null;
  }
}

function canUseBackendConnection(
  record: BackendConnectionRecord,
  managedByNpub: string,
  backendStore: BackendConnectionStore,
  grantKind: CreateWorkspaceSubscriptionInput['backendConnectionGrantKind'] = null,
): boolean {
  if (record.managedByNpub === managedByNpub) {
    return true;
  }

  if (record.sharePolicy === 'selected_users') {
    return backendStore.hasManagerGrant(record.backendConnectionId, managedByNpub);
  }

  if (record.sharePolicy === 'shared_service') {
    return grantKind === 'shared_service'
      && backendStore.hasSharedServiceGrant(record.backendConnectionId);
  }

  return false;
}

export class WorkspaceSubscriptionManager {
  private readonly store: WorkspaceSubscriptionStore;
  private readonly agentStore: AgentDefinitionStore;
  private readonly backendStore: BackendConnectionStore;
  private readonly profilePolicyStore: AgentProfilePolicyStore;
  private readonly dispatchOutcomeStore: Pick<FlightDeckDispatchOutcomeStore, 'recordHistory' | 'listPage'>;
  private readonly routingEvaluator: AgentChatRoutingEvaluator;
  private readonly botKeyStore: WorkspaceSubscriptionManagerDependencies['botKeyStore'];
  private readonly brokerKeyVault: WorkspaceSubscriptionManagerDependencies['brokerKeyVault'];
  private readonly getInstanceIdentity: () => WingmanInstanceIdentity | null;
  private chatRuntime: AgentChatSessionRuntime | null;
  private taskDirectRuntime: TaskDirectRuntime | null;
  private documentDirectRuntime: DocumentDirectRuntime | null;
  private agentWorkRuntime: AgentWorkSessionRuntime | null;
  private agentCommentRuntime: AgentCommentSessionRuntime | null;
  private commentDispatchRuntime: AgentCommentDispatchRuntime | null;
  private dispatchPipelineRuntime: DispatchPipelineRuntime | null;
  private readonly fetchRecordHistoryImpl: typeof fetchRecordHistory;
  private readonly fetchWorkspaceKeyMappingsImpl: typeof fetchWorkspaceKeyMappings;
  private readonly fetchFlightDeckPgWorkspaceMeImpl: typeof fetchFlightDeckPgWorkspaceMe;
  private readonly fetchFlightDeckPgEventsImpl: typeof fetchFlightDeckPgEvents;
  private readonly connectFlightDeckPgEventStreamImpl: typeof connectFlightDeckPgEventStream;
  private readonly reconcileFlightDeckPgEventSubscriptionAgentsImpl: typeof reconcileFlightDeckPgEventSubscriptionAgents;
  private readonly fetchFlightDeckPgChannelMessagesImpl: typeof fetchFlightDeckPgChannelMessages;
  private readonly fetchFlightDeckPgChannelImpl: typeof fetchFlightDeckPgChannel;
  private readonly fetchFlightDeckPgWorkroomContextImpl: typeof fetchFlightDeckPgWorkroomContext;
  private readonly decryptRecordPayloadImpl: typeof decryptRecordPayloadWithYoke;
  private readonly checkBackendHealthImpl: typeof checkBackendConnectionHealth;
  private readonly flightDeckPgEventPollIntervalMs: number;
  private readonly flightDeckPgEventPollTimeoutMs: number;
  private readonly flightDeckPgEventReconnectBaseMs: number;
  private readonly flightDeckPgEventReconnectMaxMs: number;
  private readonly flightDeckPgEventWatchdog: FlightDeckPgEventFreshnessWatchdog;
  private readonly chatRecordPullTimeoutMs: number;
  private readonly chatRecordPullMaxAttempts: number;
  private readonly chatRecordPullRetryDelayMs: number;
  private readonly dispatchAgentWorkingDirectory: string;
  private readonly isAuthorizedDispatchActorNpub: (npub: string) => boolean;
  private readonly validateWorkingDirectory: ((directory: string) => Promise<string>) | null;
  private readonly resolveSubscriptionBotIdentity: (record: BotKeyStoreRecord) => Promise<RuntimeBotIdentity>;
  private readonly runtimes = new Map<string, RuntimeContext>();
  private readonly workspaceKeyOwnerCache = new Map<string, { fetchedAt: number; owners: Map<string, string> }>();
  private readonly flightDeckPgInFlightEvents = new Map<string, Promise<WorkspaceSubscriptionRecord>>();
  private readonly flightDeckPgEventQueues = new Map<string, Promise<WorkspaceSubscriptionRecord>>();

  constructor(deps: WorkspaceSubscriptionManagerDependencies) {
    this.store = deps.store ?? workspaceSubscriptionStore;
    this.agentStore = deps.agentStore ?? agentDefinitionStore;
    this.backendStore = deps.backendStore ?? backendConnectionStore;
    this.profilePolicyStore = deps.profilePolicyStore ?? agentProfilePolicyStore;
    this.dispatchOutcomeStore = deps.dispatchOutcomeStore ?? (deps.store
      ? {
          recordHistory: () => null,
          listPage: (_subscriptionIds, input) => ({ rows: [], total: 0, ...input }),
        }
      : flightDeckDispatchOutcomeStore);
    this.routingEvaluator = deps.routingEvaluator ?? new AgentChatRoutingEvaluator({ agentStore: this.agentStore });
    this.botKeyStore = deps.botKeyStore;
    this.brokerKeyVault = deps.brokerKeyVault;
    this.getInstanceIdentity = deps.getInstanceIdentity ?? (() => null);
    this.chatRuntime = deps.chatRuntime ?? null;
    this.taskDirectRuntime = deps.taskDirectRuntime ?? null;
    this.documentDirectRuntime = deps.documentDirectRuntime ?? null;
    this.agentWorkRuntime = deps.agentWorkRuntime ?? null;
    this.agentCommentRuntime = deps.agentCommentRuntime ?? null;
    this.commentDispatchRuntime = deps.commentDispatchRuntime ?? agentCommentDispatchRuntime;
    this.dispatchPipelineRuntime = deps.dispatchPipelineRuntime ?? null;
    this.fetchRecordHistoryImpl = deps.fetchRecordHistory ?? fetchRecordHistory;
    this.fetchWorkspaceKeyMappingsImpl = deps.fetchWorkspaceKeyMappings ?? fetchWorkspaceKeyMappings;
    this.fetchFlightDeckPgWorkspaceMeImpl = deps.fetchFlightDeckPgWorkspaceMe ?? fetchFlightDeckPgWorkspaceMe;
    this.fetchFlightDeckPgEventsImpl = deps.fetchFlightDeckPgEvents ?? fetchFlightDeckPgEvents;
    this.connectFlightDeckPgEventStreamImpl = deps.connectFlightDeckPgEventStream ?? connectFlightDeckPgEventStream;
    this.reconcileFlightDeckPgEventSubscriptionAgentsImpl = deps.reconcileFlightDeckPgEventSubscriptionAgents
      ?? reconcileFlightDeckPgEventSubscriptionAgents;
    this.fetchFlightDeckPgChannelMessagesImpl = deps.fetchFlightDeckPgChannelMessages ?? fetchFlightDeckPgChannelMessages;
    this.fetchFlightDeckPgChannelImpl = deps.fetchFlightDeckPgChannel ?? fetchFlightDeckPgChannel;
    this.fetchFlightDeckPgWorkroomContextImpl = deps.fetchFlightDeckPgWorkroomContext ?? fetchFlightDeckPgWorkroomContext;
    this.decryptRecordPayloadImpl = deps.decryptRecordPayload ?? decryptRecordPayloadWithYoke;
    this.checkBackendHealthImpl = deps.checkBackendHealth ?? checkBackendConnectionHealth;
    this.flightDeckPgEventPollIntervalMs = Math.max(1, deps.flightDeckPgEventPollIntervalMs ?? FLIGHT_DECK_PG_EVENT_POLL_INTERVAL_MS);
    this.flightDeckPgEventPollTimeoutMs = Math.max(1, deps.flightDeckPgEventPollTimeoutMs ?? FLIGHT_DECK_PG_EVENT_POLL_TIMEOUT_MS);
    this.flightDeckPgEventReconnectBaseMs = Math.max(1, deps.flightDeckPgEventReconnectBaseMs ?? FLIGHT_DECK_PG_EVENT_RECONNECT_BASE_MS);
    this.flightDeckPgEventReconnectMaxMs = Math.max(
      this.flightDeckPgEventReconnectBaseMs,
      deps.flightDeckPgEventReconnectMaxMs ?? FLIGHT_DECK_PG_EVENT_RECONNECT_MAX_MS,
    );
    this.flightDeckPgEventWatchdog = new FlightDeckPgEventFreshnessWatchdog(
      resolveFlightDeckPgEventWatchdogTiming({
        pollIntervalMs: this.flightDeckPgEventPollIntervalMs,
        pollTimeoutMs: this.flightDeckPgEventPollTimeoutMs,
        checkIntervalMs: deps.flightDeckPgEventPollWatchdogIntervalMs,
        freshnessThresholdMs: deps.flightDeckPgEventPollFreshnessThresholdMs,
        startupGraceMs: deps.flightDeckPgEventPollStartupGraceMs,
      }),
      (subscriptionId, runtimeToken) => {
        void this.recoverStaleFlightDeckPgEventRuntime(subscriptionId, runtimeToken);
      },
    );
    this.chatRecordPullTimeoutMs = Math.max(1, deps.chatRecordPullTimeoutMs ?? CHAT_ADVISORY_RECORD_PULL_TIMEOUT_MS);
    this.chatRecordPullMaxAttempts = Math.max(1, deps.chatRecordPullMaxAttempts ?? CHAT_ADVISORY_RECORD_PULL_MAX_ATTEMPTS);
    this.chatRecordPullRetryDelayMs = Math.max(0, deps.chatRecordPullRetryDelayMs ?? CHAT_ADVISORY_RECORD_PULL_RETRY_DELAY_MS);
    this.dispatchAgentWorkingDirectory = (deps.dispatchAgentWorkingDirectory
      ?? Bun.env.WINGMAN_AGENT_DISPATCH_DIRECTORY
      ?? Bun.env.AGENT_DISPATCH_DIRECTORY
      ?? process.cwd()).trim();
    if (!this.dispatchAgentWorkingDirectory) {
      throw new Error('Agent dispatch working directory is required.');
    }
    this.isAuthorizedDispatchActorNpub = deps.isAuthorizedDispatchActorNpub ?? (() => true);
    this.validateWorkingDirectory = deps.validateWorkingDirectory ?? null;
    this.resolveSubscriptionBotIdentity = createSubscriptionBotIdentityResolver({
      instanceIdentity: this.getInstanceIdentity(),
      brokerKeyVault: deps.brokerKeyVault,
    });
    if (!deps.store || deps.dispatchOutcomeStore) {
      for (const subscription of this.store.listAll()) {
        for (const entry of subscription.recentDispatches ?? []) {
          this.dispatchOutcomeStore.recordHistory(subscription.subscriptionId, entry);
        }
      }
    }
  }

  setChatRuntime(chatRuntime: AgentChatSessionRuntime | null): void {
    this.chatRuntime = chatRuntime;
  }

  setTaskDirectRuntime(taskDirectRuntime: TaskDirectRuntime | null): void {
    this.taskDirectRuntime = taskDirectRuntime;
  }

  setDocumentDirectRuntime(documentDirectRuntime: DocumentDirectRuntime | null): void {
    this.documentDirectRuntime = documentDirectRuntime;
  }

  setAgentWorkRuntime(agentWorkRuntime: AgentWorkSessionRuntime | null): void {
    this.agentWorkRuntime = agentWorkRuntime;
  }

  setAgentCommentRuntime(agentCommentRuntime: AgentCommentSessionRuntime | null): void {
    this.agentCommentRuntime = agentCommentRuntime;
  }

  setDispatchPipelineRuntime(dispatchPipelineRuntime: DispatchPipelineRuntime | null): void {
    this.dispatchPipelineRuntime = dispatchPipelineRuntime;
  }

  private isAuthorizedDispatchActor(npub: string | null | undefined): boolean {
    const normalized = normaliseNpub(npub ?? null);
    return Boolean(normalized && this.isAuthorizedDispatchActorNpub(normalized));
  }

  private appendUnauthorizedDispatchSuppression(input: {
    record: WorkspaceSubscriptionRecord;
    kind: AgentChatDispatchHistoryEntry['kind'];
    action: AgentChatDispatchHistoryEntry['action'];
    recordId: string;
    bindingId: string | null;
    bindingType: AgentChatDispatchHistoryEntry['bindingType'];
    actorNpub: string | null;
    source: string;
    sourceLabel?: string | null;
    details?: Record<string, unknown>;
  }): WorkspaceSubscriptionRecord {
    const record = input.record;
    record.lastRoutingResult = buildFailureDiagnostic(
      input.action,
      'Dispatch suppressed because the event actor is not an authorized Autopilot user.',
      'unauthorized_dispatch_actor',
      {
        subscription_id: record.subscriptionId,
        record_id: input.recordId,
        actor_npub: input.actorNpub,
        source: input.source,
      },
    );
    return this.appendDispatchHistory(record, {
      at: new Date().toISOString(),
      kind: input.kind,
      action: input.action,
      agentId: 'security',
      sessionId: null,
      recordId: input.recordId,
      bindingId: input.bindingId,
      bindingType: input.bindingType,
      sourceLabel: input.sourceLabel,
      details: {
        ...(input.details ?? {}),
        actor_npub: input.actorNpub,
        source: input.source,
        suppression_reason: 'unauthorized_dispatch_actor',
      },
    });
  }

  private appendInvalidInstructionSignatureSuppression(input: {
    record: WorkspaceSubscriptionRecord;
    recordId: string;
    bindingId: string;
    actorNpub: string | null;
    signerNpub: string | null;
    reason: string;
    sourceLabel?: string | null;
    details?: Record<string, unknown>;
  }): WorkspaceSubscriptionRecord {
    const record = input.record;
    record.lastRoutingResult = buildFailureDiagnostic(
      'chat_skip_invalid_instruction_signature',
      'Dispatch suppressed because the Flight Deck PG message instruction signature is missing or invalid.',
      input.reason,
      {
        subscription_id: record.subscriptionId,
        record_id: input.recordId,
        actor_npub: input.actorNpub,
        signer_npub: input.signerNpub,
        source: 'flightdeck_pg',
      },
    );
    return this.appendDispatchHistory(record, {
      at: new Date().toISOString(),
      kind: 'chat',
      action: 'chat_skip_invalid_instruction_signature',
      agentId: 'security',
      sessionId: null,
      recordId: input.recordId,
      bindingId: input.bindingId,
      bindingType: 'thread',
      sourceLabel: input.sourceLabel,
      details: {
        ...(input.details ?? {}),
        actor_npub: input.actorNpub,
        signer_npub: input.signerNpub,
        source: 'flightdeck_pg',
        suppression_reason: input.reason,
      },
    });
  }

  getRuntimeBotIdentity(subscriptionId: string): RuntimeBotIdentity | null {
    try {
      return this.getRuntime(subscriptionId).botIdentity;
    } catch {
      return null;
    }
  }

  getFlightDeckRuntimeContext(subscriptionId: string): {
    backendBaseUrl: string;
    workspaceId: string;
    appNpub: string;
    botIdentity: RuntimeBotIdentity;
  } | null {
    const subscription = this.store.getBySubscriptionId(subscriptionId);
    const botIdentity = this.getRuntimeBotIdentity(subscriptionId);
    if (!subscription?.workspaceId || !botIdentity) return null;
    return {
      backendBaseUrl: subscription.backendBaseUrl,
      workspaceId: subscription.workspaceId,
      appNpub: subscription.sourceAppNpub,
      botIdentity,
    };
  }

  resolveDuplicateCallbackPublicationConfig(input: {
    subscriptionId: string;
    agentNpub: string;
  }): { marker: string; windowSeconds: number } | null {
    return this.profilePolicyStore.getDuplicateCallbackPublicationConfig(input);
  }

  resolveDirectChatTurnTransport(input: {
    subscriptionId: string;
    backendBaseUrl: string;
    towerServiceNpub: string;
    workspaceId: string;
    sourceAppNpub: string;
  }): { backendBaseUrl: string; workspaceId: string; appNpub: string } | null {
    const subscription = this.store.getBySubscriptionId(input.subscriptionId);
    if (!subscription?.workspaceId || subscription.backendBaseUrl !== input.backendBaseUrl
      || subscription.towerServiceNpub !== input.towerServiceNpub || subscription.workspaceId !== input.workspaceId
      || subscription.sourceAppNpub !== input.sourceAppNpub) return null;
    return { backendBaseUrl: subscription.backendBaseUrl, workspaceId: subscription.workspaceId,
      appNpub: subscription.sourceAppNpub };
  }

  resolveFlightDeckTurnDelivery(input: {
    towerServiceNpub: string;
    workspaceId: string;
    agentNpub: string;
  }): { subscriptionId: string; backendBaseUrl: string; appNpub: string; botIdentity: RuntimeBotIdentity } | null {
    const subscription = this.store.listAll().find((record) =>
      (record.lifecycleStatus ?? 'active') === 'active'
      && record.towerServiceNpub === input.towerServiceNpub
      && record.workspaceId === input.workspaceId
      && record.botNpub === input.agentNpub);
    if (!subscription) return null;
    const botIdentity = this.getRuntimeBotIdentity(subscription.subscriptionId);
    return botIdentity ? {
      subscriptionId: subscription.subscriptionId,
      backendBaseUrl: subscription.backendBaseUrl,
      appNpub: subscription.sourceAppNpub,
      botIdentity,
    } : null;
  }

  listForManager(npub: string): WorkspaceSubscriptionRecord[] {
    return this.store.listForManagerNpub(npub)
      .filter((record) => (record.lifecycleStatus ?? 'active') === 'active');
  }

  listDispatchOutcomesForManager(
    npub: string,
    input: { limit: number; offset: number; includeIgnoredAndSuppressed?: boolean },
  ) {
    const subscriptions = this.listForManager(npub);
    const workspaceNames = new Map(subscriptions.map((subscription) => {
      const bundle = this.getProfileWorkspaceForManager(subscription.subscriptionId, npub);
      const label = bundle?.workspace.workspaceTitle?.trim()
        || 'Workspace name unavailable';
      return [subscription.subscriptionId, label] as const;
    }));
    const page = this.dispatchOutcomeStore.listPage(
      subscriptions.map((subscription) => subscription.subscriptionId),
      input,
    );
    return {
      ...page,
      rows: page.rows.map((row) => ({
        ...row,
        workspaceName: workspaceNames.get(row.subscriptionId) ?? 'Workspace name unavailable',
      })),
    };
  }

  getForManager(subscriptionId: string, npub: string): WorkspaceSubscriptionRecord | null {
    const record = this.store.getBySubscriptionId(subscriptionId);
    return record?.managedByNpub === npub ? record : null;
  }

  listAgentsForManager(npub: string): AgentDefinitionRecord[] {
    return this.agentStore.listForManagerNpub(npub);
  }

  getDefaultAgentForManager(npub: string): AgentDefinitionRecord | null {
    return this.agentStore.getDefaultForManagerNpub(npub);
  }

  setDefaultAgentForManager(agentId: string, npub: string): AgentDefinitionRecord {
    return this.agentStore.setDefaultForManagerNpub(npub, agentId);
  }

  listBackendConnectionsForManager(npub: string) {
    this.backfillLegacyBackendConnections();
    return this.backendStore.listAvailableForManagerNpub(npub);
  }

  listBackendConnectionGrantsForManager(backendConnectionId: string, npub: string) {
    const record = this.backendStore.getById(backendConnectionId);
    if (!record || record.managedByNpub !== npub) {
      return [];
    }
    return this.backendStore.listGrants(backendConnectionId);
  }

  updateBackendConnectionAvailabilityForManager(input: {
    backendConnectionId: string;
    managedByNpub: string;
    managerNpubs?: string[];
    sharedService?: boolean;
  }) {
    const record = this.backendStore.getById(input.backendConnectionId);
    if (!record) {
      throw Object.assign(new Error('Backend connection not found'), { statusCode: 404 });
    }
    if (record.managedByNpub !== input.managedByNpub) {
      throw Object.assign(new Error('Only the backend connection owner can manage availability.'), { statusCode: 403 });
    }
    const grants = this.backendStore.replaceAvailabilityGrants({
      backendConnectionId: input.backendConnectionId,
      managerNpubs: input.managerNpubs,
      sharedService: input.sharedService,
    });
    return {
      backendConnection: this.backendStore.getById(input.backendConnectionId) ?? record,
      grants,
    };
  }

  backfillLegacyBackendConnections(): { backfilled: number; linkedSubscriptions: number } {
    let backfilled = 0;
    let linkedSubscriptions = 0;
    for (const subscription of this.store.listLegacyDirectSubscriptions()) {
      const backendConnection = (() => {
        try {
          return this.backendStore.backfillFromLegacySubscription(subscription);
        } catch {
          return null;
        }
      })();
      if (!backendConnection) {
        continue;
      }
      backfilled += 1;
      if (subscription.backendConnectionId !== backendConnection.backendConnectionId) {
        this.store.save({
          ...subscription,
          backendConnectionId: backendConnection.backendConnectionId,
          backendBaseUrl: backendConnection.backendBaseUrl,
          updatedAt: new Date().toISOString(),
        });
        linkedSubscriptions += 1;
      }
    }
    return { backfilled, linkedSubscriptions };
  }

  getAgentForManager(agentId: string, npub: string): AgentDefinitionRecord | null {
    const record = this.agentStore.getByAgentId(agentId);
    return record?.managedByNpub === npub ? record : null;
  }

  listAgentsForWorkspaceBot(workspaceOwnerNpub: string, botNpub: string, npub: string): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(workspaceOwnerNpub, botNpub)
      .filter((record) => record.managedByNpub === npub);
  }

  getProfileWorkspaceForManager(subscriptionId: string, npub: string): AgentProfileWorkspaceBundle | null {
    const subscription = this.getForManager(subscriptionId, npub);
    if (!subscription || !subscription.managedByNpub) {
      return null;
    }
    const agentProfile = subscription.agentProfileId
      ? this.agentStore.getByAgentId(subscription.agentProfileId)
      : null;
    const backendConnection = subscription.backendConnectionId
      ? this.backendStore.getById(subscription.backendConnectionId)
      : null;
    return this.profilePolicyStore.ensureProfileWorkspaceForSubscription({
      managedByNpub: subscription.managedByNpub,
      agentProfileId: agentProfile?.agentId ?? subscription.agentProfileId ?? subscription.botNpub,
      agentLabel: agentProfile?.label ?? null,
      agentNpub: subscription.botNpub,
      subscription,
      backendConnection,
    });
  }

  saveProfileWorkspaceForManager(input: {
    subscriptionId: string;
    managedByNpub: string;
    profileDefaultPipelineDefinitionId?: string | null;
    profilePromptContext?: string | null;
    workspaceDefaultPipelineDefinitionId?: string | null;
    workspaceContext?: string | null;
    workspaceTitle?: string | null;
    duplicateCallbackMarker?: string;
    duplicateCallbackWindowSeconds?: number;
    policies?: Array<Partial<AgentWorkspaceEventPolicyRecord> & { eventType: AgentWorkspaceEventType }>;
    pipelineOverrides?: Array<{
      targetKind: AgentWorkspacePipelineOverrideTarget;
      targetId: string;
      pipelineDefinitionId: string;
      pipelineVersionPolicy?: CreateDispatchRouteInput['pipelineVersionPolicy'];
    }>;
    appendedContexts?: Array<{
      contextKind: AgentWorkspaceContextKind;
      targetId?: string | null;
      eventType?: AgentWorkspaceEventType | null;
      contextText: string;
    }>;
  }): AgentProfileWorkspaceBundle {
    const bundle = this.getProfileWorkspaceForManager(input.subscriptionId, input.managedByNpub);
    if (!bundle) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    const profile = this.profilePolicyStore.updateProfileDefaults({
      profileId: bundle.profile.profileId,
      managedByNpub: input.managedByNpub,
      defaultPipelineDefinitionId: input.profileDefaultPipelineDefinitionId,
      promptContext: input.profilePromptContext,
    });
    const workspace = this.profilePolicyStore.updateWorkspaceDefaults({
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      defaultPipelineDefinitionId: input.workspaceDefaultPipelineDefinitionId,
      workspaceContext: input.workspaceContext,
      workspaceTitle: input.workspaceTitle,
      duplicateCallbackMarker: input.duplicateCallbackMarker,
      duplicateCallbackWindowSeconds: input.duplicateCallbackWindowSeconds,
    });
    const existingPolicies = new Map(bundle.policies.map((policy) => [policy.eventType, policy]));
    const now = new Date().toISOString();
    const policies = Array.isArray(input.policies)
      ? input.policies.map((policy) => {
          const existing = existingPolicies.get(policy.eventType);
          if (!existing) {
            return null;
          }
          return this.profilePolicyStore.saveEventPolicy({
            ...existing,
            enabled: typeof policy.enabled === 'boolean' ? policy.enabled : existing.enabled,
            defaultAction: policy.defaultAction ?? existing.defaultAction,
            pipelineDefinitionId: policy.pipelineDefinitionId === undefined
              ? existing.pipelineDefinitionId
              : typeof policy.pipelineDefinitionId === 'string' && policy.pipelineDefinitionId.trim()
                ? policy.pipelineDefinitionId.trim()
                : null,
            promptContext: policy.promptContext === undefined
              ? existing.promptContext
              : typeof policy.promptContext === 'string' && policy.promptContext.trim()
                ? policy.promptContext
                : null,
            quietMode: typeof policy.quietMode === 'boolean' ? policy.quietMode : existing.quietMode,
            updatedAt: now,
          });
        }).filter((policy): policy is AgentWorkspaceEventPolicyRecord => Boolean(policy))
      : this.profilePolicyStore.listPolicies(bundle.workspace.profileWorkspaceId);
    const pipelineOverrides: AgentWorkspacePipelineOverrideRecord[] = Array.isArray(input.pipelineOverrides)
      ? this.profilePolicyStore.replacePipelineOverrides(bundle.workspace.profileWorkspaceId, input.pipelineOverrides)
      : this.profilePolicyStore.listPipelineOverrides(bundle.workspace.profileWorkspaceId);
    const appendedContexts: AgentWorkspaceAppendedContextRecord[] = Array.isArray(input.appendedContexts)
      ? this.profilePolicyStore.replaceAppendedContexts(bundle.workspace.profileWorkspaceId, input.appendedContexts)
      : this.profilePolicyStore.listAppendedContexts(bundle.workspace.profileWorkspaceId);

    return {
      profile,
      workspace,
      policies,
      pipelineOverrides,
      appendedContexts,
    };
  }

  private resolveProfileRuntimeDecision(input: {
    subscription: WorkspaceSubscriptionRecord;
    eventType: AgentWorkspaceEventType;
    scopeId?: string | null;
    channelId?: string | null;
    builtInDefaultPipelineId?: string | null;
  }): AgentProfileRuntimeDecision | null {
    const managedByNpub = input.subscription.managedByNpub;
    if (!managedByNpub) {
      return null;
    }
    const bundle = this.getProfileWorkspaceForManager(input.subscription.subscriptionId, managedByNpub);
    if (!bundle) {
      return null;
    }
    const settings = this.profilePolicyStore.resolveRuntimeSettingsForEvent({
      profileId: bundle.profile.profileId,
      managedByNpub,
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      eventType: input.eventType,
      scopeId: input.scopeId,
      channelId: input.channelId,
      builtInDefaultPipelineId: input.builtInDefaultPipelineId,
    });
    return {
      profileWorkspaceId: bundle.workspace.profileWorkspaceId,
      eventType: input.eventType,
      settings,
      contextText: formatResolvedProfileRuntimeContext(settings.appendedContext),
    };
  }

  private buildProfileRuntimeContext(decision: AgentProfileRuntimeDecision | null) {
    if (!decision) {
      return null;
    }
    const policy = decision.settings.policy;
    return {
      profileWorkspaceId: decision.profileWorkspaceId,
      eventType: decision.eventType,
      enabled: policy?.enabled ?? true,
      defaultAction: policy?.defaultAction ?? defaultActionForEventType(decision.eventType),
      quietMode: policy?.quietMode ?? false,
      pipeline: decision.settings.pipeline,
      appendedContext: decision.settings.appendedContext,
    };
  }

  private appendProfilePolicySuppression(input: {
    record: WorkspaceSubscriptionRecord;
    decision: AgentProfileRuntimeDecision;
    kind: AgentChatDispatchHistoryEntry['kind'];
    recordId: string | null;
    bindingId: string | null;
    bindingType: AgentChatDispatchHistoryEntry['bindingType'];
    agentId?: string | null;
    sourceLabel?: string | null;
    details?: Record<string, unknown>;
  }): WorkspaceSubscriptionRecord {
    const policy = input.decision.settings.policy;
    const reason = !policy?.enabled
      ? 'disabled'
      : policy?.quietMode
        ? 'quiet'
        : `action_${policy?.defaultAction ?? defaultActionForEventType(input.decision.eventType)}`;
    return this.appendDispatchHistory(input.record, {
      at: new Date().toISOString(),
      kind: input.kind,
      action: `${input.decision.eventType}_profile_policy_suppressed`,
      agentId: input.agentId ?? 'profile-policy',
      sessionId: null,
      recordId: input.recordId,
      bindingId: input.bindingId,
      bindingType: input.bindingType,
      sourceLabel: input.sourceLabel,
      status: 'suppressed',
      suppressionReason: reason,
      details: {
        profile_workspace_id: input.decision.profileWorkspaceId,
        event_type: input.decision.eventType,
        enabled: policy?.enabled ?? true,
        quiet_mode: policy?.quietMode ?? false,
        default_action: policy?.defaultAction ?? defaultActionForEventType(input.decision.eventType),
        pipeline_definition_id: input.decision.settings.pipeline.pipelineDefinitionId,
        pipeline_source: input.decision.settings.pipeline.source,
        context_count: input.decision.settings.appendedContext.length,
        ...input.details,
      },
    });
  }

  listInterceptsForSubscription(subscriptionId: string, npub: string) {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return [];
    }
    return this.routingEvaluator.listInterceptsForSubscription(subscriptionId);
  }

  listDispatchRoutesForManager(npub: string): DispatchRouteRecord[] {
    if (!this.dispatchPipelineRuntime) {
      return [];
    }
    return this.dispatchPipelineRuntime
      .listRoutesForManager(npub)
      .filter((route) => this.getForManager(route.subscriptionId, npub));
  }

  listDispatchRoutesForSubscription(subscriptionId: string, npub: string): DispatchRouteRecord[] {
    const record = this.getForManager(subscriptionId, npub);
    if (!record || !this.dispatchPipelineRuntime) {
      return [];
    }
    return this.dispatchPipelineRuntime.listRoutesForSubscription(record.subscriptionId);
  }

  saveDispatchRouteForManager(input: Omit<CreateDispatchRouteInput, 'managedByNpub' | 'workspaceOwnerNpub' | 'botNpub' | 'sourceAppNpub'> & {
    routeId?: string;
    managedByNpub: string;
  }): DispatchRouteRecord {
    const record = this.getForManager(input.subscriptionId, input.managedByNpub);
    if (!record) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }
    if (!this.dispatchPipelineRuntime) {
      throw Object.assign(new Error('Dispatch pipelines are not available'), { statusCode: 503 });
    }
    return this.dispatchPipelineRuntime.saveRoute({
      ...input,
      managedByNpub: input.managedByNpub,
      workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(record),
      botNpub: record.botNpub,
      sourceAppNpub: record.sourceAppNpub,
    });
  }

  private ensureDefaultDispatchRoutesForSubscription(
    subscription: WorkspaceSubscriptionRecord,
    capabilities: Array<CreateDispatchRouteInput['capability']>,
  ): DispatchRouteRecord[] {
    if (!this.dispatchPipelineRuntime || !subscription.managedByNpub) {
      return [];
    }
    const enabledCapabilities = new Set(capabilities);
    const existingRoutes = this.dispatchPipelineRuntime.listRoutesForSubscription(subscription.subscriptionId);
    const created: DispatchRouteRecord[] = [];
    for (const routeConfig of DEFAULT_DISPATCH_PIPELINE_ROUTES) {
      if (!enabledCapabilities.has(routeConfig.capability)) {
        continue;
      }
      const pipelineDefinitionId = getDefaultDispatchPipelineDefinitionId(subscription, routeConfig);
      const existingRoute = existingRoutes.find((route) => (
        route.triggerKind === routeConfig.triggerKind
        && route.capability === routeConfig.capability
      ));
      if (existingRoute) {
        if (
          existingRoute.pipelineDefinitionId === routeConfig.pipelineDefinitionId
          && pipelineDefinitionId !== routeConfig.pipelineDefinitionId
        ) {
          const updatedRoute = this.dispatchPipelineRuntime.saveRoute({
            routeId: existingRoute.routeId,
            createdAt: existingRoute.createdAt,
            managedByNpub: existingRoute.managedByNpub,
            subscriptionId: existingRoute.subscriptionId,
            workspaceOwnerNpub: existingRoute.workspaceOwnerNpub,
            botNpub: existingRoute.botNpub,
            sourceAppNpub: existingRoute.sourceAppNpub,
            triggerKind: existingRoute.triggerKind,
            capability: existingRoute.capability,
            pipelineDefinitionId,
            pipelineVersionPolicy: existingRoute.pipelineVersionPolicy,
            enabled: existingRoute.enabled,
            priority: existingRoute.priority,
            matchJson: existingRoute.matchJson,
            inputTemplateJson: existingRoute.inputTemplateJson,
            concurrencyKeyTemplate: existingRoute.concurrencyKeyTemplate,
            activePolicy: existingRoute.activePolicy,
            dedupeWindowSeconds: existingRoute.dedupeWindowSeconds,
          });
          const routeIndex = existingRoutes.findIndex((route) => route.routeId === updatedRoute.routeId);
          if (routeIndex >= 0) {
            existingRoutes[routeIndex] = updatedRoute;
          }
          created.push(updatedRoute);
        }
        continue;
      }
      const route = this.dispatchPipelineRuntime.saveRoute({
        managedByNpub: subscription.managedByNpub,
        subscriptionId: subscription.subscriptionId,
        workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(subscription),
        botNpub: subscription.botNpub,
        sourceAppNpub: subscription.sourceAppNpub,
        triggerKind: routeConfig.triggerKind,
        capability: routeConfig.capability,
        pipelineDefinitionId,
        pipelineVersionPolicy: routeConfig.pipelineVersionPolicy,
        enabled: true,
        priority: 100,
      });
      existingRoutes.push(route);
      created.push(route);
    }
    return created;
  }

  private ensureDefaultDispatchRoutesForAgent(agent: AgentDefinitionRecord): void {
    if (!agent.managedByNpub) {
      return;
    }
    for (const subscription of this.store.listForManagerNpub(agent.managedByNpub)) {
      if (
        (subscription.lifecycleStatus ?? 'active') !== 'active'
        || this.getEffectiveWorkspaceNpub(subscription) !== agent.workspaceOwnerNpub
        || subscription.botNpub !== agent.botNpub
      ) {
        continue;
      }
      this.ensureDefaultDispatchRoutesForSubscription(subscription, agent.capabilities);
    }
  }

  deleteDispatchRouteForManager(routeId: string, npub: string): boolean {
    if (!this.dispatchPipelineRuntime) {
      return false;
    }
    return this.dispatchPipelineRuntime.deleteRouteForManager(routeId, npub);
  }

  private normaliseAgentCapabilities(
    capabilities?: string[],
  ): Array<'chat_intercept' | 'task_dispatch' | 'comment_dispatch' | 'flow_dispatch' | 'task_review' | 'approval_dispatch'> {
    const set = new Set<'chat_intercept' | 'task_dispatch' | 'comment_dispatch' | 'flow_dispatch' | 'task_review' | 'approval_dispatch'>();
    for (const capability of capabilities ?? []) {
      if (
        capability === 'chat_intercept'
        || capability === 'task_dispatch'
        || capability === 'comment_dispatch'
        || capability === 'flow_dispatch'
        || capability === 'task_review'
        || capability === 'approval_dispatch'
      ) {
        set.add(capability);
      }
    }
    return set.size > 0 ? [...set] : ['chat_intercept'];
  }

  private getEffectiveWorkspaceNpub(record: Pick<WorkspaceSubscriptionRecord, 'workspaceOwnerNpub' | 'workspaceServiceNpub'>): string {
    return record.workspaceServiceNpub?.trim() || record.workspaceOwnerNpub;
  }

  private normaliseAgentIdPart(value: string | null | undefined): string {
    const normalized = String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    if (!normalized) {
      return 'workspace';
    }
    return normalized.length <= 24
      ? normalized
      : `${normalized.slice(0, 10)}${normalized.slice(-14)}`;
  }

  private buildOnboardedAgentId(subscription: WorkspaceSubscriptionRecord): string {
    const workspacePart = this.normaliseAgentIdPart(
      subscription.workspaceId ?? this.getEffectiveWorkspaceNpub(subscription),
    );
    const appPart = this.normaliseAgentIdPart(subscription.sourceAppNpub);
    const botPart = this.normaliseAgentIdPart(subscription.botNpub);
    return `fd-${botPart}-${workspacePart}-${appPart}`;
  }

  private isLegacyAgentChatWorkspaceDirectory(workingDirectory: string | null | undefined): boolean {
    const normalised = String(workingDirectory ?? '').replace(/\\/g, '/');
    return normalised.includes('/data/agent-chat-workspaces/');
  }

  private resolveOnboardedAgentWorkingDirectory(
    existingAgent: AgentDefinitionRecord | null,
    agentProfile: AgentDefinitionRecord | null,
  ): string {
    const existingDirectory = existingAgent?.workingDirectory?.trim();
    if (existingDirectory && !this.isLegacyAgentChatWorkspaceDirectory(existingDirectory)) {
      return existingDirectory;
    }
    return agentProfile?.workingDirectory?.trim() || this.dispatchAgentWorkingDirectory;
  }

  private deriveGroupNpubsFromSubscription(subscription: WorkspaceSubscriptionRecord): string[] {
    if (!subscription.wrappedGroupKeysJson) {
      return [];
    }
    try {
      const rows = JSON.parse(subscription.wrappedGroupKeysJson) as unknown;
      if (!Array.isArray(rows)) {
        return [];
      }
      return [...new Set(rows
        .map((row) => (row && typeof row === 'object' ? (row as { group_npub?: unknown }).group_npub : null))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()))].sort();
    } catch {
      return [];
    }
  }

  private onboardedAgentCapabilities(subscription: WorkspaceSubscriptionRecord): AgentCapability[] {
    return this.normaliseAgentCapabilities([
      ...DEFAULT_33357_AGENT_CAPABILITIES,
      ...(subscription.capabilityDefaults ?? []),
    ]);
  }

  private async ensureOnboardedAgentForSubscription(input: {
    subscription: WorkspaceSubscriptionRecord;
    agentProfile: AgentDefinitionRecord | null;
    botIdentity: RuntimeBotIdentity;
  }): Promise<AgentDefinitionRecord | null> {
    const subscription = input.subscription;
    if (
      (subscription.onboardingSource !== 'nostr_33357' && !isFlightDeckPgSubscription(subscription))
      || !subscription.managedByNpub
    ) {
      return null;
    }

    const existing = this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub)
      .find((agent) => agent.managedByNpub === subscription.managedByNpub)
      ?? (input.agentProfile?.botNpub === subscription.botNpub
        && input.agentProfile.managedByNpub === subscription.managedByNpub
        ? input.agentProfile
        : null);
    if (existing) {
      const capabilities = this.onboardedAgentCapabilities(subscription);
      const updated = this.agentStore.save({
        ...existing,
        capabilities: [...new Set([...existing.capabilities, ...capabilities])] as AgentCapability[],
        groupNpubs: existing.groupNpubs.length > 0
          ? existing.groupNpubs
          : this.deriveGroupNpubsFromSubscription(subscription),
        workingDirectory: this.resolveOnboardedAgentWorkingDirectory(existing, input.agentProfile),
        updatedAt: new Date().toISOString(),
      });
      this.ensureDefaultDispatchRoutesForSubscription(subscription, updated.capabilities);
      return updated;
    }

    const groupNpubs = this.deriveGroupNpubsFromSubscription(subscription);
    const isFlightDeckPgWorkspace = Boolean(subscription.workspaceId && subscription.workspaceServiceNpub);
    if (groupNpubs.length === 0 && !isFlightDeckPgWorkspace) {
      return null;
    }

    const agentId = this.buildOnboardedAgentId(subscription);
    const existingById = this.agentStore.getByAgentId(agentId);
    if (existingById && existingById.managedByNpub && existingById.managedByNpub !== subscription.managedByNpub) {
      throw new Error(`Auto Agent Dispatch binding ${agentId} is owned by another manager.`);
    }
    if (existingById && existingById.botNpub !== subscription.botNpub) {
      throw Object.assign(new Error(
        `Auto Agent Dispatch identity conflicts with existing Agent Profile ${agentId}. The existing profile was left unchanged; remove or repair the stale subscription before reconnecting.`,
      ), {
        statusCode: 409,
        detailCode: 'agent_profile_identity_conflict',
      });
    }

    const now = new Date().toISOString();
    const label = input.agentProfile?.label
      || (input.botIdentity.botNpub === subscription.botNpub ? 'Flight Deck Agent' : 'Agent Dispatch');
    const workingDirectory = this.resolveOnboardedAgentWorkingDirectory(existingById, input.agentProfile);
    const capabilities = this.onboardedAgentCapabilities(subscription);

    const saved = this.agentStore.save({
      agentId,
      label,
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(subscription),
      groupNpubs,
      workingDirectory,
      directChat: input.agentProfile?.directChat ?? existingById?.directChat,
      capabilities,
      chatPromptTemplate: existingById?.chatPromptTemplate ?? DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
      taskPromptTemplate: existingById?.taskPromptTemplate ?? DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
      flowDispatchPromptTemplate: existingById?.flowDispatchPromptTemplate ?? DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
      taskReviewPromptTemplate: existingById?.taskReviewPromptTemplate ?? DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
      approvalDispatchPromptTemplate: existingById?.approvalDispatchPromptTemplate ?? DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
      enabled: existingById?.enabled ?? true,
      createdAt: existingById?.createdAt ?? now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    this.ensureDefaultDispatchRoutesForSubscription(subscription, saved.capabilities);
    return saved;
  }

  async saveAgentForManager(input: CreateAgentDefinitionInput): Promise<AgentDefinitionRecord> {
    const agentId = input.agentId.trim();
    const label = input.label.trim() || agentId;
    const botNpub = input.botNpub.trim();
    const workspaceOwnerNpub = input.workspaceOwnerNpub.trim();
    let workingDirectory = input.workingDirectory.trim();
    const requestedGroupNpubs = [...new Set((input.groupNpubs ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort();
    const capabilities = this.normaliseAgentCapabilities(input.capabilities);
    const chatPromptTemplate = normalisePromptTemplate(input.chatPromptTemplate, DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE);
    const taskPromptTemplate = normalisePromptTemplate(input.taskPromptTemplate, DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE);
    const flowDispatchPromptTemplate = normalisePromptTemplate(
      input.flowDispatchPromptTemplate,
      DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
    );
    const taskReviewPromptTemplate = normalisePromptTemplate(
      input.taskReviewPromptTemplate,
      DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
    );
    const approvalDispatchPromptTemplate = normalisePromptTemplate(
      input.approvalDispatchPromptTemplate,
      DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
    );

    if (!agentId || !botNpub || !workspaceOwnerNpub || !workingDirectory) {
      throw new Error('agentId, botNpub, workspaceOwnerNpub, and workingDirectory are required.');
    }
    if (!isAbsolute(workingDirectory)) {
      throw new Error('workingDirectory must be an absolute path.');
    }
    if (this.validateWorkingDirectory) {
      const validatedDirectory = await this.validateWorkingDirectory(workingDirectory);
      if (!input.preserveValidatedWorkingDirectory) workingDirectory = validatedDirectory;
    }

    const pgSubscription = this.store.listForManagerNpub(input.managedByNpub).find((subscription) => (
      (subscription.lifecycleStatus ?? 'active') === 'active'
      && isFlightDeckPgSubscription(subscription)
      && this.getEffectiveWorkspaceNpub(subscription) === workspaceOwnerNpub
      && subscription.botNpub === botNpub
    ));
    const groupNpubs = pgSubscription || input.unboundProfile
      ? []
      : await this.resolveAgentGroupNpubs({
          requestedGroupNpubs,
          workspaceOwnerNpub,
          botNpub,
          managedByNpub: input.managedByNpub,
        });
    if (!pgSubscription && !input.unboundProfile && groupNpubs.length === 0) {
      throw new Error('No readable Flight Deck groups are available for this bot. Add the Wingman bot to at least one workspace group, then try again; Wingman will refresh groups automatically.');
    }

    const existing = this.agentStore.getByAgentId(agentId);
    if (existing && existing.managedByNpub && existing.managedByNpub !== input.managedByNpub) {
      throw new Error(`Agent ${agentId} is owned by another manager.`);
    }
    if (existing && existing.botNpub !== botNpub) {
      throw new Error('botNpub is immutable for an agent profile. Create a new profile to use another identity.');
    }
    const existingByBot = this.agentStore.getByBotNpub(botNpub);
    if (existingByBot && existingByBot.agentId !== agentId) {
      throw new Error(`Agent identity ${botNpub} is already bound to profile ${existingByBot.agentId}.`);
    }
    const now = new Date().toISOString();
    const saved = this.agentStore.save({
      agentId,
      label,
      botNpub,
      workspaceOwnerNpub,
      groupNpubs,
      workingDirectory,
      harness: input.harness?.trim() || input.directChat?.sessionAgent?.trim() || existing?.harness || null,
      model: input.model?.trim() || input.directChat?.model?.trim() || existing?.model || null,
      archived: input.archived ?? existing?.archived ?? false,
      publicProfile: input.publicProfile ?? existing?.publicProfile ?? {
        name: label,
        picture: null,
        about: null,
        nip05: null,
      },
      publicProfileRefresh: input.publicProfileRefresh ?? existing?.publicProfileRefresh,
      capabilities,
      directChat: input.directChat ?? existing?.directChat,
      chatPromptTemplate,
      taskPromptTemplate,
      flowDispatchPromptTemplate,
      taskReviewPromptTemplate,
      approvalDispatchPromptTemplate,
      enabled: input.enabled !== false && input.archived !== true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      managedByNpub: input.managedByNpub,
    });
    this.ensureDefaultDispatchRoutesForAgent(saved);
    return saved;
  }

  async validateAgentWorkingDirectory(directory: string): Promise<void> {
    if (!isAbsolute(directory)) throw new Error('workingDirectory must be an absolute path.');
    await this.validateWorkingDirectory?.(directory);
  }

  async createAgentProfileForManager(input: Omit<CreateAgentDefinitionInput, 'botNpub'>): Promise<{
    agent: AgentDefinitionRecord;
    signedProfileEvent: SignedNostrEvent;
  }> {
    if (!this.botKeyStore.createKey || !this.brokerKeyVault) {
      throw new Error('Durable agent identity creation is not configured.');
    }
    const decoded = nip19.decode(input.managedByNpub);
    if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
      throw new Error('Managing owner npub is invalid.');
    }
    let record: BotKeyStoreRecord | null = null;
    // Compensating transaction order: persist non-secret lookup metadata,
    // provision its identity-bound vault envelope, then persist the profile.
    // The API publishes last and calls rollbackCreatedAgentProfile if that
    // stage fails. Every reverse path removes profile, envelope, then metadata.
    const generated = createBrokeredAgentIdentity({
      profile: input.publicProfile,
      provision: (identity, secretKey) => {
        try {
          record = this.botKeyStore.createKey!({
            userNpub: input.managedByNpub,
            botPubkeyHex: identity.botPubkeyHex,
            botNpub: identity.botNpub,
            displayName: identity.displayName,
            encryptedToUser: '',
            encryptedEscrow: '',
            escrowUuid: '',
          });
        } catch (error) {
          throw new AgentProfileCreationError('persistence', error);
        }
        try {
          this.brokerKeyVault!.provision(record, secretKey);
        } catch (error) {
          try {
            this.botKeyStore.deleteKey?.(record.id);
          } catch {
            this.botKeyStore.deactivateKey?.(record.id);
          }
          record = null;
          throw new AgentProfileCreationError('vault', error);
        }
      },
    });
    try {
      const agent = await this.saveAgentForManager({ ...input, botNpub: generated.botNpub, unboundProfile: true });
      return { agent, signedProfileEvent: generated.signedProfileEvent };
    } catch (error) {
      if (record) await this.rollbackCreatedAgentProfile(input.agentId, record);
      if (error instanceof AgentProfileCreationError) throw error;
      throw new AgentProfileCreationError('persistence', error);
    }
  }

  async rollbackCreatedAgentProfile(agentId: string, recordOrBotNpub: BotKeyStoreRecord | string): Promise<void> {
    const record = typeof recordOrBotNpub === 'string'
      ? this.botKeyStore.getActiveKeyForBotNpub(recordOrBotNpub)
      : recordOrBotNpub;
    const profile = this.agentStore.getByAgentId(agentId);
    if (record && profile?.botNpub === record.botNpub) {
      this.agentStore.delete(agentId);
    }
    if (!record) return;
    let envelopeError: unknown = null;
    try {
      await this.brokerKeyVault?.remove(record);
    } catch (error) {
      envelopeError = error;
    }
    try {
      if (this.botKeyStore.deleteKey) this.botKeyStore.deleteKey(record.id);
      else this.botKeyStore.deactivateKey?.(record.id);
    } catch (error) {
      this.botKeyStore.deactivateKey?.(record.id);
      throw error;
    }
    if (envelopeError) throw envelopeError;
  }

  async deleteAgentProfileForManager(agentId: string, npub: string): Promise<AgentProfileDeletionResult | null> {
    const record = this.getAgentForManager(agentId, npub);
    if (!record) {
      return null;
    }
    const linkedSubscriptions = this.store.listForManagerNpub(npub).filter((subscription) => (
      (subscription.lifecycleStatus ?? 'active') === 'active'
      && (subscription.agentProfileId === agentId || subscription.botNpub === record.botNpub)
    ));
    if (linkedSubscriptions.length > 0) {
      throw Object.assign(new Error(
        `Agent profile is still used by ${linkedSubscriptions.length} workspace subscription${linkedSubscriptions.length === 1 ? '' : 's'}. Delete or rebind those subscriptions before deleting the profile.`,
      ), { statusCode: 409 });
    }

    const keyRecord = this.botKeyStore.getActiveKeyForBotNpub(record.botNpub);
    let keyDisposition: AgentProfileDeletionKeyDisposition;
    if (keyRecord) {
      if (keyRecord.userNpub !== npub) {
        throw Object.assign(new Error('Agent profile key custody belongs to another manager.'), { statusCode: 409 });
      }
      if (!this.brokerKeyVault) {
        throw Object.assign(new Error('Agent profile key vault is unavailable; the profile was not deleted.'), { statusCode: 503 });
      }
      if (!this.botKeyStore.deleteKey && !this.botKeyStore.deactivateKey) {
        throw Object.assign(new Error('Agent profile key metadata cannot be retired; the profile was not deleted.'), { statusCode: 503 });
      }
      await this.brokerKeyVault.remove(keyRecord);
      if (this.botKeyStore.deleteKey) {
        this.botKeyStore.deleteKey(keyRecord.id);
        keyDisposition = 'deleted_from_vault';
      } else {
        this.botKeyStore.deactivateKey!(keyRecord.id);
        keyDisposition = 'deactivated_in_vault';
      }
    } else {
      const instanceIdentity = this.getInstanceIdentity();
      if (instanceIdentity?.npub !== record.botNpub) {
        throw Object.assign(new Error(
          'Agent profile key custody is missing or inconsistent; the profile was not deleted.',
        ), { statusCode: 409 });
      }
      keyDisposition = instanceIdentity.source === 'env'
        ? 'env_configuration_retained'
        : 'instance_identity_retained';
    }

    if (!this.agentStore.delete(agentId)) {
      throw new Error('Agent profile record could not be deleted after its signing key was retired.');
    }
    this.profilePolicyStore.deleteProfile(agentId, npub);
    return { agent: record, keyDisposition };
  }

  async importAgentConnectPackage(input: {
    managedByNpub: string;
    packageJson: string | Record<string, unknown>;
    agentProfileId?: string | null;
    allowedManagerNpubs?: string[];
    grantSharedService?: boolean;
    onboardingSource?: CreateWorkspaceSubscriptionInput['onboardingSource'];
    discoveryEvent?: CreateWorkspaceSubscriptionInput['discoveryEvent'];
  }): Promise<{
    backendConnection: BackendConnectionRecord;
    subscription: WorkspaceSubscriptionRecord;
    ignoredLocally?: boolean;
    staleDiscoveryEvent?: boolean;
  }> {
    const discoveredProfile = input.discoveryEvent?.recipientNpub
      ? this.agentStore.getByBotNpub(input.discoveryEvent.recipientNpub)
      : null;
    const agentProfileId = input.agentProfileId?.trim()
      || (discoveredProfile?.managedByNpub === input.managedByNpub ? discoveredProfile.agentId : null);
    const agentProfile = agentProfileId
      ? this.resolveOwnedAgentProfile(agentProfileId, input.managedByNpub)
      : null;
    const validation = validateAgentConnectPackage({
      managedByNpub: input.managedByNpub,
      packageJson: input.packageJson,
    });
    const validationIdentity = await this.resolveCreateBotIdentity(input.managedByNpub, agentProfile);
    if (validationIdentity.botSecret !== this.getInstanceIdentity()?.secretKey) {
      validationIdentity.botSecret.fill(0);
    }
    let backendConnection = await this.createOrReuseBackendConnection({
      managedByNpub: input.managedByNpub,
      backendBaseUrl: validation.service.directHttpsUrl,
      serviceNpub: validation.service.serviceNpub,
      setupWorkspaceOwnerNpub: validation.workspaceOwnerNpub,
      setupSourceAppNpub: validation.sourceAppNpub,
      setupSourceAppSchemaNamespace: validation.sourceAppSchemaNamespace,
      setupConnectionTokenRef: validation.connectionTokenRef,
      setupCapabilityDefaults: validation.capabilityDefaults,
      relayUrls: validation.service.relayUrls,
      openapiUrl: validation.service.openapiUrl,
      docsUrl: validation.service.docsUrl,
      healthUrl: validation.service.healthUrl,
      supportedVersion: validation.supportedVersion,
    });
    if (input.allowedManagerNpubs || input.grantSharedService !== undefined) {
      this.backendStore.replaceAvailabilityGrants({
        backendConnectionId: backendConnection.backendConnectionId,
        managerNpubs: input.allowedManagerNpubs ?? [],
        sharedService: input.grantSharedService === true,
      });
      backendConnection = this.backendStore.getById(backendConnection.backendConnectionId) ?? backendConnection;
    }
    const importResult = buildAgentConnectImportResult(validation, backendConnection);
    const subscription = await this.createOrUpdate({
      ...importResult.subscriptionInput,
      agentProfileId,
      onboardingSource: input.onboardingSource ?? 'agent_connect_import',
      discoveryEvent: input.discoveryEvent,
    });
    this.profilePolicyStore.ensureProfileWorkspaceForSubscription({
      managedByNpub: input.managedByNpub,
      agentProfileId: agentProfile?.agentId ?? agentProfileId,
      agentLabel: agentProfile?.label ?? null,
      agentNpub: subscription.botNpub,
      subscription,
      backendConnection,
      relayOnboardingStatus: subscription.wsKeyStatus === 'active' ? 'ready' : 'verified',
      workspaceTitle: validation.workspaceTitle,
    });
    return {
      backendConnection,
      subscription,
      ...(input.discoveryEvent && subscription.lifecycleStatus === 'locally_disconnected'
        ? { ignoredLocally: true }
        : {}),
      ...(input.discoveryEvent
        && subscription.discoveryEventId !== input.discoveryEvent.eventId
        && (subscription.discoveryEventCreatedAt ?? -1) >= input.discoveryEvent.createdAt
        ? { staleDiscoveryEvent: true }
        : {}),
    };
  }

  async createOrUpdate(input: CreateWorkspaceSubscriptionInput): Promise<WorkspaceSubscriptionRecord> {
    const requestedBackendConnectionId = input.backendConnectionId?.trim() || null;
    const requestedBackendConnection = requestedBackendConnectionId
      ? this.backendStore.getById(requestedBackendConnectionId)
      : null;
    if (requestedBackendConnectionId && !requestedBackendConnection) {
      throw new BackendConnectionNotFoundError(`Backend connection ${requestedBackendConnectionId} was not found.`);
    }
    if (
      requestedBackendConnection
      && !canUseBackendConnection(
        requestedBackendConnection,
        input.managedByNpub,
        this.backendStore,
        input.backendConnectionGrantKind ?? null,
      )
    ) {
      throw new WorkspaceSubscriptionAccessError(
        `Backend connection ${requestedBackendConnection.backendConnectionId} is not available to this manager.`,
      );
    }

    const backendBaseUrl = getOptionalText(input.backendBaseUrl)
      ? normaliseBackendBaseUrl(input.backendBaseUrl)
      : requestedBackendConnection?.backendBaseUrl ?? '';
    const workspaceOwnerNpub = getOptionalText(input.workspaceOwnerNpub)
      ?? requestedBackendConnection?.setupWorkspaceOwnerNpub
      ?? '';
    const sourceAppNpub = getOptionalText(input.sourceAppNpub)
      ?? requestedBackendConnection?.setupSourceAppNpub
      ?? '';
    const towerServiceNpub = getOptionalText(input.towerServiceNpub)
      ?? requestedBackendConnection?.serviceNpub
      ?? null;
    const workspaceId = getOptionalText(input.workspaceId);
    const workspaceServiceNpub = getOptionalText(input.workspaceServiceNpub);
    const sourceAppSchemaNamespace = getOptionalText(input.sourceAppSchemaNamespace)
      ?? requestedBackendConnection?.setupSourceAppSchemaNamespace
      ?? null;
    const connectionTokenRef = getOptionalText(input.connectionTokenRef)
      ?? requestedBackendConnection?.setupConnectionTokenRef
      ?? null;
    const capabilityDefaults = input.capabilityDefaults ?? requestedBackendConnection?.setupCapabilityDefaults ?? [];

    if (!backendBaseUrl || !workspaceOwnerNpub || !sourceAppNpub) {
      throw Object.assign(
        new Error('workspaceOwnerNpub, backendBaseUrl, and sourceAppNpub are required.'),
        { statusCode: 400 },
      );
    }

    const agentProfile = input.agentProfileId
      ? this.resolveOwnedAgentProfile(input.agentProfileId, input.managedByNpub)
      : null;
    const botIdentity = await this.resolveCreateBotIdentity(input.managedByNpub, agentProfile);
    if (agentProfile && botIdentity.botNpub !== agentProfile.botNpub) {
      throw new Error(`Agent Profile ${agentProfile.agentId} bot key does not match its botNpub.`);
    }
    const backendConnection = requestedBackendConnection
      ?? await this.createOrReuseBackendConnection({
          managedByNpub: input.managedByNpub,
          backendBaseUrl,
          serviceNpub: towerServiceNpub,
          setupWorkspaceOwnerNpub: workspaceOwnerNpub,
          setupSourceAppNpub: sourceAppNpub,
          setupSourceAppSchemaNamespace: sourceAppSchemaNamespace,
          setupConnectionTokenRef: connectionTokenRef,
          setupCapabilityDefaults: capabilityDefaults,
        });
    const subscriptionBackendBaseUrl = backendConnection?.backendBaseUrl ?? backendBaseUrl;

    const scopedRecord = this.store.getBySubscriptionScope({
      backendConnectionId: backendConnection?.backendConnectionId ?? null,
      managedByNpub: input.managedByNpub,
      workspaceOwnerNpub,
      sourceAppNpub,
      botNpub: botIdentity.botNpub,
      agentProfileId: agentProfile?.agentId ?? input.agentProfileId ?? null,
      towerServiceNpub,
      workspaceId,
      workspaceServiceNpub,
    });
    const legacyRecord = this.store.getByWorkspaceAndBot(workspaceOwnerNpub, botIdentity.botNpub);
    const legacyIdentityCompatible = Boolean(
      legacyRecord
      && (!towerServiceNpub || !legacyRecord.towerServiceNpub || legacyRecord.towerServiceNpub === towerServiceNpub)
      && (!workspaceId || !legacyRecord.workspaceId || legacyRecord.workspaceId === workspaceId)
      && (!workspaceServiceNpub || !legacyRecord.workspaceServiceNpub || legacyRecord.workspaceServiceNpub === workspaceServiceNpub)
    );
    const canReuseLegacyRecord = Boolean(
      legacyRecord
      && legacyIdentityCompatible
      && (!legacyRecord.managedByNpub || legacyRecord.managedByNpub === input.managedByNpub)
      && legacyRecord.sourceAppNpub === sourceAppNpub
      && (
        legacyRecord.backendConnectionId === (backendConnection?.backendConnectionId ?? null)
        || (
          !legacyRecord.backendConnectionId
          && normaliseBackendBaseUrl(legacyRecord.backendBaseUrl) === subscriptionBackendBaseUrl
        )
      ),
    );
    let record = scopedRecord
      ?? (canReuseLegacyRecord ? legacyRecord : null)
      ?? this.store.createDefault({
        managedByNpub: input.managedByNpub,
        workspaceOwnerNpub,
        backendBaseUrl: subscriptionBackendBaseUrl,
        towerServiceNpub,
        workspaceId,
        workspaceServiceNpub,
        botNpub: botIdentity.botNpub,
        sourceAppNpub,
        backendConnectionId: backendConnection?.backendConnectionId ?? null,
        onboardingSource: input.onboardingSource ?? 'manual',
        connectionTokenRef,
        agentProfileId: agentProfile?.agentId ?? input.agentProfileId ?? null,
        sourceAppSchemaNamespace,
        capabilityDefaults,
        dispatchRouteIds: input.dispatchRouteIds ?? [],
        triggerConfigRecordId: input.triggerConfigRecordId ?? null,
      });

    const discoveryEvent = input.discoveryEvent;
    if (discoveryEvent) {
      const currentCreatedAt = record.discoveryEventCreatedAt;
      const sameTimestampWins = currentCreatedAt === discoveryEvent.createdAt
        && Boolean(record.discoveryEventId)
        && record.discoveryEventId! < discoveryEvent.eventId;
      const staleReplacement = currentCreatedAt != null && (
        currentCreatedAt > discoveryEvent.createdAt || sameTimestampWins
      );
      const disconnectedAt = Math.floor(Date.parse(record.lifecycleChangedAt || record.updatedAt) / 1000);
      const disconnectedWatermark = Math.max(
        Number.isFinite(disconnectedAt) ? disconnectedAt : 0,
        currentCreatedAt ?? 0,
      );
      if (
        staleReplacement
        || (record.lifecycleStatus === 'locally_disconnected' && discoveryEvent.createdAt <= disconnectedWatermark)
      ) {
        return record;
      }
    }

    record.backendConnectionId = backendConnection?.backendConnectionId ?? record.backendConnectionId ?? null;
    record.backendBaseUrl = subscriptionBackendBaseUrl;
    record.towerServiceNpub = towerServiceNpub ?? record.towerServiceNpub ?? backendConnection?.serviceNpub ?? null;
    record.workspaceId = workspaceId ?? record.workspaceId ?? null;
    record.workspaceServiceNpub = workspaceServiceNpub ?? record.workspaceServiceNpub ?? null;
    record.workspaceOwnerNpub = workspaceOwnerNpub;
    record.sourceAppNpub = sourceAppNpub;
    record.onboardingSource = input.onboardingSource ?? record.onboardingSource ?? 'manual';
    record.lifecycleStatus = 'active';
    record.lifecycleChangedAt = new Date().toISOString();
    if (discoveryEvent) {
      record.discoveryEventId = discoveryEvent.eventId;
      record.discoveryEventCreatedAt = discoveryEvent.createdAt;
      record.discoveryDedupeKey = discoveryEvent.dedupeKey;
    }
    record.connectionTokenRef = connectionTokenRef ?? record.connectionTokenRef ?? null;
    record.agentProfileId = agentProfile?.agentId ?? input.agentProfileId ?? record.agentProfileId ?? null;
    record.sourceAppSchemaNamespace = sourceAppSchemaNamespace ?? record.sourceAppSchemaNamespace ?? null;
    record.capabilityDefaults = capabilityDefaults.length > 0 ? capabilityDefaults : record.capabilityDefaults ?? [];
    record.dispatchRouteIds = input.dispatchRouteIds ?? record.dispatchRouteIds ?? [];
    record.triggerConfigRecordId = input.triggerConfigRecordId ?? null;
    record.managedByNpub = input.managedByNpub;
    if (isFlightDeckPgSubscription(record)) {
      record = await this.prepareFlightDeckPgSubscription(record, botIdentity);
      record = await this.verifyFlightDeckPgWorkspaceAccess(record, botIdentity);
      await this.ensureConnected(record, botIdentity, false);
      const saved = this.store.getBySubscriptionId(record.subscriptionId) ?? record;
      const subscriptionAgents = this.agentStore
        .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(saved), saved.botNpub)
        .filter((agent) => agent.managedByNpub === saved.managedByNpub)
        .filter((agent) => agent.enabled);
      const routeCapabilities = subscriptionAgents.length > 0
        ? [...new Set(subscriptionAgents.flatMap((agent) => agent.capabilities))]
        : saved.capabilityDefaults ?? [];
      this.ensureDefaultDispatchRoutesForSubscription(saved, routeCapabilities);
      await this.ensureOnboardedAgentForSubscription({
        subscription: saved,
        agentProfile,
        botIdentity,
      });
      return saved;
    }
    record = await this.prepareWorkspaceSession(record, botIdentity);

    try {
      record = await this.registerWorkspaceKey(record, botIdentity);
      this.clearRuntimeFailure(record.subscriptionId, 'workspace_key_registered');
    } catch (error) {
      record.wsKeyStatus = 'failed';
      record.sseStatus = 'disconnected';
      record.healthStatus = 'unhealthy';
      record.lastErrorCode = 'workspace_key_register_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastAuthResult = buildFailureDiagnostic(
        'workspace_key_register_failed',
        error instanceof Error ? error.message : 'Workspace key registration failed.',
        typeof (error as { detailCode?: string })?.detailCode === 'string' ? (error as { detailCode: string }).detailCode : null,
      );
      const saved = this.saveRecord(record);
      this.markRuntimeFailure(
        saved.subscriptionId,
        getErrorDetailCode(error) ?? 'workspace_key_register_failed',
        'workspace_key_register_failed',
      );
      return saved;
    }

    record = await this.refreshGroupKeys(record, botIdentity, true);
    await this.ensureConnected(record, botIdentity, false);
    const saved = this.store.getBySubscriptionId(record.subscriptionId) ?? record;
    const subscriptionAgents = this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(saved), saved.botNpub)
      .filter((agent) => agent.managedByNpub === saved.managedByNpub)
      .filter((agent) => agent.enabled);
    const routeCapabilities = subscriptionAgents.length > 0
      ? [...new Set(subscriptionAgents.flatMap((agent) => agent.capabilities))]
      : saved.capabilityDefaults ?? [];
    this.ensureDefaultDispatchRoutesForSubscription(saved, routeCapabilities);
    await this.ensureOnboardedAgentForSubscription({
      subscription: saved,
      agentProfile,
      botIdentity,
    });
    return saved;
  }

  async startupReload(): Promise<void> {
    const records = this.store.listStartupCandidates();
    for (const record of records) {
      try {
        const botIdentity = await this.resolveStoredBotIdentity(record.botNpub);
        if (!botIdentity) {
          const failed = {
            ...record,
            wsKeyStatus: 'failed' as const,
            healthStatus: 'unhealthy' as const,
            lastErrorCode: 'workspace_key_register_failed',
            lastErrorAt: new Date().toISOString(),
            lastAuthResult: buildFailureDiagnostic(
              'workspace_key_register_failed',
              `Bot key record not found for ${record.botNpub}.`,
              'workspace_key_missing',
            ),
          };
          const saved = this.saveRecord(failed);
          this.markRuntimeFailure(saved.subscriptionId, 'workspace_key_register_failed', 'startup_reload_failed');
          continue;
        }

        const refreshed = isFlightDeckPgSubscription(record)
          ? await this.verifyFlightDeckPgWorkspaceAccess(
            await this.prepareFlightDeckPgSubscription(record, botIdentity),
            botIdentity,
          )
          : await this.refreshGroupKeys(
            await this.prepareWorkspaceSession(record, botIdentity),
            botIdentity,
            false,
          );
        refreshed.lastSuccessfulStartupReloadAt = new Date().toISOString();
        this.saveRecord(refreshed);
        this.clearRuntimeFailure(refreshed.subscriptionId, 'startup_reload_recovered');
        await this.ensureConnected(refreshed, botIdentity, true);
        const subscriptionAgents = this.agentStore
          .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(refreshed), refreshed.botNpub)
          .filter((agent) => agent.managedByNpub === refreshed.managedByNpub)
          .filter((agent) => agent.enabled);
        const routeCapabilities = subscriptionAgents.length > 0
          ? [...new Set(subscriptionAgents.flatMap((agent) => agent.capabilities))]
          : refreshed.capabilityDefaults ?? [];
        this.ensureDefaultDispatchRoutesForSubscription(refreshed, routeCapabilities);
        await this.replayPendingIntercepts(refreshed, botIdentity);
      } catch (error) {
        const failed = {
          ...record,
          healthStatus: 'unhealthy' as const,
          lastErrorCode: 'workspace_key_register_failed',
          lastErrorAt: new Date().toISOString(),
          lastAuthResult: buildFailureDiagnostic(
            'workspace_key_register_failed',
            error instanceof Error ? error.message : 'Startup reload failed.',
            'workspace_auth_failed',
          ),
        };
        const saved = this.saveRecord(failed);
        this.markRuntimeFailure(
          saved.subscriptionId,
          getErrorDetailCode(error) ?? 'workspace_auth_failed',
          'startup_reload_failed',
        );
      }
    }
  }

  removeForManager(subscriptionId: string, npub: string): boolean {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return false;
    }
    this.stopRuntime(subscriptionId, true);
    this.dispatchPipelineRuntime?.deleteRoutesForSubscriptionForManager(subscriptionId, npub);
    if (record.onboardingSource === 'nostr_33357') {
      const now = new Date().toISOString();
      this.saveRecord({
        ...record,
        lifecycleStatus: 'locally_disconnected',
        lifecycleChangedAt: now,
        sseStatus: 'disabled',
        healthStatus: 'degraded',
        lastErrorCode: 'workspace_disconnected_locally',
        lastErrorAt: now,
        lastAuthResult: buildFailureDiagnostic(
          'workspace_disconnected_locally',
          'This workspace connection was disconnected locally. Tower workspace data and membership were not changed.',
          'local_disconnect',
        ),
      });
      return true;
    }
    const removed = this.store.delete(subscriptionId);
    return removed;
  }

  async handleAccessGrantRevocation(input: {
    managedByNpub: string;
    agentProfileId?: string | null;
    grant: DecodedAccessGrant;
    verification: TowerRevocationVerificationResult;
  }): Promise<{
    matchedSubscriptions: number;
    updatedSubscriptions: WorkspaceSubscriptionRecord[];
    selfIndexRefresh: Record<string, unknown> | null;
  }> {
    const expectedBackendUrl = normaliseBackendBaseUrl(input.grant.payload.service.direct_https_url);
    const expectedTowerServiceNpub = input.grant.serviceNpub;
    const expectedWorkspaceId = getOptionalText(input.grant.payload.workspace.workspace_id);
    const expectedWorkspaceServiceNpub = input.grant.workspaceServiceNpub;
    const candidates = this.store.listForManagerNpub(input.managedByNpub).filter((record) => {
      const sameBackend = normaliseBackendBaseUrl(record.backendBaseUrl) === expectedBackendUrl;
      const backendConnection = record.backendConnectionId
        ? this.backendStore.getById(record.backendConnectionId)
        : null;
      const recordTowerServiceNpub = record.towerServiceNpub ?? backendConnection?.serviceNpub ?? null;
      const sameTowerService = expectedTowerServiceNpub
        ? recordTowerServiceNpub === expectedTowerServiceNpub
        : true;
      const sameWorkspaceId = expectedWorkspaceId
        ? record.workspaceId === expectedWorkspaceId
        : true;
      const sameWorkspaceService = record.workspaceServiceNpub === expectedWorkspaceServiceNpub;
      const sameWorkspace = record.workspaceOwnerNpub === input.grant.workspaceOwnerNpub;
      const sameApp = record.sourceAppNpub === input.grant.appNpub;
      const sameRecipient = record.botNpub === input.grant.recipientNpub;
      const sameProfile = input.agentProfileId ? record.agentProfileId === input.agentProfileId : true;
      return sameBackend
        && sameTowerService
        && sameWorkspaceId
        && sameWorkspaceService
        && sameWorkspace
        && sameApp
        && sameRecipient
        && sameProfile;
    });

    const updatedSubscriptions: WorkspaceSubscriptionRecord[] = [];
    const selfIndexRefresh = input.verification.confirmed
      ? this.buildAccessGrantRevocationSelfIndex(input.grant, input.verification)
      : null;

    for (const record of candidates) {
      if (!input.verification.confirmed) {
        updatedSubscriptions.push(this.saveRecord({
          ...record,
          lastErrorCode: 'workspace_revocation_unconfirmed',
          lastErrorAt: new Date().toISOString(),
          lastAuthResult: buildFailureDiagnostic(
            'workspace_revocation_unconfirmed',
            input.verification.message,
            input.verification.towerResult,
            {
              source_33357_event_id: input.grant.event.id,
              tower_result: input.verification.towerResult,
              workspace_owner_npub: input.grant.workspaceOwnerNpub,
              workspace_service_npub: input.grant.workspaceServiceNpub,
              app_npub: input.grant.appNpub,
            },
          ),
        }));
        continue;
      }

      this.stopRuntime(record.subscriptionId, true);
      const lifecycleStatus = input.verification.towerResult === 'workspace_deleted'
        || input.verification.towerResult === 'workspace_not_found'
        || input.grant.payload.action === 'deleted'
        ? 'deleted'
        : 'revoked';
      const now = new Date().toISOString();
      const revocationIsNewestDiscovery = record.discoveryEventCreatedAt == null
        || input.grant.event.created_at > record.discoveryEventCreatedAt
        || (
          input.grant.event.created_at === record.discoveryEventCreatedAt
          && (!record.discoveryEventId || input.grant.event.id < record.discoveryEventId)
        );
      const revocationEvent = {
        eventId: input.grant.event.id,
        eventType: `workspace-${lifecycleStatus}`,
        at: now,
        payload: {
          tower_result: input.verification.towerResult,
          action: input.grant.payload.action,
          reason: input.grant.payload.revocation?.reason ?? input.grant.payload.grant?.reason ?? null,
        },
      };
      const saved = this.saveRecord(this.recomputeHealth({
        ...record,
        lifecycleStatus,
        lifecycleChangedAt: now,
        discoveryEventId: revocationIsNewestDiscovery ? input.grant.event.id : record.discoveryEventId,
        discoveryEventCreatedAt: revocationIsNewestDiscovery
          ? input.grant.event.created_at
          : record.discoveryEventCreatedAt,
        discoveryDedupeKey: revocationIsNewestDiscovery ? input.grant.dedupeKey : record.discoveryDedupeKey,
        wsKeyStatus: 'revoked',
        groupKeyStatus: 'revoked',
        sseStatus: 'disabled',
        lastErrorCode: 'workspace_access_revoked',
        lastErrorAt: now,
        lastAuthResult: buildFailureDiagnostic(
          'workspace_access_revoked',
          input.verification.message,
          input.verification.towerResult,
          {
            source_33357_event_id: input.grant.event.id,
            tower_result: input.verification.towerResult,
            workspace_owner_npub: input.grant.workspaceOwnerNpub,
            workspace_service_npub: input.grant.workspaceServiceNpub,
            app_npub: input.grant.appNpub,
          },
        ),
        lastRecordPullResult: buildSuccessDiagnostic(
          'Workspace self-index tombstone refreshed after confirmed revocation.',
          selfIndexRefresh,
        ),
        lastSseEvent: revocationEvent,
        recentSseEvents: trimRecentEntries(
          [...(Array.isArray(record.recentSseEvents) ? record.recentSseEvents : []), revocationEvent],
          MAX_RECENT_SSE_EVENTS,
        ),
      }));
      this.markRuntimeFailure(saved.subscriptionId, 'workspace_access_denied', 'access_grant_revoked');
      if (saved.managedByNpub) {
        const backendConnection = saved.backendConnectionId
          ? this.backendStore.getById(saved.backendConnectionId)
          : null;
        this.profilePolicyStore.ensureProfileWorkspaceForSubscription({
          managedByNpub: saved.managedByNpub,
          agentProfileId: saved.agentProfileId ?? saved.botNpub,
          agentLabel: null,
          agentNpub: saved.botNpub,
          subscription: saved,
          backendConnection,
          relayOnboardingStatus: lifecycleStatus,
        });
      }
      updatedSubscriptions.push(saved);
    }

    return {
      matchedSubscriptions: candidates.length,
      updatedSubscriptions,
      selfIndexRefresh,
    };
  }

  async reconnectForManager(subscriptionId: string, npub: string): Promise<WorkspaceSubscriptionRecord | null> {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return null;
    }
    if (isRevokedWorkspaceSubscription(record)) {
      throw new Error('Subscription access was revoked by Tower verification and cannot be reconnected.');
    }
    if (record.sseStatus === 'disabled') {
      throw new Error('Subscription is disabled. Re-enable it before reconnecting.');
    }
    return await this.repairSubscription(record, {
      refreshWorkspaceKey: false,
      reconnect: true,
      allowRegisterWhenInactive: false,
      reason: 'operator_reconnect',
    });
  }

  async refreshKeysForManager(subscriptionId: string, npub: string): Promise<WorkspaceSubscriptionRecord | null> {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return null;
    }
    if (isRevokedWorkspaceSubscription(record)) {
      throw new Error('Subscription access was revoked by Tower verification and cannot refresh keys.');
    }
    return await this.repairSubscription(record, {
      refreshWorkspaceKey: true,
      reconnect: record.sseStatus !== 'disabled',
      allowRegisterWhenInactive: true,
      reason: 'operator_refresh_keys',
    });
  }

  async setEnabledForManager(
    subscriptionId: string,
    npub: string,
    enabled: boolean,
  ): Promise<WorkspaceSubscriptionRecord | null> {
    const record = this.getForManager(subscriptionId, npub);
    if (!record) {
      return null;
    }
    if (enabled && isRevokedWorkspaceSubscription(record)) {
      throw new Error('Subscription access was revoked by Tower verification and cannot be re-enabled.');
    }
    if (!enabled) {
      this.stopRuntime(subscriptionId, false);
      const disabled = this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
      }));
      return disabled;
    }

    const reenabled = this.saveRecord(this.recomputeHealth({
      ...record,
      sseStatus: 'disconnected',
    }));
    return await this.repairSubscription(reenabled, {
      refreshWorkspaceKey: false,
      reconnect: true,
      allowRegisterWhenInactive: true,
      reason: 'operator_enable',
    });
  }

  shutdown(): void {
    for (const subscriptionId of this.runtimes.keys()) {
      this.stopRuntime(subscriptionId, true);
    }
  }

  private buildAccessGrantRevocationSelfIndex(
    grant: DecodedAccessGrant,
    verification: TowerRevocationVerificationResult,
  ): Record<string, unknown> {
    const deleted = verification.towerResult === 'workspace_deleted'
      || verification.towerResult === 'workspace_not_found'
      || grant.payload.action === 'deleted';
    const now = new Date().toISOString();
    return {
      type: 'flightdeck_workspace_self_index',
      version: 1,
      updated_at: now,
      user_npub: grant.recipientNpub,
      app: {
        app_npub: grant.appNpub,
        namespace: grant.payload.app.namespace ?? 'flightdeck_pg',
      },
      workspace: {
        tower_base_url: grant.payload.service.direct_https_url,
        tower_service_npub: grant.serviceNpub,
        workspace_id: grant.payload.workspace.workspace_id ?? null,
        workspace_service_npub: grant.workspaceServiceNpub,
        workspace_owner_npub: grant.workspaceOwnerNpub,
        app_npub: grant.appNpub,
      },
      verification: {
        last_checked_at: verification.checkedAt,
        verified_by: 'autopilot',
        tower_result: verification.towerResult,
      },
      state: {
        deleted,
        status: deleted ? 'deleted' : 'revoked',
        deleted_at: deleted ? now : null,
        revoked_at: deleted ? null : now,
        reason: grant.payload.revocation?.reason ?? grant.payload.grant?.reason ?? verification.towerResult,
        source_33357_event_id: grant.event.id,
      },
    };
  }

  private resolveOwnedAgentProfile(agentProfileId: string, managedByNpub: string): AgentDefinitionRecord {
    const agent = this.agentStore.getByAgentId(agentProfileId);
    if (!agent) {
      throw new Error(`Agent Profile ${agentProfileId} was not found.`);
    }
    if (agent.managedByNpub !== managedByNpub) {
      throw new Error(`Agent Profile ${agentProfileId} is owned by another manager.`);
    }
    if (!agent.botNpub) {
      throw new Error(`Agent Profile ${agentProfileId} does not have a bot NPUB.`);
    }
    return agent;
  }

  private getInstanceRuntimeBotIdentity(expectedBotNpub?: string | null): RuntimeBotIdentity | null {
    const identity = this.getInstanceIdentity();
    if (!identity) {
      return null;
    }
    if (expectedBotNpub && identity.npub !== expectedBotNpub) {
      return null;
    }
    return {
      botNpub: identity.npub,
      botPubkeyHex: identity.pubkeyHex,
      botSecret: identity.secretKey,
    };
  }

  private async resolveCreateBotIdentity(
    managedByNpub: string,
    agentProfile: AgentDefinitionRecord | null,
  ): Promise<RuntimeBotIdentity> {
    const instanceIdentity = this.getInstanceRuntimeBotIdentity(agentProfile?.botNpub ?? null);
    if (instanceIdentity) {
      return instanceIdentity;
    }

    let botRecord = agentProfile
      ? this.botKeyStore.getActiveKeyForBotNpub(agentProfile.botNpub)
      : this.botKeyStore.getActiveKeyForUser(managedByNpub);
    if (!botRecord) {
      if (agentProfile) {
        throw new Error(`No active bot key exists for Agent Profile ${agentProfile.agentId}.`);
      }
      if (!this.botKeyStore.createKey) {
        throw new Error('No active bot key exists for this user.');
      }
      const decoded = nip19.decode(managedByNpub);
      if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
        throw new Error('Cannot create agent-chat bot key for invalid manager npub.');
      }
      const generated = generateBotKey(decoded.data);
      botRecord = this.botKeyStore.createKey({
        userNpub: managedByNpub,
        botPubkeyHex: generated.botPubkeyHex,
        botNpub: generated.botNpub,
        displayName: generated.displayName,
        encryptedToUser: generated.encryptedToUser,
        encryptedEscrow: generated.encryptedEscrow,
        escrowUuid: generated.escrowUuid,
      });
    }

    return this.resolveSubscriptionBotIdentity(botRecord);
  }

  private async resolveStoredBotIdentity(botNpub: string): Promise<RuntimeBotIdentity | null> {
    const instanceIdentity = this.getInstanceRuntimeBotIdentity(botNpub);
    if (instanceIdentity) {
      return instanceIdentity;
    }
    const botRecord = this.botKeyStore.getActiveKeyForBotNpub(botNpub);
    return botRecord ? this.resolveSubscriptionBotIdentity(botRecord) : null;
  }

  private async createOrReuseBackendConnection(input: {
    managedByNpub: string;
    backendBaseUrl: string;
    serviceNpub?: string | null;
    setupWorkspaceOwnerNpub?: string | null;
    setupSourceAppNpub?: string | null;
    setupSourceAppSchemaNamespace?: string | null;
    setupConnectionTokenRef?: string | null;
    setupCapabilityDefaults?: BackendConnectionRecord['setupCapabilityDefaults'];
    relayUrls?: string[];
    openapiUrl?: string | null;
    docsUrl?: string | null;
    healthUrl?: string | null;
    supportedVersion?: string | null;
  }): Promise<BackendConnectionRecord> {
    const backendBaseUrl = normaliseBackendBaseUrl(input.backendBaseUrl);
    const existing = this.backendStore.findReusable({
      managedByNpub: input.managedByNpub,
      backendBaseUrl,
      serviceNpub: input.serviceNpub ?? null,
    });
    if (existing) {
      const saved = this.backendStore.save({
        ...existing,
        serviceNpub: input.serviceNpub ?? existing.serviceNpub,
        setupWorkspaceOwnerNpub: input.setupWorkspaceOwnerNpub ?? existing.setupWorkspaceOwnerNpub,
        setupSourceAppNpub: input.setupSourceAppNpub ?? existing.setupSourceAppNpub,
        setupSourceAppSchemaNamespace: input.setupSourceAppSchemaNamespace ?? existing.setupSourceAppSchemaNamespace,
        setupConnectionTokenRef: input.setupConnectionTokenRef ?? existing.setupConnectionTokenRef,
        setupCapabilityDefaults: input.setupCapabilityDefaults ?? existing.setupCapabilityDefaults,
        relayUrls: input.relayUrls ?? existing.relayUrls,
        openapiUrl: input.openapiUrl ?? existing.openapiUrl,
        docsUrl: input.docsUrl ?? existing.docsUrl,
        healthUrl: input.healthUrl ?? existing.healthUrl,
        supportedVersion: input.supportedVersion ?? existing.supportedVersion,
        updatedAt: new Date().toISOString(),
      });
      return await this.checkAndSaveBackendHealth(saved);
    }
    const created = this.backendStore.save(this.backendStore.createDefault({
      managedByNpub: input.managedByNpub,
      backendBaseUrl,
      serviceNpub: input.serviceNpub ?? null,
      setupWorkspaceOwnerNpub: input.setupWorkspaceOwnerNpub ?? null,
      setupSourceAppNpub: input.setupSourceAppNpub ?? null,
      setupSourceAppSchemaNamespace: input.setupSourceAppSchemaNamespace ?? null,
      setupConnectionTokenRef: input.setupConnectionTokenRef ?? null,
      setupCapabilityDefaults: input.setupCapabilityDefaults ?? [],
      relayUrls: input.relayUrls ?? [],
      openapiUrl: input.openapiUrl ?? null,
      docsUrl: input.docsUrl ?? null,
      healthUrl: input.healthUrl ?? null,
      supportedVersion: input.supportedVersion ?? null,
    }));
    return await this.checkAndSaveBackendHealth(created);
  }

  private async checkAndSaveBackendHealth(record: BackendConnectionRecord): Promise<BackendConnectionRecord> {
    const result = await this.checkBackendHealthImpl(record);
    return this.backendStore.save({
      ...record,
      healthStatus: result.healthStatus,
      lastHealthResult: result.diagnostic,
      updatedAt: new Date().toISOString(),
    });
  }

  private async prepareWorkspaceSession(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    options: { forceNew?: boolean } = {},
  ): Promise<WorkspaceSubscriptionRecord> {
    const helpers = await loadYokeBotHelpers();
    const blob = !options.forceNew && record.wsKeyBlobJson
      ? JSON.parse(record.wsKeyBlobJson) as Record<string, unknown>
      : null;
    const loaded = blob
      ? { blob, ...helpers.loadBotWorkspaceKey({ blob, botSecret: botIdentity.botSecret, botNpub: botIdentity.botNpub }) }
      : helpers.createBotWorkspaceKey({
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(record),
      });

    const nextRecord = { ...record };
    nextRecord.wsKeyNpub = loaded.wsSession.npub;
    nextRecord.wsKeyBlobJson = JSON.stringify(loaded.blob);

    const existingRuntime = this.runtimes.get(record.subscriptionId);
    if (existingRuntime?.botIdentity?.botSecret && existingRuntime.botIdentity.botSecret !== botIdentity.botSecret) {
      existingRuntime.botIdentity.botSecret.fill(0);
    }
    this.runtimes.set(record.subscriptionId, {
      abortController: existingRuntime?.abortController ?? null,
      reconnectTimer: existingRuntime?.reconnectTimer ?? null,
      reconnectAttempts: existingRuntime?.reconnectAttempts ?? 0,
      botIdentity,
      wsSession: loaded.wsSession,
      groupKeys: existingRuntime?.groupKeys ?? null,
      wrappedKeyRows: existingRuntime?.wrappedKeyRows ?? (record.wrappedGroupKeysJson ? JSON.parse(record.wrappedGroupKeysJson) as unknown[] : []),
      flightDeckPgActorId: existingRuntime?.flightDeckPgActorId ?? null,
      removed: false,
    });
    return this.saveRecord(nextRecord);
  }

  private async prepareFlightDeckPgSubscription(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
  ): Promise<WorkspaceSubscriptionRecord> {
    const existingRuntime = this.runtimes.get(record.subscriptionId);
    if (existingRuntime?.botIdentity?.botSecret && existingRuntime.botIdentity.botSecret !== botIdentity.botSecret) {
      existingRuntime.botIdentity.botSecret.fill(0);
    }
    this.runtimes.set(record.subscriptionId, {
      abortController: existingRuntime?.abortController ?? null,
      reconnectTimer: existingRuntime?.reconnectTimer ?? null,
      reconnectAttempts: existingRuntime?.reconnectAttempts ?? 0,
      botIdentity,
      wsSession: null,
      groupKeys: null,
      wrappedKeyRows: [],
      flightDeckPgActorId: existingRuntime?.flightDeckPgActorId ?? null,
      removed: false,
    });

    return this.saveRecord({
      ...record,
      wsKeyNpub: botIdentity.botNpub,
      wsKeyBlobJson: null,
      wrappedGroupKeysJson: null,
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      lastAuthOkAt: record.lastAuthOkAt ?? new Date().toISOString(),
      lastGroupRefreshAt: record.lastGroupRefreshAt ?? new Date().toISOString(),
      lastAuthResult: record.lastAuthResult ?? buildSuccessDiagnostic('Flight Deck PG bot auth prepared.', {
        workspace_id: record.workspaceId,
        workspace_service_npub: record.workspaceServiceNpub,
        bot_npub: botIdentity.botNpub,
      }),
      lastGroupRefreshResult: record.lastGroupRefreshResult ?? buildSuccessDiagnostic('Flight Deck PG uses Tower permissions instead of wrapped group keys.', {
        workspace_id: record.workspaceId,
      }),
    });
  }

  private async verifyFlightDeckPgWorkspaceAccess(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    options: { signal?: AbortSignal; throwOnRetryable?: boolean } = {},
  ): Promise<WorkspaceSubscriptionRecord> {
    if (!record.workspaceId) {
      throw Object.assign(new Error('Flight Deck PG workspace id is required.'), { detailCode: 'workspace_id_missing' });
    }
    try {
      const result = await this.fetchFlightDeckPgWorkspaceMeImpl({
        backendBaseUrl: record.backendBaseUrl,
        workspaceId: record.workspaceId,
        appNpub: record.sourceAppNpub,
        botIdentity,
        signal: options.signal,
      });
      const actorId = typeof result.actor?.actor_id === 'string' ? result.actor.actor_id : null;
      this.getRuntime(record.subscriptionId).flightDeckPgActorId = actorId;
      record.wsKeyStatus = 'active';
      record.groupKeyStatus = 'active';
      record.lastAuthOkAt = new Date().toISOString();
      record.lastGroupRefreshAt = record.lastAuthOkAt;
      record.lastAuthResult = buildSuccessDiagnostic('Flight Deck PG workspace access verified.', {
        workspace_id: record.workspaceId,
        workspace_service_npub: record.workspaceServiceNpub,
        bot_npub: botIdentity.botNpub,
        actor_id: actorId,
        role: result.membership?.role ?? null,
        permissions: result.permissions ?? [],
      });
      record.lastGroupRefreshResult = buildSuccessDiagnostic('Flight Deck PG permissions loaded from Tower.', {
        workspace_id: record.workspaceId,
        permission_count: Array.isArray(result.permissions) ? result.permissions.length : 0,
      });
      if (record.lastErrorCode !== FLIGHT_DECK_PG_EVENT_POLL_STALE_CODE) {
        record.lastErrorCode = null;
        record.lastErrorAt = null;
      }
      const saved = this.saveRecord(this.recomputeHealth(record));
      this.clearRuntimeFailure(saved.subscriptionId, 'flightdeck_pg_access_verified');
      return saved;
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      const retryable = isRetryableTowerAccessError(error);
      const diagnosticCode = retryable
        ? FLIGHT_DECK_PG_ACCESS_RETRY_CODE
        : FLIGHT_DECK_PG_ACCESS_FAILED_CODE;
      record.wsKeyStatus = retryable && record.wsKeyStatus === 'active' ? 'active' : retryable ? 'pending' : 'failed';
      record.healthStatus = retryable ? 'degraded' : 'unhealthy';
      record.sseStatus = retryable ? 'backoff' : 'disconnected';
      record.lastErrorCode = diagnosticCode;
      record.lastErrorAt = new Date().toISOString();
      record.lastAuthResult = buildFailureDiagnostic(
        diagnosticCode,
        error instanceof Error ? error.message : 'Flight Deck PG workspace access check failed.',
        diagnosticCode,
        {
          workspace_id: record.workspaceId,
          workspace_service_npub: record.workspaceServiceNpub,
          bot_npub: botIdentity.botNpub,
          retryable,
          source_detail_code: getErrorDetailCode(error),
        },
      );
      const saved = this.saveRecord(this.recomputeHealth(record));
      if (!retryable) {
        this.markRuntimeFailure(
          saved.subscriptionId,
          getErrorDetailCode(error) ?? FLIGHT_DECK_PG_ACCESS_FAILED_CODE,
          FLIGHT_DECK_PG_ACCESS_FAILED_CODE,
        );
      }
      if (retryable && options.throwOnRetryable) {
        const message = error instanceof Error
          ? error.message
          : 'Flight Deck PG workspace access check failed.';
        throw Object.assign(new Error(message, { cause: error }), {
          detailCode: FLIGHT_DECK_PG_ACCESS_RETRY_CODE,
        });
      }
      return saved;
    }
  }

  private async registerWorkspaceKey(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
  ): Promise<WorkspaceSubscriptionRecord> {
    const helpers = await loadYokeBotHelpers();
    const attempt = async (current: WorkspaceSubscriptionRecord) => {
      const effectiveWorkspaceNpub = this.getEffectiveWorkspaceNpub(current);
      const authorization = helpers.signBotRequest({
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        url: new URL('/api/v4/user/workspace-keys', current.backendBaseUrl).toString(),
        method: 'POST',
        body: {
          workspace_owner_npub: effectiveWorkspaceNpub,
          workspace_service_npub: effectiveWorkspaceNpub,
          human_workspace_owner_npub: current.workspaceOwnerNpub,
          ws_key_npub: current.wsKeyNpub,
          workspace_user_key_npub: current.wsKeyNpub,
        },
      });
      await registerWorkspaceKeyWithTower({
        backendBaseUrl: current.backendBaseUrl,
        workspaceNpub: effectiveWorkspaceNpub,
        workspaceOwnerNpub: current.workspaceOwnerNpub,
        wsKeyNpub: current.wsKeyNpub!,
        authorization,
      });
      current.wsKeyStatus = 'active';
      current.lastAuthOkAt = new Date().toISOString();
      current.lastAuthResult = buildSuccessDiagnostic('Workspace key registered.', {
        workspace_owner_npub: current.workspaceOwnerNpub,
        workspace_service_npub: effectiveWorkspaceNpub,
        ws_key_npub: current.wsKeyNpub,
      });
      current.lastErrorCode = null;
      current.lastErrorAt = null;
      return current;
    };

    try {
      return await attempt(record);
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : null;
      if (status !== 409) {
        throw error;
      }

      const refreshed = await this.prepareWorkspaceSession(record, botIdentity, { forceNew: true });
      const retried = await attempt(refreshed);
      retried.lastAuthResult = buildSuccessDiagnostic('Workspace key registered.', {
        workspace_owner_npub: retried.workspaceOwnerNpub,
        workspace_service_npub: this.getEffectiveWorkspaceNpub(retried),
        ws_key_npub: retried.wsKeyNpub,
        regenerated_after_conflict: true,
      });
      return retried;
    }
  }

  private async refreshGroupKeys(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    allowFailure: boolean,
  ): Promise<WorkspaceSubscriptionRecord> {
    const runtime = this.getRuntime(record.subscriptionId);
    const helpers = await loadYokeBotHelpers();
    try {
      const keyRows = await helpers.fetchBotGroupKeys({
        wsSession: runtime.wsSession!,
        backendBaseUrl: record.backendBaseUrl,
      });
      runtime.wrappedKeyRows = keyRows;
      runtime.groupKeys = helpers.loadBotGroupKeys({
        wsSession: runtime.wsSession!,
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        keyRows,
      });
      record.groupKeyStatus = 'active';
      record.lastGroupRefreshAt = new Date().toISOString();
      record.wrappedGroupKeysJson = JSON.stringify(keyRows);
      record.lastGroupRefreshResult = buildSuccessDiagnostic('Wrapped group keys refreshed.', {
        key_count: keyRows.length,
        bot_npub: botIdentity.botNpub,
      });
      record.lastErrorCode = null;
      record.lastErrorAt = null;
      this.clearRuntimeFailure(record.subscriptionId, 'group_keys_refreshed');
    } catch (error) {
      record.groupKeyStatus = record.wrappedGroupKeysJson ? 'refresh_required' : 'failed';
      record.lastErrorCode = 'group_key_fetch_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastGroupRefreshResult = buildFailureDiagnostic(
        'group_key_fetch_failed',
        error instanceof Error ? error.message : 'Group key refresh failed.',
        typeof (error as { detailCode?: string })?.detailCode === 'string' ? (error as { detailCode: string }).detailCode : null,
      );
      if (runtime.wrappedKeyRows.length > 0) {
        try {
          runtime.groupKeys = helpers.loadBotGroupKeys({
            wsSession: runtime.wsSession!,
            botSecret: botIdentity.botSecret,
            botNpub: botIdentity.botNpub,
            keyRows: runtime.wrappedKeyRows,
          });
        } catch {
          runtime.groupKeys = null;
        }
      }
      if (!allowFailure) {
        record.healthStatus = 'degraded';
      }
      this.markRuntimeFailure(
        record.subscriptionId,
        getErrorDetailCode(error) ?? 'group_key_fetch_failed',
        'group_key_refresh_required',
      );
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private async ensureConnected(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    isStartupReload: boolean,
  ): Promise<void> {
    if (isRevokedWorkspaceSubscription(record)) {
      this.stopRuntime(record.subscriptionId, true);
      this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
        lastErrorCode: record.lastErrorCode ?? 'workspace_access_revoked',
      }));
      return;
    }
    if (isFlightDeckPgSubscription(record)) {
      await this.ensureFlightDeckPgConnected(record, botIdentity, isStartupReload);
      return;
    }
    const runtime = this.getRuntime(record.subscriptionId);
    runtime.botIdentity = botIdentity;
    runtime.removed = false;
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    if (runtime.abortController) {
      runtime.abortController.abort();
    }
    const controller = new AbortController();
    runtime.abortController = controller;
    record.sseStatus = 'connecting';
    this.saveRecord(this.recomputeHealth(record));
    void this.runSseLoop(record.subscriptionId, controller.signal, isStartupReload);
  }

  private async ensureFlightDeckPgConnected(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    isStartupReload: boolean,
  ): Promise<void> {
    if (record.wsKeyStatus === 'failed') {
      this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disconnected',
      }));
      return;
    }
    const runtime = this.getRuntime(record.subscriptionId);
    runtime.botIdentity = botIdentity;
    runtime.removed = false;
    this.flightDeckPgEventWatchdog.stop(record.subscriptionId);
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    if (runtime.abortController) {
      runtime.abortController.abort();
    }
    const controller = new AbortController();
    runtime.abortController = controller;
    record.sseStatus = 'connecting';
    this.saveRecord(this.recomputeHealth(record));
    void this.runFlightDeckPgEventLoop(record.subscriptionId, controller.signal, isStartupReload);
  }

  private async recoverStaleFlightDeckPgEventRuntime(
    subscriptionId: string,
    runtimeToken: object,
  ): Promise<void> {
    const runtime = this.runtimes.get(subscriptionId);
    const record = this.store.getBySubscriptionId(subscriptionId);
    if (
      !runtime
      || runtime.removed
      || runtime.abortController?.signal !== runtimeToken
      || !record
      || !isFlightDeckPgSubscription(record)
      || record.sseStatus === 'disabled'
      || isRevokedWorkspaceSubscription(record)
    ) {
      return;
    }

    const now = new Date().toISOString();
    const staleRecord = this.saveRecord(this.recomputeHealth({
      ...record,
      sseStatus: 'backoff',
      lastEventPollErrorAt: now,
      lastEventPollErrorCode: FLIGHT_DECK_PG_EVENT_POLL_STALE_CODE,
      lastErrorCode: FLIGHT_DECK_PG_EVENT_POLL_STALE_CODE,
      lastErrorAt: now,
    }));
    runtime.abortController.abort();
    await this.ensureFlightDeckPgConnected(staleRecord, runtime.botIdentity, false);
  }

  private enabledFlightDeckAudience(record: WorkspaceSubscriptionRecord): AgentDefinitionRecord[] {
    if (!record.managedByNpub || record.agentProfileId) return [];
    return this.agentStore.listForManagerNpub(record.managedByNpub)
      .filter((profile) => profile.enabled && !profile.archived && profile.directChat?.enabled)
      .filter((profile) => profile.capabilities.includes('chat_intercept'))
      .sort((left, right) => left.botNpub.localeCompare(right.botNpub));
  }

  private async reconcileFlightDeckAudience(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!record.workspaceId) return [];
    // Retained profile-bound subscriptions use Tower's backward-compatible single-actor contract.
    if (record.agentProfileId) return [];
    const profiles = this.enabledFlightDeckAudience(record);
    const requested = [...new Set(profiles.map((profile) => profile.botNpub))];
    if (requested.length > 32) {
      throw Object.assign(new Error('A Flight Deck event subscription supports at most 32 enabled Agent Direct profiles.'), {
        detailCode: 'flightdeck_pg_event_subscription_agents_too_many',
      });
    }
    const result = await this.reconcileFlightDeckPgEventSubscriptionAgentsImpl({
      backendBaseUrl: record.backendBaseUrl,
      workspaceId: record.workspaceId,
      appNpub: record.sourceAppNpub,
      botIdentity,
      agentNpubs: requested,
      signal,
    });
    const accepted = [...new Set(result.audience_npubs ?? result.agent_npubs)].sort();
    if (accepted.some((npub) => !requested.includes(npub))) {
      throw Object.assign(new Error('Tower reconciled an unrequested Agent Direct event audience member.'), {
        detailCode: 'flightdeck_pg_event_subscription_agents_mismatch',
      });
    }
    const reportedRejections = new Map(
      (result.rejected_audience ?? []).map((rejection) => [rejection.npub, rejection.code]),
    );
    const rejected = requested
      .filter((npub) => !accepted.includes(npub))
      .map((npub) => ({ npub, code: reportedRejections.get(npub) ?? 'not_accepted' }));
    if (requested.length > 0 && accepted.length === 0) {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_event_subscription_audience_empty',
        'Tower rejected every requested Agent Direct event audience member; the subscription will retry.',
        'flightdeck_pg_event_subscription_audience_empty',
        {
          requested_npubs: requested,
          accepted_npubs: accepted,
          rejected_audience: rejected,
          retryable: true,
        },
      );
      this.saveRecord(this.recomputeHealth(record));
      throw Object.assign(new Error('Tower rejected every requested Agent Direct event audience member.'), {
        detailCode: 'flightdeck_pg_event_subscription_audience_empty',
        rejectedAudience: rejected,
        retryable: true,
      });
    }
    if (rejected.length > 0 || accepted.length !== requested.length) {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_event_subscription_audience_partial',
        'Tower rejected part of the configured Agent Direct event audience; accepted members remain active.',
        'flightdeck_pg_event_subscription_audience_partial',
        {
          requested_npubs: requested,
          accepted_npubs: accepted,
          rejected_audience: rejected,
        },
      );
      this.saveRecord(this.recomputeHealth(record));
    }
    const backendConnection = record.backendConnectionId ? this.backendStore.getById(record.backendConnectionId) : null;
    for (const profile of profiles.filter((candidate) => accepted.includes(candidate.botNpub))) {
      this.profilePolicyStore.ensureProfileWorkspaceForSubscription({
        managedByNpub: record.managedByNpub!,
        agentProfileId: profile.agentId,
        agentLabel: profile.label,
        agentNpub: profile.botNpub,
        subscription: record,
        backendConnection,
        relayOnboardingStatus: record.healthStatus === 'healthy' ? 'ready' : 'verified',
      });
    }
    return accepted;
  }

  private async runFlightDeckPgLiveEventLoop(
    subscriptionId: string,
    signal: AbortSignal,
    isStartupReload: boolean,
  ): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    let reconnectAttempts = 0;
    while (!signal.aborted && !runtime.removed) {
      let record = this.store.getBySubscriptionId(subscriptionId);
      if (!record?.workspaceId) {
        return;
      }
      const workspaceId = record.workspaceId;
      try {
        record = await this.verifyFlightDeckPgWorkspaceAccess(record, runtime.botIdentity, { signal });
        if (record.wsKeyStatus === 'failed' || signal.aborted || runtime.removed) {
          return;
        }
        const cursor = record.lastSyncCursor ?? encodeFlightDeckPgEventCursor(0);
        const audienceNpubs = await this.reconcileFlightDeckAudience(record, runtime.botIdentity, signal);
        const response = await this.connectFlightDeckPgEventStreamImpl({
          backendBaseUrl: record.backendBaseUrl,
          workspaceId,
          appNpub: record.sourceAppNpub,
          botIdentity: runtime.botIdentity,
          cursor,
          limit: 100,
          signal,
          audienceNpubs,
        });
        record.sseStatus = 'connected';
        if (isStartupReload && !record.lastSuccessfulStartupReloadAt) {
          record.lastSuccessfulStartupReloadAt = new Date().toISOString();
        }
        record.lastErrorCode = null;
        record.lastErrorAt = null;
        record = this.saveRecord(this.recomputeHealth(record));
        this.clearRuntimeFailure(record.subscriptionId, 'flightdeck_pg_event_stream_connected');
        reconnectAttempts = 0;

        for await (const sseEvent of parseSseEvents(response.body!)) {
          if (signal.aborted || runtime.removed) {
            return;
          }
          record = this.store.getBySubscriptionId(subscriptionId) ?? record;
          if (sseEvent.event === 'connected') {
            record.lastSseEventId = sseEvent.id ?? record.lastSseEventId;
            record.lastSseEvent = {
              eventId: sseEvent.id,
              eventType: 'flightdeck_pg.connected',
              at: new Date().toISOString(),
              payload: safeJsonParse(sseEvent.data) ?? { data: sseEvent.data },
            };
            record = this.saveRecord(this.recomputeHealth(record));
            continue;
          }
          if (sseEvent.event === 'flightdeck_pg.error') {
            record.lastSseEventId = sseEvent.id ?? record.lastSseEventId;
            record.lastSseEvent = {
              eventId: sseEvent.id,
              eventType: 'flightdeck_pg.error',
              at: new Date().toISOString(),
              payload: safeJsonParse(sseEvent.data) ?? { data: sseEvent.data },
            };
            record = this.saveRecord(this.recomputeHealth(record));
            continue;
          }
          if (sseEvent.event === 'flightdeck_pg.audience_changed') {
            record.lastSseEventId = sseEvent.id ?? record.lastSseEventId;
            const nextEvent: AgentChatSseEventDiagnostic = {
              eventId: sseEvent.id,
              eventType: 'flightdeck_pg.audience_changed',
              at: new Date().toISOString(),
              payload: safeJsonParse(sseEvent.data) ?? { data: sseEvent.data },
            };
            record.lastSseEvent = nextEvent;
            record.recentSseEvents = trimRecentEntries(
              [...(Array.isArray(record.recentSseEvents) ? record.recentSseEvents : []), nextEvent],
              MAX_RECENT_SSE_EVENTS,
            );
            record = this.saveRecord(this.recomputeHealth(record));
            continue;
          }
          if (sseEvent.event !== 'flightdeck_pg.event') {
            continue;
          }
          const parsed = safeJsonParse(sseEvent.data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
          }
          record = await this.handleFlightDeckPgEvent(record, parsed as FlightDeckPgEvent);
        }
        throw Object.assign(new Error('Flight Deck PG event stream closed.'), {
          detailCode: 'flightdeck_pg_event_stream_closed',
        });
      } catch (error) {
        if (signal.aborted || runtime.removed) {
          return;
        }
        record = this.store.getBySubscriptionId(subscriptionId);
        if (!record) {
          return;
        }
        const detailCode = getErrorDetailCode(error) ?? 'flightdeck_pg_event_stream_failed';
        record.sseStatus = 'backoff';
        record.lastErrorCode = detailCode;
        record.lastErrorAt = new Date().toISOString();
        record.lastSseEvent = {
          eventId: record.lastSseEventId,
          eventType: 'flightdeck_pg.error',
          at: record.lastErrorAt,
          payload: {
            message: error instanceof Error ? error.message : String(error),
            detailCode,
          },
        };
        this.saveRecord(this.recomputeHealth(record));
        this.markRuntimeFailure(subscriptionId, detailCode, 'flightdeck_pg_event_stream_failed');
        const delay = Math.min(1_000 * Math.pow(2, reconnectAttempts), 60_000);
        reconnectAttempts += 1;
        await sleepWithAbort(delay, signal);
      }
    }
  }

  private async runFlightDeckPgEventLoop(
    subscriptionId: string,
    signal: AbortSignal,
    isStartupReload: boolean,
  ): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    while (
      !signal.aborted
      && !runtime.removed
      && runtime.abortController?.signal === signal
    ) {
      let record = this.store.getBySubscriptionId(subscriptionId);
      if (!record?.workspaceId) {
        return;
      }
      const workspaceId = record.workspaceId;
      try {
        record = await this.verifyFlightDeckPgWorkspaceAccess(record, runtime.botIdentity, {
          signal,
          throwOnRetryable: true,
        });
        if (
          record.wsKeyStatus === 'failed'
          || signal.aborted
          || runtime.removed
          || runtime.abortController?.signal !== signal
        ) {
          return;
        }
        runtime.reconnectAttempts = 0;
        record.sseStatus = 'connected';
        if (isStartupReload) {
          record.lastSuccessfulStartupReloadAt = new Date().toISOString();
          isStartupReload = false;
        }
        record = this.saveRecord(this.recomputeHealth(record));
        this.flightDeckPgEventWatchdog.start(subscriptionId, signal);
        this.clearRuntimeFailure(record.subscriptionId, 'flightdeck_pg_events_connected');

        while (!signal.aborted && !runtime.removed && runtime.abortController?.signal === signal) {
          record = this.store.getBySubscriptionId(subscriptionId) ?? record;
          const cursor = record.lastSyncCursor ?? encodeFlightDeckPgEventCursor(0);
          const audienceNpubs = await this.reconcileFlightDeckAudience(record, runtime.botIdentity, signal);
          const pollStartedAt = Date.now();
          const pollController = new AbortController();
          const abortPoll = () => pollController.abort();
          signal.addEventListener('abort', abortPoll, { once: true });
          const result = await withTimeout(
            this.fetchFlightDeckPgEventsImpl({
              backendBaseUrl: record.backendBaseUrl,
              workspaceId,
              appNpub: record.sourceAppNpub,
              botIdentity: runtime.botIdentity,
              cursor,
              limit: 100,
              signal: pollController.signal,
              audienceNpubs,
            }),
            this.flightDeckPgEventPollTimeoutMs,
            'flightdeck_pg_event_poll_timeout',
            () => pollController.abort(),
          ).finally(() => {
            signal.removeEventListener('abort', abortPoll);
          });
          if (signal.aborted || runtime.removed || runtime.abortController?.signal !== signal) {
            return;
          }
          this.flightDeckPgEventWatchdog.recordSuccessfulPoll(subscriptionId, signal);
          const events = result.events;
          for (const event of events) {
            if (signal.aborted || runtime.removed) {
              return;
            }
            record = await this.handleFlightDeckPgEvent(record, event);
          }
          const highWaterCursor = decodeFlightDeckPgEventCursor(result.next_cursor);
          const savedCursor = decodeFlightDeckPgEventCursor(record.lastSyncCursor);
          if (result.next_cursor && (!savedCursor || !highWaterCursor || highWaterCursor.rowVersion > savedCursor.rowVersion)) {
            record.lastSyncCursor = result.next_cursor;
          }
          record.lastEventPollOkAt = new Date().toISOString();
          record.lastEventPollErrorAt = null;
          record.lastEventPollErrorCode = null;
          record.lastEventPollEventCount = events.length;
          record.lastEventPollLagMs = Date.now() - pollStartedAt;
          if (record.lastErrorCode === FLIGHT_DECK_PG_EVENT_POLL_STALE_CODE) {
            record.lastErrorCode = null;
            record.lastErrorAt = null;
          }
          record = this.saveRecord(this.recomputeHealth(record));
          await sleepWithAbort(this.flightDeckPgEventPollIntervalMs, signal);
        }
        return;
      } catch (error) {
        if (signal.aborted || runtime.removed || runtime.abortController?.signal !== signal) {
          return;
        }
        record = this.store.getBySubscriptionId(subscriptionId);
        if (!record) {
          return;
        }
        const detailCode = getErrorDetailCode(error) ?? 'flightdeck_pg_events_failed';
        if (detailCode !== FLIGHT_DECK_PG_ACCESS_RETRY_CODE) {
          const failedAt = new Date().toISOString();
          record.sseStatus = 'backoff';
          record.lastErrorCode = detailCode;
          record.lastErrorAt = failedAt;
          record.lastEventPollErrorAt = failedAt;
          record.lastEventPollErrorCode = detailCode;
          this.saveRecord(this.recomputeHealth(record));
        }

        const delay = flightDeckPgReconnectDelayMs(
          runtime.reconnectAttempts,
          this.flightDeckPgEventReconnectBaseMs,
          this.flightDeckPgEventReconnectMaxMs,
        );
        runtime.reconnectAttempts += 1;
        await sleepWithAbort(delay, signal);
      }
    }
  }

  private async handleFlightDeckPgEvent(
    record: WorkspaceSubscriptionRecord,
    event: FlightDeckPgEvent,
  ): Promise<WorkspaceSubscriptionRecord> {
    const latest = this.store.getBySubscriptionId(record.subscriptionId) ?? record;
    const eventCursor = decodeFlightDeckPgEventCursor(event.cursor);
    const currentCursor = decodeFlightDeckPgEventCursor(latest.lastSyncCursor);
    if (eventCursor && currentCursor && eventCursor.rowVersion <= currentCursor.rowVersion) {
      return latest;
    }

    const eventId = typeof event.event_id === 'string' ? event.event_id : typeof event.id === 'string' ? event.id : null;
    const keyParts = [
      latest.subscriptionId,
      event.cursor,
      eventId,
      event.entity_type,
      event.entity_id,
      event.row_version,
    ].filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
    const inFlightKey = keyParts.length > 1 ? keyParts.join(':') : null;
    const inFlight = inFlightKey ? this.flightDeckPgInFlightEvents.get(inFlightKey) : null;
    if (inFlight) {
      return await inFlight;
    }

    const preceding = this.flightDeckPgEventQueues.get(latest.subscriptionId);
    const processing = (async () => {
      if (preceding) await preceding;
      const queuedLatest = this.store.getBySubscriptionId(latest.subscriptionId) ?? latest;
      const queuedCursor = decodeFlightDeckPgEventCursor(queuedLatest.lastSyncCursor);
      if (eventCursor && queuedCursor && eventCursor.rowVersion <= queuedCursor.rowVersion) {
        return queuedLatest;
      }
      return await this.processFlightDeckPgEvent(queuedLatest, event);
    })();
    if (inFlightKey) this.flightDeckPgInFlightEvents.set(inFlightKey, processing);
    this.flightDeckPgEventQueues.set(latest.subscriptionId, processing);
    try {
      return await processing;
    } finally {
      if (inFlightKey && this.flightDeckPgInFlightEvents.get(inFlightKey) === processing) {
        this.flightDeckPgInFlightEvents.delete(inFlightKey);
      }
      if (this.flightDeckPgEventQueues.get(latest.subscriptionId) === processing) {
        this.flightDeckPgEventQueues.delete(latest.subscriptionId);
      }
    }
  }

  private async processFlightDeckPgEvent(
    record: WorkspaceSubscriptionRecord,
    event: FlightDeckPgEvent,
  ): Promise<WorkspaceSubscriptionRecord> {
    const eventId = typeof event.event_id === 'string' ? event.event_id : typeof event.id === 'string' ? event.id : null;
    const eventType = typeof event.event_type === 'string' ? event.event_type : 'flightdeck_pg.event';
    record.lastSseEventId = eventId ?? record.lastSseEventId;
    const payload = event as Record<string, unknown>;
    const nextEvent: AgentChatSseEventDiagnostic = {
      eventId,
      eventType,
      at: new Date().toISOString(),
      payload,
    };
    record.lastSseEvent = nextEvent;
    record.recentSseEvents = trimRecentEntries(
      [...(Array.isArray(record.recentSseEvents) ? record.recentSseEvents : []), nextEvent],
      MAX_RECENT_SSE_EVENTS,
    );
    record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG workspace event received.', {
      workspace_id: record.workspaceId,
      event_id: eventId,
      event_type: eventType,
      entity_type: event.entity_type ?? null,
      entity_id: event.entity_id ?? null,
      channel_id: event.channel_id ?? null,
      scope_id: event.scope_id ?? null,
      operation: event.operation ?? null,
    });
    record.lastErrorCode = null;
    record.lastErrorAt = null;
    record = this.saveRecord(this.recomputeHealth(record));

    if (event.entity_type === 'message' && event.operation !== 'deleted') {
      record = await this.handleFlightDeckPgChatEvent(record, event);
    } else if (event.entity_type === 'thread') {
      record.lastRoutingResult = buildSuccessDiagnostic(
        'Flight Deck PG thread lifecycle event acknowledged without Agent Direct dispatch.',
        {
          subscription_id: record.subscriptionId,
          event_id: eventId,
          event_type: eventType,
          thread_id: event.entity_id ?? null,
          operation: event.operation ?? null,
        },
      );
      record = this.saveRecord(this.recomputeHealth(record));
    } else if (isDocumentDirectEvent(event) && this.documentDirectRuntime) {
      const runtime = this.getRuntime(record.subscriptionId);
      const result = await this.documentDirectRuntime.handle({
        subscription: record,
        botIdentity: runtime.botIdentity,
        event,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'document',
        action: result.reason,
        agentId: 'document-direct',
        sessionId: null,
        recordId: event.event_id ?? event.id ?? event.entity_id ?? null,
        bindingId: typeof event.payload?.document_id === 'string'
          ? event.payload.document_id
          : typeof event.payload?.doc_id === 'string' ? event.payload.doc_id : event.entity_id ?? null,
        bindingType: 'document',
        details: { source: 'flightdeck_pg', event_type: event.event_type, entity_type: event.entity_type },
      });
    } else if (isTaskDirectEvent(event) && this.taskDirectRuntime) {
      const runtime = this.getRuntime(record.subscriptionId);
      const result = await this.taskDirectRuntime.handle({
        subscription: record,
        botIdentity: runtime.botIdentity,
        instanceNpub: this.getInstanceIdentity()?.npub ?? null,
        event,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: event.entity_type === 'task_comment' ? 'comment' : 'task',
        action: result.reason,
        agentId: 'task-direct',
        sessionId: null,
        recordId: event.event_id ?? event.id ?? event.entity_id ?? null,
        bindingId: typeof event.payload?.task_id === 'string' ? event.payload.task_id : event.entity_id ?? null,
        bindingType: 'task',
        details: { source: 'flightdeck_pg', entity_type: event.entity_type, targeting: result.targeting },
      });
    } else if (event.entity_type === 'invocation' && event.operation !== 'deleted') {
      record = await this.handleFlightDeckPgInvocationEvent(record, event);
    }
    const latest = this.store.getBySubscriptionId(record.subscriptionId) ?? record;
    const acknowledgedCursor = decodeFlightDeckPgEventCursor(event.cursor);
    const durableCursor = decodeFlightDeckPgEventCursor(latest.lastSyncCursor);
    if (event.cursor && (!durableCursor || !acknowledgedCursor || acknowledgedCursor.rowVersion > durableCursor.rowVersion)) {
      latest.lastSyncCursor = event.cursor;
    }
    return this.saveRecord(this.recomputeHealth(latest));
  }

  private async handleFlightDeckPgInvocationEvent(
    record: WorkspaceSubscriptionRecord,
    event: FlightDeckPgEvent,
  ): Promise<WorkspaceSubscriptionRecord> {
    const runtime = this.getRuntime(record.subscriptionId);
    const workspaceId = record.workspaceId;
    const invocation = normaliseFlightDeckPgInvocationPayload(event);
    const recordId = invocation.invocationId;
    const targetType = invocation.targetType;
    const targetId = invocation.targetId;
    const scopeId = invocation.scopeId;
    const channelId = invocation.channelId;
    const bindingType = targetType === 'document' ? 'document' : targetType === 'task' ? 'task' : null;
    if (!workspaceId || !recordId || !targetType || !targetId || !scopeId || !channelId) {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_invocation_event_missing_identity',
        'Flight Deck PG invocation event did not include workspace, invocation, target, scope, or channel identity.',
        'flightdeck_pg_invocation_event_missing_identity',
        {
          workspace_id: workspaceId,
          invocation_id: recordId,
          target_type: targetType,
          target_id: targetId,
          scope_id: scopeId,
          channel_id: channelId,
        },
      );
      return this.saveRecord(this.recomputeHealth(record));
    }

    const dispatchTriggerKind: CreateDispatchRouteInput['triggerKind'] = targetType === 'document' ? 'document' : 'task';
    const dispatchHistoryKind: AgentChatDispatchHistoryEntry['kind'] = targetType === 'document' ? 'document' : 'task';

    if (!flightDeckPgInvocationTargetsBot(invocation.recipients, record.botNpub)) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: dispatchHistoryKind,
        action: 'invocation_skip_not_targeted',
        agentId: 'dispatch-pipeline',
        sessionId: null,
        recordId,
        bindingId: targetId,
        bindingType,
        sourceLabel: invocation.targetTitle,
        details: {
          source: 'flightdeck_pg',
          target_type: targetType,
          target_id: targetId,
          recipient_count: invocation.recipients.length,
        },
      });
    }

    if (targetType !== 'document' && targetType !== 'task') {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_invocation_target_unsupported',
        'Flight Deck PG invocation target type is not supported by Autopilot dispatch yet.',
        'flightdeck_pg_invocation_target_unsupported',
        {
          invocation_id: recordId,
          target_type: targetType,
          target_id: targetId,
        },
      );
      return this.saveRecord(this.recomputeHealth(record));
    }

    if (!this.dispatchPipelineRuntime) {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_invocation_pipeline_unavailable',
        'No dispatch pipeline runtime is configured for Flight Deck PG invocation events.',
        'flightdeck_pg_invocation_pipeline_unavailable',
        { subscription_id: record.subscriptionId, event_id: event.event_id ?? event.id ?? null },
      );
      return this.saveRecord(this.recomputeHealth(record));
    }

    const profileEventType: AgentWorkspaceEventType = targetType === 'document' ? 'document_invocation' : 'task_invocation';
    const profileDecision = this.resolveProfileRuntimeDecision({
      subscription: record,
      eventType: profileEventType,
      scopeId,
      channelId,
      builtInDefaultPipelineId: targetType === 'document' ? 'fd-document-invocation' : 'fd-task-invocation',
    });
    if (!profilePolicyAllowsDispatch(profileDecision)) {
      return this.appendProfilePolicySuppression({
        record,
        decision: profileDecision!,
        kind: dispatchHistoryKind,
        recordId,
        bindingId: targetId,
        bindingType,
        sourceLabel: invocation.targetTitle,
        details: {
          channel_id: channelId,
          scope_id: scopeId,
          target_type: targetType,
          target_id: targetId,
          source: 'flightdeck_pg',
        },
      });
    }

    record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG invocation dispatch pipeline start requested.', {
      subscription_id: record.subscriptionId,
      event_id: event.event_id ?? event.id ?? null,
      invocation_id: recordId,
      target_type: targetType,
      target_id: targetId,
      channel_id: channelId,
      scope_id: scopeId,
    });
    record = this.saveRecord(this.recomputeHealth(record));

    try {
      const pipelineResult = await withTimeout(
        this.dispatchPipelineRuntime.dispatch({
          subscription: record,
          triggerKind: dispatchTriggerKind,
          capability: 'task_dispatch',
          recordId,
          record: {
            id: recordId,
            record_id: recordId,
            record_state: event.operation === 'deleted' ? 'deleted' : 'active',
            version: event.entity_row_version ?? event.row_version ?? null,
            row_version: event.entity_row_version ?? event.row_version ?? null,
            payload: invocation.payload,
            flightdeck_pg_event: event,
          },
          payload: invocation.payload,
          recordFamily: 'invocation',
          recordState: event.operation === 'deleted' ? 'deleted' : 'active',
          recordVersion: event.entity_row_version ?? event.row_version ?? null,
          updaterNpub: invocation.actorNpub,
          bindingType,
          bindingId: targetId,
          scopeId,
          channelId,
          threadId: null,
          changedFields: ['invocation'],
          groupNpubs: [],
          botIdentity: runtime.botIdentity,
          profileRuntime: this.buildProfileRuntimeContext(profileDecision),
          sourceLabel: invocation.targetTitle,
        }),
        CHAT_ADVISORY_PIPELINE_TIMEOUT_MS,
        'flightdeck_pg_invocation_pipeline_dispatch_timeout',
      );
      if (pipelineResult.handled) {
        record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG invocation dispatch pipeline route evaluated.', {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          invocation_id: recordId,
          target_type: targetType,
          target_id: targetId,
          route_ids: pipelineResult.historyEntries.map((entry) => entry.routeId).filter(Boolean),
          pipeline_run_ids: pipelineResult.historyEntries.map((entry) => entry.pipelineRunId).filter(Boolean),
        });
        record.lastErrorCode = null;
        record.lastErrorAt = null;
        this.clearRuntimeFailure(record.subscriptionId, 'flightdeck_pg_invocation_pipeline_dispatched');
        return this.applyDispatchPipelineResult(this.saveRecord(this.recomputeHealth(record)), pipelineResult);
      }

      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_invocation_pipeline_not_handled',
        'No dispatch pipeline route handled this Flight Deck PG invocation event.',
        'flightdeck_pg_invocation_pipeline_not_handled',
        {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          invocation_id: recordId,
          target_type: targetType,
          target_id: targetId,
        },
      );
      return this.saveRecord(this.recomputeHealth(record));
    } catch (error) {
      const detailCode = getErrorDetailCode(error) ?? 'flightdeck_pg_invocation_dispatch_failed';
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_invocation_dispatch_failed',
        error instanceof Error ? error.message : 'Failed to dispatch Flight Deck PG invocation event.',
        detailCode,
        {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          invocation_id: recordId,
          target_type: targetType,
          target_id: targetId,
        },
      );
      record.lastErrorCode = 'flightdeck_pg_invocation_dispatch_failed';
      record.lastErrorAt = new Date().toISOString();
      this.markRuntimeFailure(record.subscriptionId, detailCode, 'flightdeck_pg_invocation_dispatch_failed');
      return this.saveRecord(this.recomputeHealth(record));
    }
  }

  private async handleFlightDeckPgChatEvent(
    record: WorkspaceSubscriptionRecord,
    event: FlightDeckPgEvent,
  ): Promise<WorkspaceSubscriptionRecord> {
    const runtime = this.getRuntime(record.subscriptionId);
    const workspaceId = record.workspaceId;
    const channelId = typeof event.channel_id === 'string' ? event.channel_id : null;
    const eventEntityId = typeof event.entity_id === 'string' ? event.entity_id : null;
    if (!workspaceId || !channelId || !eventEntityId) {
      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_chat_event_missing_identity',
        'Flight Deck PG chat event did not include workspace, channel, or entity id.',
        'flightdeck_pg_chat_event_missing_identity',
        {
          workspace_id: workspaceId,
          channel_id: channelId,
          entity_id: eventEntityId,
          entity_type: event.entity_type ?? null,
        },
      );
      return this.saveRecord(this.recomputeHealth(record));
    }

    try {
      const subscriptionAudience = this.enabledFlightDeckAudience(record);
      const visibilityEvidence = event.visible_to_audience_npubs ?? event.visible_to_agent_npubs;
      if (subscriptionAudience.length > 0 && !Array.isArray(visibilityEvidence)) {
        throw Object.assign(new Error('Tower multi-identity event omitted audience visibility evidence.'), {
          detailCode: 'flightdeck_pg_event_audience_missing',
        });
      }
      const evidencedAudience = Array.isArray(visibilityEvidence)
        ? [...new Set(visibilityEvidence.filter((npub): npub is string => typeof npub === 'string'))].sort()
        : [];
      const localAudience = subscriptionAudience
        .filter((profile) => evidencedAudience.includes(profile.botNpub));
      if (subscriptionAudience.length > 0 && localAudience.length === 0) {
        const suppressionReason = evidencedAudience.length === 0
          ? 'audience_visibility_empty'
          : 'audience_profile_disabled_or_missing';
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'chat',
          action: 'chat_direct_suppressed',
          agentId: 'unresolved-agent-target',
          sessionId: null,
          recordId: eventEntityId,
          bindingId: event.thread_id ?? eventEntityId,
          bindingType: 'thread',
          status: 'suppressed',
          suppressionReason,
          details: {
            visible_to_audience_npubs: evidencedAudience,
            suppression_reason: suppressionReason,
            source: 'flightdeck_pg',
          },
        });
      }
      const hydrationIdentity = localAudience.length > 0
        ? await this.resolveStoredBotIdentity(localAudience[0]!.botNpub)
        : runtime.botIdentity;
      if (!hydrationIdentity) {
        throw Object.assign(new Error('No active bot key exists for the evidenced Agent Direct profile.'), {
          detailCode: 'flightdeck_pg_audience_profile_key_missing',
        });
      }
      let hydrated;
      try {
        hydrated = await hydrateFlightDeckPgChatEvent({
          subscription: record,
          botIdentity: hydrationIdentity,
          channelId,
          event,
          includeChannel: Boolean(this.chatRuntime),
        }, { fetchChannel: this.fetchFlightDeckPgChannelImpl, fetchMessages: this.fetchFlightDeckPgChannelMessagesImpl });
      } finally {
        if (localAudience.length > 0
          && hydrationIdentity.botSecret !== runtime.botIdentity.botSecret
          && hydrationIdentity.botSecret !== this.getInstanceIdentity()?.secretKey) {
          hydrationIdentity.botSecret.fill(0);
        }
      }
      const { message, messages } = hydrated;
      if (!message) {
        record.lastRoutingResult = buildFailureDiagnostic(
          'flightdeck_pg_chat_message_missing',
          'Flight Deck PG chat event was visible, but its exact triggering message was not readable.',
          'flightdeck_pg_chat_message_missing',
          {
            channel_id: channelId,
            entity_id: eventEntityId,
            entity_type: event.entity_type ?? null,
          },
        );
        record.lastErrorCode = 'flightdeck_pg_chat_message_missing';
        record.lastErrorAt = new Date().toISOString();
        this.saveRecord(this.recomputeHealth(record));
        throw Object.assign(new Error('Flight Deck PG exact triggering message is not currently readable.'), {
          detailCode: 'flightdeck_pg_chat_message_missing',
        });
      }

      const sourceLabel = sourceLabelForFlightDeckChat({ event, message, messages });
      if (this.chatRuntime) {
        const mentionedAgentNpubs = [...new Set(normaliseDirectChatMessage(message).mentions
          .map((mention) => mention.npub?.trim() ?? '')
          .filter(Boolean))].sort();
        const mentionedProfiles = this.agentStore
          .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(record), record.botNpub)
          .filter((agent) => mentionedAgentNpubs.includes(agent.botNpub));
        const direct = await this.chatRuntime.handleDirectChat({
          subscription: record,
          botIdentity: runtime.botIdentity,
          event,
          channel: hydrated.channel,
          messages: hydrated.messages,
          audienceAgentNpubs: localAudience.map((profile) => profile.botNpub),
        });
        record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG Agent Direct Chat event evaluated.', {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          record_id: message.id,
          channel_id: channelId,
          direct_chat_handled: direct.handled,
          direct_chat_reason: direct.reason,
        });
        if (!direct.handled) {
          const suppressionReason = isFlightDeckPgMessageRevisionEvent(event)
            ? 'revision_not_eligible_for_direct_chat'
            : direct.reason;
          return this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'chat',
            action: 'chat_direct_suppressed',
            agentId: mentionedProfiles.length === 1
              ? mentionedProfiles[0]!.agentId
              : mentionedProfiles.length > 1
                ? mentionedProfiles.map((profile) => profile.agentId).sort().join(',')
                : 'unresolved-agent-target',
            sessionId: null,
            recordId: message.id,
            bindingId: message.thread_id ?? message.thread_source_message_id ?? message.id,
            bindingType: 'thread',
            status: 'suppressed',
            suppressionReason,
            sourceLabel,
            details: {
              channel_id: channelId,
              direct_chat_reason: direct.reason,
              mentioned_agent_npubs: mentionedAgentNpubs,
              matched_profiles: mentionedProfiles.map((profile) => ({
                agent_id: profile.agentId,
                agent_npub: profile.botNpub,
                enabled: profile.enabled,
              })),
              suppression_reason: suppressionReason,
              source: 'flightdeck_pg',
            },
          });
        }
        return this.saveRecord(this.recomputeHealth(record));
      }

      if (isFlightDeckPgMessageRevisionEvent(event)) {
        record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG message revision did not activate Agent Direct Chat.', {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          record_id: message.id,
          channel_id: channelId,
          suppression_reason: 'revision_not_eligible_for_direct_chat',
        });
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'chat',
          action: 'chat_direct_suppressed',
          agentId: record.agentProfileId ?? record.botNpub,
          sessionId: null,
          recordId: message.id,
          bindingId: message.thread_id ?? message.thread_source_message_id ?? message.id,
          bindingType: 'thread',
          status: 'suppressed',
          suppressionReason: 'revision_not_eligible_for_direct_chat',
          sourceLabel,
          details: { channel_id: channelId, source: 'flightdeck_pg' },
        });
      }

      if (!this.dispatchPipelineRuntime) {
        record.lastRoutingResult = buildFailureDiagnostic(
          'flightdeck_pg_chat_pipeline_unavailable',
          'No dispatch pipeline runtime is configured for this non-direct Flight Deck PG chat event.',
          'flightdeck_pg_chat_pipeline_unavailable',
          { subscription_id: record.subscriptionId, event_id: event.event_id ?? event.id ?? null },
        );
        return this.saveRecord(this.recomputeHealth(record));
      }

      const recordId = message.id;
      const threadId = message.thread_id ?? message.thread_source_message_id ?? message.id;
      const scopeId = message.scope_id ?? event.scope_id ?? null;
      const payload = normaliseFlightDeckPgChatPayload(message, event);
      const actorNpub = firstNpub(getOptionalText(payload.sender_npub));
      const signatureCheck = verifyFlightDeckPgInstructionSignature({
        signature: payload.message_signature,
        body: String(payload.body ?? ''),
        actorNpub,
        workspaceId,
        channelId,
        threadId,
      });
      if (!signatureCheck.ok) {
        return this.appendInvalidInstructionSignatureSuppression({
          record,
          recordId,
          bindingId: threadId,
          actorNpub,
          signerNpub: signatureCheck.signerNpub,
          reason: signatureCheck.reason,
          sourceLabel,
          details: {
            event_id: event.event_id ?? event.id ?? null,
            channel_id: channelId,
            scope_id: scopeId,
            thread_id: threadId,
            event_actor_id: event.actor_id ?? null,
          },
        });
      }
      if (!this.isAuthorizedDispatchActor(actorNpub)) {
        return this.appendUnauthorizedDispatchSuppression({
          record,
          kind: 'chat',
          action: 'chat_skip_unauthorized_actor',
          recordId,
          bindingId: threadId,
          bindingType: 'thread',
          actorNpub,
          source: 'flightdeck_pg',
          sourceLabel,
          details: {
            event_id: event.event_id ?? event.id ?? null,
            channel_id: channelId,
            scope_id: scopeId,
            thread_id: threadId,
            event_actor_id: event.actor_id ?? null,
          },
        });
      }
      const workroomContext = await resolveWorkroomContextForChat({
        record,
        botIdentity: runtime.botIdentity,
        channelId,
        threadId,
        actorNpub,
        fetchContext: this.fetchFlightDeckPgWorkroomContextImpl,
      });
      const profileDecision = this.resolveProfileRuntimeDecision({
        subscription: record,
        eventType: 'chat_mention',
        scopeId,
        channelId,
        builtInDefaultPipelineId: 'fd-agent-dispatch-chat',
      });
      const targetDecision = flightDeckPgChatTargetsAgent({
        message,
        botNpub: record.botNpub,
        profileDecision,
      });
      if (!targetDecision.eligible) {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'chat',
          action: 'chat_skip_not_targeted',
          agentId: record.agentProfileId ?? record.botNpub,
          sessionId: null,
          recordId,
          bindingId: threadId,
          bindingType: 'thread',
          sourceLabel,
          details: {
            workspace_id: workspaceId,
            scope_id: scopeId,
            channel_id: channelId,
            thread_id: threadId,
            mentioned_npubs: targetDecision.mentionedNpubs,
            suppression_reason: targetDecision.reason,
            source: 'flightdeck_pg',
          },
        });
      }
      if (!profilePolicyAllowsDispatch(profileDecision)) {
        return this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'chat',
          recordId,
          bindingId: threadId,
          bindingType: 'thread',
          sourceLabel,
          details: {
            channel_id: channelId,
            scope_id: scopeId,
            thread_id: threadId,
            source: 'flightdeck_pg',
          },
        });
      }

      record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG chat dispatch pipeline start requested.', {
        subscription_id: record.subscriptionId,
        event_id: event.event_id ?? event.id ?? null,
        record_id: recordId,
        channel_id: channelId,
        scope_id: scopeId,
        thread_id: threadId,
      });
      record = this.saveRecord(this.recomputeHealth(record));
      const pipelineResult = await withTimeout(
        this.dispatchPipelineRuntime.dispatch({
          subscription: record,
          triggerKind: 'chat',
          capability: 'chat_intercept',
          recordId,
          record: {
            id: recordId,
            record_id: recordId,
            record_state: event.operation === 'deleted' ? 'deleted' : 'active',
            version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
            row_version: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
            payload,
            flightdeck_pg_event: event,
          },
          payload,
          recordFamily: 'chat',
          recordState: event.operation === 'deleted' ? 'deleted' : 'active',
          recordVersion: message.row_version ?? event.entity_row_version ?? event.row_version ?? null,
          updaterNpub: actorNpub,
          bindingType: 'thread',
          bindingId: threadId,
          scopeId,
          channelId,
          threadId,
          changedFields: [],
          groupNpubs: [],
          botIdentity: runtime.botIdentity,
          workroomContext,
          profileRuntime: this.buildProfileRuntimeContext(profileDecision),
          sourceLabel,
        }),
        CHAT_ADVISORY_PIPELINE_TIMEOUT_MS,
        'flightdeck_pg_chat_pipeline_dispatch_timeout',
      );
      if (pipelineResult.handled) {
        record.lastRoutingResult = buildSuccessDiagnostic('Flight Deck PG chat dispatch pipeline route evaluated.', {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          record_id: recordId,
          route_ids: pipelineResult.historyEntries.map((entry) => entry.routeId).filter(Boolean),
          pipeline_run_ids: pipelineResult.historyEntries.map((entry) => entry.pipelineRunId).filter(Boolean),
        });
        record.lastErrorCode = null;
        record.lastErrorAt = null;
        this.clearRuntimeFailure(record.subscriptionId, 'flightdeck_pg_chat_pipeline_dispatched');
        return this.applyDispatchPipelineResult(this.saveRecord(this.recomputeHealth(record)), pipelineResult);
      }

      record.lastRoutingResult = buildFailureDiagnostic(
        'flightdeck_pg_chat_pipeline_not_handled',
        'No chat dispatch pipeline route handled this Flight Deck PG event.',
        'flightdeck_pg_chat_pipeline_not_handled',
        {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          record_id: recordId,
          channel_id: channelId,
          thread_id: threadId,
        },
      );
      return this.saveRecord(this.recomputeHealth(record));
    } catch (error) {
      const detailCode = getErrorDetailCode(error) ?? 'flightdeck_pg_chat_dispatch_failed';
      record.lastRoutingResult = buildFailureDiagnostic(
        detailCode,
        error instanceof Error ? error.message : String(error),
        detailCode,
        {
          subscription_id: record.subscriptionId,
          event_id: event.event_id ?? event.id ?? null,
          channel_id: channelId,
          entity_id: eventEntityId,
        },
      );
      record.lastErrorCode = detailCode;
      record.lastErrorAt = new Date().toISOString();
      this.markRuntimeFailure(record.subscriptionId, detailCode, 'flightdeck_pg_chat_dispatch_failed');
      this.saveRecord(this.recomputeHealth(record));
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { detailCode });
    }
  }

  private async reconnectForReplay(subscriptionId: string, reason: string): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    const latest = this.store.getBySubscriptionId(subscriptionId);
    if (!latest || runtime.removed) {
      return;
    }
    latest.sseStatus = 'backoff';
    latest.lastErrorCode = reason;
    latest.lastErrorAt = new Date().toISOString();
    this.saveRecord(this.recomputeHealth(latest));
    await this.ensureConnected(latest, runtime.botIdentity, false);
  }

  private async fetchRecordHistoryWithRetry(
    record: WorkspaceSubscriptionRecord,
    recordId: string,
    wsSession: YokeWorkspaceSession,
  ): Promise<{ versions: Record<string, unknown>[]; attempts: number }> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.chatRecordPullMaxAttempts; attempt += 1) {
      const controller = new AbortController();
      try {
        const versions = await withTimeout(
          this.fetchRecordHistoryImpl(
            record.backendBaseUrl,
            this.getEffectiveWorkspaceNpub(record),
            recordId,
            wsSession,
            { signal: controller.signal },
          ),
          this.chatRecordPullTimeoutMs,
          'chat_record_pull_timeout',
          () => controller.abort(),
        );
        return { versions, attempts: attempt };
      } catch (error) {
        lastError = error;
        controller.abort();
        if (attempt >= this.chatRecordPullMaxAttempts) {
          break;
        }
        await sleep(this.chatRecordPullRetryDelayMs * attempt);
      }
    }

    const retryError = lastError instanceof Error
      ? lastError
      : new Error('Record pull failed.');
    throw Object.assign(retryError, {
      pullAttempts: this.chatRecordPullMaxAttempts,
      detailCode: getErrorDetailCode(retryError) ?? 'record_pull_failed',
    });
  }

  private async runSseLoop(subscriptionId: string, signal: AbortSignal, isStartupReload: boolean): Promise<void> {
    const runtime = this.getRuntime(subscriptionId);
    let record = this.store.getBySubscriptionId(subscriptionId);
    if (!record) {
      return;
    }
    if (isRevokedWorkspaceSubscription(record)) {
      this.stopRuntime(subscriptionId, true);
      this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
        lastErrorCode: record.lastErrorCode ?? 'workspace_access_revoked',
      }));
      return;
    }
    try {
      const streamUrl = await buildStreamUrl(
        record.backendBaseUrl,
        this.getEffectiveWorkspaceNpub(record),
        runtime.wsSession!,
        record.lastSseEventId,
      );
      const response = await fetch(streamUrl, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal,
      });
      if (!response.ok || !response.body) {
        const error = await parseTowerError(response, 'stream_connect');
        throw Object.assign(new Error(error.message), error);
      }

      runtime.reconnectAttempts = 0;
      record.sseStatus = 'connected';
      if (isStartupReload) {
        record.lastSuccessfulStartupReloadAt = new Date().toISOString();
      }
      record = this.saveRecord(this.recomputeHealth(record));
      this.clearRuntimeFailure(record.subscriptionId, 'sse_connected');

      for await (const event of parseSseEvents(response.body)) {
        if (signal.aborted) {
          return;
        }
        record = await this.handleSseEvent(record, event.id, event.event, event.data);
      }

      throw Object.assign(new Error('SSE stream closed.'), { detailCode: 'sse_stream_lost' });
    } catch (error) {
      if (signal.aborted || runtime.removed) {
        return;
      }
      record = this.store.getBySubscriptionId(subscriptionId);
      if (!record) {
        return;
      }
      record.sseStatus = 'backoff';
      record.lastErrorCode = 'sse_connect_failed';
      record.lastErrorAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : 'SSE connection failed.';
      const detailCode = typeof (error as { detailCode?: string })?.detailCode === 'string'
        ? (error as { detailCode: string }).detailCode
        : null;
      record.lastSseEvent = {
        eventId: record.lastSseEventId,
        eventType: 'error',
        at: new Date().toISOString(),
        payload: { message, detailCode },
      };
      this.saveRecord(this.recomputeHealth(record));
      this.markRuntimeFailure(subscriptionId, detailCode, 'sse_connect_failed');

      const delay = Math.min(1_000 * Math.pow(2, runtime.reconnectAttempts), 60_000);
      runtime.reconnectAttempts += 1;
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = null;
        const latest = this.store.getBySubscriptionId(subscriptionId);
        if (!latest || runtime.removed) {
          return;
        }
        void this.ensureConnected(latest, runtime.botIdentity, false);
      }, delay);
    }
  }

  private async handleSseEvent(
    record: WorkspaceSubscriptionRecord,
    eventId: string | null,
    eventType: string,
    eventData: string,
  ): Promise<WorkspaceSubscriptionRecord> {
    let payload: Record<string, unknown> | null = null;
    if (isRevokedWorkspaceSubscription(record)) {
      return this.saveRecord(this.recomputeHealth({
        ...record,
        sseStatus: 'disabled',
        lastRoutingResult: buildFailureDiagnostic(
          'workspace_event_suppressed_revoked',
          'SSE event ignored because Tower-confirmed workspace access is revoked.',
          'workspace_access_revoked',
          { event_id: eventId, event_type: eventType },
        ),
      }));
    }
    try {
      payload = eventData ? JSON.parse(eventData) as Record<string, unknown> : null;
    } catch {
      payload = { raw: eventData };
    }
    const previousLastSseEventId = record.lastSseEventId;
    record.lastSseEventId = eventId ?? record.lastSseEventId;
    const nextEvent: AgentChatSseEventDiagnostic = {
      eventId,
      eventType,
      at: new Date().toISOString(),
      payload,
    };
    record.lastSseEvent = nextEvent;
    record.recentSseEvents = trimRecentEntries(
      [...(Array.isArray(record.recentSseEvents) ? record.recentSseEvents : []), nextEvent],
      MAX_RECENT_SSE_EVENTS,
    );
    record = this.saveRecord(record);

    if (eventType === 'connected') {
      record.sseStatus = 'connected';
      const saved = this.saveRecord(this.recomputeHealth(record));
      this.clearRuntimeFailure(saved.subscriptionId, 'sse_connected_event');
      return saved;
    }

    if (eventType === 'record-changed' && payload?.family_hash === buildChatMessageFamilyHash(record.sourceAppNpub)) {
      return await this.handleChatMessageRecordChanged(record, payload, {
        eventId,
        previousLastSseEventId,
      });
    }
    if (eventType === 'record-changed' && payload?.family_hash === buildRecordFamilyHash(record.sourceAppNpub, 'task')) {
      return await this.handleTaskRecordChanged(record, payload);
    }
    if (eventType === 'record-changed' && payload?.family_hash === buildRecordFamilyHash(record.sourceAppNpub, 'approval')) {
      return await this.handleApprovalRecordChanged(record, payload);
    }
    if (eventType === 'record-changed' && payload?.family_hash === buildRecordFamilyHash(record.sourceAppNpub, 'comment')) {
      return await this.handleCommentRecordChanged(record, payload);
    }

    if (eventType === 'record-changed') {
      record.lastRoutingResult = buildFailureDiagnostic(
        'record_family_unhandled',
        'Record-changed advisory did not match a configured dispatch family.',
        'record_family_unhandled',
        {
          subscription_id: record.subscriptionId,
          event_id: eventId,
          event_family_hash: payload?.family_hash ?? null,
          expected_chat_family_hash: buildChatMessageFamilyHash(record.sourceAppNpub),
          expected_task_family_hash: buildRecordFamilyHash(record.sourceAppNpub, 'task'),
          expected_approval_family_hash: buildRecordFamilyHash(record.sourceAppNpub, 'approval'),
          expected_comment_family_hash: buildRecordFamilyHash(record.sourceAppNpub, 'comment'),
        },
      );
      return this.saveRecord(record);
    }

    return record;
  }

  private async handleChatMessageRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
    eventCursor: { eventId: string | null; previousLastSseEventId: string | null },
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      record.lastRecordPullResult = buildFailureDiagnostic(
        'record_pull_failed',
        'Chat message advisory did not include a record_id.',
        'record_id_missing',
        { subscription_id: record.subscriptionId },
      );
      return this.saveRecord(record);
    }

    const runtime = this.getRuntime(record.subscriptionId);
    try {
      record.lastRecordPullResult = buildSuccessDiagnostic('Chat message advisory pull started.', {
        subscription_id: record.subscriptionId,
        record_id: recordId,
      });
      record = this.saveRecord(record);
      const pullResult = await this.fetchRecordHistoryWithRetry(record, recordId, runtime.wsSession!);
      const versions = pullResult.versions;
      const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
      if (!latest) {
        throw Object.assign(new Error(`Record ${recordId} not found.`), { detailCode: 'record_pull_not_found' });
      }
      record.lastRecordPullResult = buildSuccessDiagnostic('Chat message advisory pulled.', {
        record_id: recordId,
        version: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        record_state: typeof latest.record_state === 'string' ? latest.record_state : null,
        pull_attempts: pullResult.attempts,
      });
      record = this.saveRecord(record);
      const helpers = await loadYokeBotHelpers();
      if (!runtime.groupKeys && runtime.wrappedKeyRows.length > 0) {
        runtime.groupKeys = helpers.loadBotGroupKeys({
          wsSession: runtime.wsSession!,
          botSecret: runtime.botIdentity.botSecret,
          botNpub: runtime.botIdentity.botNpub,
          keyRows: runtime.wrappedKeyRows,
        });
      }
      try {
        const decryptChatMessage = () => helpers.decryptChatRecord({
          record: latest,
          wsSession: runtime.wsSession!,
          groupKeys: runtime.groupKeys,
        });
        let chatMessage: Record<string, unknown>;
        record.lastDecryptResult = buildSuccessDiagnostic('Chat message decrypt started.', {
          subscription_id: record.subscriptionId,
          record_id: recordId,
        });
        record = this.saveRecord(record);
        try {
          chatMessage = await withTimeout(
            Promise.resolve().then(decryptChatMessage),
            CHAT_ADVISORY_DECRYPT_TIMEOUT_MS,
            'chat_record_decrypt_timeout',
          );
        } catch (decryptError) {
          const detailCode = getErrorDetailCode(decryptError);
          if (detailCode !== 'group_key_missing') {
            throw decryptError;
          }
          record = await this.refreshGroupKeys(record, runtime.botIdentity, true);
          chatMessage = await withTimeout(
            Promise.resolve().then(decryptChatMessage),
            CHAT_ADVISORY_DECRYPT_TIMEOUT_MS,
            'chat_record_decrypt_timeout',
          );
        }
        record.lastDecryptResult = buildSuccessDiagnostic('Chat message pulled and decrypted.', {
          record_id: recordId,
          channel_id: chatMessage.channel_id ?? null,
        });
        record = this.saveRecord(record);
        const sourceLabel = buildFlightDeckChatSourceLabel({
          threadTitle: chatMessage.thread_title,
          messageBody: chatMessage.body,
        });
        const chatActorNpub = firstNpub(getRecordUpdaterNpub(latest), getOptionalText(chatMessage.sender_npub));
        if (!this.isAuthorizedDispatchActor(chatActorNpub)) {
          return this.appendUnauthorizedDispatchSuppression({
            record,
            kind: 'chat',
            action: 'chat_skip_unauthorized_actor',
            recordId,
            bindingId: recordId,
            bindingType: 'chat',
            actorNpub: chatActorNpub,
            source: 'record',
            sourceLabel,
            details: {
              sender_npub: getOptionalText(chatMessage.sender_npub),
              updater_npub: getRecordUpdaterNpub(latest),
            },
          });
        }
        if (this.dispatchPipelineRuntime) {
          try {
            record.lastRoutingResult = buildSuccessDiagnostic('Chat dispatch routing context started.', {
              subscription_id: record.subscriptionId,
              record_id: recordId,
            });
            record = this.saveRecord(record);
            const routingContext = await withTimeout(
              this.routingEvaluator.buildDispatchContext({
                subscription: record,
                wsSession: runtime.wsSession!,
                groupKeys: runtime.groupKeys,
                chatRecordId: recordId,
                chatRecord: latest,
                chatMessage,
              }),
              CHAT_ADVISORY_ROUTING_TIMEOUT_MS,
              'chat_routing_context_timeout',
            );
            const workroomContext = await resolveWorkroomContextForChat({
              record,
              botIdentity: runtime.botIdentity,
              channelId: routingContext.channelId,
              threadId: routingContext.threadId,
              actorNpub: routingContext.updaterNpub,
              fetchContext: this.fetchFlightDeckPgWorkroomContextImpl,
            });
            const profileDecision = this.resolveProfileRuntimeDecision({
              subscription: record,
              eventType: 'chat_mention',
              scopeId: routingContext.scopeId,
              channelId: routingContext.channelId,
              builtInDefaultPipelineId: 'fd-agent-dispatch-chat',
            });
            if (!profilePolicyAllowsDispatch(profileDecision)) {
              return this.appendProfilePolicySuppression({
                record,
                decision: profileDecision!,
                kind: 'chat',
                recordId,
                bindingId: routingContext.threadId,
                bindingType: 'thread',
                sourceLabel,
                details: {
                  channel_id: routingContext.channelId,
                  scope_id: routingContext.scopeId,
                  thread_id: routingContext.threadId,
                },
              });
            }
            record.lastRoutingResult = buildSuccessDiagnostic('Chat dispatch pipeline start requested.', {
              subscription_id: record.subscriptionId,
              record_id: recordId,
              channel_id: routingContext.channelId,
              scope_id: routingContext.scopeId,
              thread_id: routingContext.threadId,
              message_group_npubs: routingContext.messageGroupNpubs,
            });
            record = this.saveRecord(record);
            const pipelineResult = await withTimeout(
              this.dispatchPipelineRuntime.dispatch({
                subscription: record,
                triggerKind: 'chat',
                capability: 'chat_intercept',
                recordId,
                record: latest,
                payload: chatMessage,
                recordFamily: 'chat',
                recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
                recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
                updaterNpub: routingContext.updaterNpub,
                bindingType: 'thread',
                bindingId: routingContext.threadId,
                scopeId: routingContext.scopeId,
                channelId: routingContext.channelId,
                threadId: routingContext.threadId,
                changedFields: [],
                groupNpubs: routingContext.messageGroupNpubs,
                botIdentity: runtime.botIdentity,
                workroomContext,
                profileRuntime: this.buildProfileRuntimeContext(profileDecision),
                sourceLabel,
              }),
              CHAT_ADVISORY_PIPELINE_TIMEOUT_MS,
              'chat_pipeline_dispatch_timeout',
            );
            if (pipelineResult.handled) {
              record.lastRoutingResult = buildSuccessDiagnostic('Chat dispatch pipeline route evaluated.', {
                subscription_id: record.subscriptionId,
                record_id: recordId,
                route_ids: pipelineResult.historyEntries.map((entry) => entry.routeId).filter(Boolean),
                pipeline_run_ids: pipelineResult.historyEntries.map((entry) => entry.pipelineRunId).filter(Boolean),
              });
              record.lastErrorCode = null;
              record.lastErrorAt = null;
              this.clearRuntimeFailure(record.subscriptionId, 'chat_pipeline_dispatched');
              return this.applyDispatchPipelineResult(record, pipelineResult);
            }
            record.lastRoutingResult = buildFailureDiagnostic(
              'chat_pipeline_not_handled',
              'No chat dispatch pipeline route handled this advisory.',
              'chat_pipeline_not_handled',
              {
                subscription_id: record.subscriptionId,
                record_id: recordId,
                channel_id: routingContext.channelId,
                thread_id: routingContext.threadId,
              },
            );
            record = this.saveRecord(record);
          } catch (pipelineError) {
            const detailCode = getErrorDetailCode(pipelineError) ?? 'chat_pipeline_failed';
            record.lastRoutingResult = buildFailureDiagnostic(
              'chat_pipeline_failed',
              pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
              detailCode,
              {
                subscription_id: record.subscriptionId,
                record_id: recordId,
              },
            );
            this.markRuntimeFailure(record.subscriptionId, detailCode, 'chat_pipeline_failed');
            record = this.appendDispatchHistory(record, {
              at: new Date().toISOString(),
              kind: 'chat',
              action: 'chat_pipeline_failed',
              agentId: 'pipeline',
              sessionId: null,
              recordId,
              bindingId: recordId,
              bindingType: 'thread',
              status: 'failed',
              sourceLabel,
              details: {
                diagnostic_summary: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
                detail_code: detailCode,
              },
            });
          }
        }
        const routingResult = await withTimeout(
          this.routingEvaluator.evaluate({
            subscription: record,
            wsSession: runtime.wsSession!,
            groupKeys: runtime.groupKeys,
            chatRecordId: recordId,
            chatRecord: latest,
            chatMessage,
          }),
          CHAT_ADVISORY_ROUTING_TIMEOUT_MS,
          'chat_legacy_routing_timeout',
        );
        record.lastRoutingResult = routingResult.diagnostic;
        record.lastErrorCode = null;
        record.lastErrorAt = null;
        this.clearRuntimeFailure(record.subscriptionId, 'chat_record_decrypted');
        const selfSuppressedAgentIds = getOptionalTextArray(routingResult.diagnostic.details?.self_suppressed_agent_ids);
        const senderNpub = getOptionalText(routingResult.diagnostic.details?.sender_npub);
        const updaterNpub = getOptionalText(routingResult.diagnostic.details?.updater_npub);
        for (const agentId of selfSuppressedAgentIds) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: 'chat',
            action: 'chat_skip_self_update',
            agentId,
            sessionId: null,
            recordId,
            bindingId: recordId,
            bindingType: 'chat',
            sourceLabel,
            details: {
              sender_npub: senderNpub,
              updater_npub: updaterNpub,
            },
          });
        }
        if (routingResult.assignments.length > 0 && this.chatRuntime) {
          for (const assignment of routingResult.assignments) {
            const profileDecision = this.resolveProfileRuntimeDecision({
              subscription: record,
              eventType: 'chat_mention',
              scopeId: assignment.scopeId,
              channelId: assignment.intercept.channelId,
              builtInDefaultPipelineId: 'fd-agent-dispatch-chat',
            });
            if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
              record = this.appendProfilePolicySuppression({
                record,
                decision: profileDecision!,
                kind: 'chat',
                recordId,
                bindingId: assignment.intercept.threadId,
                bindingType: 'thread',
                agentId: assignment.agent.agentId,
                sourceLabel,
                details: {
                  channel_id: assignment.intercept.channelId,
                  scope_id: assignment.scopeId,
                  thread_id: assignment.intercept.threadId,
                  sender_npub: senderNpub,
                  updater_npub: updaterNpub,
                },
              });
              continue;
            }
            record = this.appendDispatchHistory(record, {
              at: new Date().toISOString(),
              kind: 'chat',
              action: 'chat_dispatch',
              agentId: assignment.agent.agentId,
              sessionId: assignment.intercept.sessionId ?? null,
              recordId,
              bindingId: assignment.intercept.routingKey,
              bindingType: 'chat',
              sourceLabel,
              details: {
                channel_id: assignment.intercept.channelId,
                scope_id: assignment.scopeId,
                thread_id: assignment.intercept.threadId,
                sender_npub: senderNpub,
                updater_npub: updaterNpub,
              },
            });
            void this.chatRuntime.handleRoutedChat({
              agent: assignment.agent,
              subscription: record,
              intercept: assignment.intercept,
              botIdentity: runtime.botIdentity,
              chatMessage,
              runtimeContext: profileDecision?.contextText,
            }).catch((runtimeError) => {
              console.warn(
                `[agent-chat] runtime dispatch failed for ${assignment.intercept.routingKey}: ${
                  runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
                }`,
              );
            });
          }
        }
      } catch (error) {
        const detailCode = typeof (error as { code?: string; detailCode?: string })?.code === 'string'
          ? (error as { code: string }).code
          : typeof (error as { detailCode?: string })?.detailCode === 'string'
            ? (error as { detailCode: string }).detailCode
            : 'record_decrypt_failed';
        record.groupKeyStatus = 'refresh_required';
        record.lastErrorCode = 'decrypt_failed';
        record.lastErrorAt = new Date().toISOString();
        record.lastDecryptResult = buildFailureDiagnostic(
          'decrypt_failed',
          error instanceof Error ? error.message : 'Decrypt failed.',
          detailCode,
          { record_id: recordId },
        );
        record.lastRoutingResult = buildFailureDiagnostic(
          'target_bot_not_decrypt_capable',
          error instanceof Error ? error.message : 'Routing skipped because the chat record could not be decrypted.',
          detailCode,
          {
            record_id: recordId,
            target_bot_npub: record.botNpub,
          },
        );
        this.markRuntimeFailure(record.subscriptionId, detailCode, 'record_decrypt_failed');
      }
    } catch (error) {
      const detailCode = typeof (error as { detailCode?: string })?.detailCode === 'string'
        ? (error as { detailCode: string }).detailCode
        : 'record_pull_failed';
      const pullAttempts = typeof (error as { pullAttempts?: unknown })?.pullAttempts === 'number'
        ? (error as { pullAttempts: number }).pullAttempts
        : this.chatRecordPullMaxAttempts;
      record.lastSseEventId = eventCursor.previousLastSseEventId;
      record.lastErrorCode = 'record_pull_failed';
      record.lastErrorAt = new Date().toISOString();
      record.lastRecordPullResult = buildFailureDiagnostic(
        'record_pull_failed',
        error instanceof Error ? error.message : 'Record pull failed.',
        detailCode,
        {
          record_id: recordId,
          pull_attempts: pullAttempts,
          replay_from_event_id: eventCursor.previousLastSseEventId,
          failed_event_id: eventCursor.eventId,
        },
      );
      record.lastDecryptResult = buildFailureDiagnostic(
        'decrypt_failed',
        'Decrypt skipped because record pull failed.',
        detailCode,
        { record_id: recordId },
      );
      record.lastRoutingResult = buildFailureDiagnostic(
        'target_bot_not_decrypt_capable',
        'Routing skipped because the chat record could not be pulled.',
        detailCode,
        {
          record_id: recordId,
          target_bot_npub: record.botNpub,
        },
      );
      this.markRuntimeFailure(record.subscriptionId, detailCode, 'record_pull_failed');
      record = this.saveRecord(this.recomputeHealth(record));
      void this.reconnectForReplay(record.subscriptionId, detailCode).catch((reconnectError) => {
        console.warn(
          `[agent-chat] failed to reconnect after chat record pull failure for ${record.subscriptionId}: ${
            reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
          }`,
        );
      });
      return record;
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private listTaskDispatchAgents(
    subscription: WorkspaceSubscriptionRecord,
    capability: 'task_dispatch' | 'flow_dispatch' | 'task_review' | 'approval_dispatch' = 'task_dispatch',
  ): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub)
      .filter((agent) => agent.enabled && agent.capabilities.includes(capability))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  private listCommentDispatchAgents(subscription: WorkspaceSubscriptionRecord): AgentDefinitionRecord[] {
    return this.agentStore
      .listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub)
      .filter((agent) => agent.enabled && agent.capabilities.includes('comment_dispatch'))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  private listDocumentCommentAgents(
    subscription: WorkspaceSubscriptionRecord,
    commentRecord: Record<string, unknown>,
  ): AgentDefinitionRecord[] {
    return selectDocumentCommentAgents({
      subscription,
      commentRecord,
      agents: this.agentStore.listByWorkspaceAndBot(this.getEffectiveWorkspaceNpub(subscription), subscription.botNpub),
    });
  }

  private async loadAdvisoryRecordVersions(
    subscription: WorkspaceSubscriptionRecord,
    recordId: string,
  ): Promise<Record<string, unknown>[]> {
    const runtime = this.getRuntime(subscription.subscriptionId);
    return await this.fetchRecordHistoryImpl(
      subscription.backendBaseUrl,
      this.getEffectiveWorkspaceNpub(subscription),
      recordId,
      runtime.wsSession!,
    );
  }

  private async decryptAdvisoryPayload(
    subscription: WorkspaceSubscriptionRecord,
    latest: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const runtime = this.getRuntime(subscription.subscriptionId);
    if (!runtime.groupKeys && runtime.wrappedKeyRows.length > 0) {
      const helpers = await loadYokeBotHelpers();
      runtime.groupKeys = helpers.loadBotGroupKeys({
        wsSession: runtime.wsSession!,
        botSecret: runtime.botIdentity.botSecret,
        botNpub: runtime.botIdentity.botNpub,
        keyRows: runtime.wrappedKeyRows,
      });
    }
    return await this.decryptRecordPayloadImpl({
      record: latest,
      wsSession: runtime.wsSession!,
      groupKeys: runtime.groupKeys,
    });
  }

  private async handleTaskRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const [latest, previous] = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0));
      if (!latest) {
        return record;
      }
      const decrypted = await this.decryptAdvisoryPayload(record, latest);
      const updaterNpub = getRecordUpdaterNpub(latest);
      const task = normaliseInboundTaskRecord(decrypted);
      if (!this.isAuthorizedDispatchActor(updaterNpub)) {
        return this.appendUnauthorizedDispatchSuppression({
          record,
          kind: 'task',
          action: 'task_skip_unauthorized_actor',
          recordId,
          bindingId: recordId,
          bindingType: 'task',
          actorNpub: updaterNpub,
          source: 'record',
          sourceLabel: task?.title ?? getOptionalText(decrypted.title),
        });
      }
      if (!task) {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'task',
          action: 'task_skip_invalid_payload',
          agentId: 'unknown',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: 'task',
          sourceLabel: getOptionalText(decrypted.title),
          details: {
            reason: 'normalise_failed',
            updater_npub: updaterNpub,
            payload_keys: Object.keys(decrypted).slice(0, 20),
          },
        });
      }
      let previousTask: InboundTaskRecord | null = null;
      if (previous) {
        try {
          previousTask = normaliseInboundTaskRecord(await this.decryptAdvisoryPayload(record, previous));
        } catch {
          previousTask = null;
        }
      }
      const changedFields = diffTaskDispatchSnapshots(
        buildTaskDispatchSnapshot(task),
        previousTask ? buildTaskDispatchSnapshot(previousTask) : null,
      );

      const dispatchMode = resolveTaskDispatchMode(task);
      const historyKind = dispatchModeToHistoryKind(dispatchMode);
      const bindingId = dispatchModeToBindingId(dispatchMode, task);
      const bindingType = dispatchModeToBindingType(dispatchMode, task);
      const profileDecision = this.resolveProfileRuntimeDecision({
        subscription: record,
        eventType: eventTypeForTaskDispatchMode(dispatchMode),
        scopeId: getTaskScopeId(task),
        builtInDefaultPipelineId: dispatchMode === 'task_dispatch'
          ? 'fd-agent-dispatch-task-response'
          : undefined,
      });
      if (!profilePolicyAllowsDispatch(profileDecision)) {
        return this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: historyKind,
          recordId,
          bindingId,
          bindingType,
          sourceLabel: task.title,
          details: {
            task_id: task.taskId,
            dispatch_mode: dispatchMode,
            scope_id: getTaskScopeId(task),
            updater_npub: updaterNpub,
            changed_fields: changedFields,
          },
        });
      }
      if (this.dispatchPipelineRuntime) {
        const routeAgent = {
          agentId: 'dispatch-pipeline',
          label: 'Dispatch Pipeline',
          botNpub: record.botNpub,
          workspaceOwnerNpub: this.getEffectiveWorkspaceNpub(record),
          managedByNpub: record.managedByNpub,
          workingDirectory: '',
          capabilities: [],
          enabled: true,
          groupNpubs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies AgentDefinitionRecord;
        const pipelineEligibility = evaluateTaskPipelineEligibility({
          task,
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          mode: dispatchMode,
          agent: routeAgent,
        });
        if (pipelineEligibility !== 'dispatch') {
          return this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: pipelineEligibility,
            agentId: routeAgent.agentId,
            sessionId: null,
            recordId,
            bindingId,
            bindingType,
            sourceLabel: task.title,
            details: {
              task_id: task.taskId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
              assigned_to: task.assignedTo,
              state: task.state,
              predecessor_task_ids: task.predecessorTaskIds,
            },
          });
        }
        const triggerKind = dispatchModeToTriggerKind(dispatchMode);
        const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
          subscription: record,
          triggerKind,
          capability: dispatchMode,
          recordId,
          record: latest,
          payload: decrypted,
          recordFamily: 'task',
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
          updaterNpub,
          bindingType,
          bindingId,
          scopeId: getTaskScopeId(task),
          changedFields,
          groupNpubs: [],
          botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
          profileRuntime: this.buildProfileRuntimeContext(profileDecision),
          sourceLabel: task.title,
        });
        if (pipelineResult.handled) {
          return this.applyDispatchPipelineResult(record, pipelineResult);
        }
      }
      if (!this.agentWorkRuntime || dispatchMode !== 'task_dispatch') {
        return record;
      }
      const taskAgents = this.listTaskDispatchAgents(record, 'task_dispatch');
      if (taskAgents.length === 0) {
        return record;
      }

      for (const agent of taskAgents) {
        if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
          record = this.appendProfilePolicySuppression({
            record,
            decision: profileDecision!,
            kind: historyKind,
            recordId,
            bindingId,
            bindingType,
            agentId: agent.agentId,
            sourceLabel: task.title,
            details: {
              task_id: task.taskId,
              dispatch_mode: dispatchMode,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
            },
          });
          continue;
        }
        const skipSelfAction = dispatchModeToSelfSkipAction(dispatchMode);
        if (isSelfUpdater(record, agent, updaterNpub) && !changedFields.includes('new_task') && changedFields.length === 0) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: skipSelfAction,
            agentId: agent.agentId,
            sessionId: null,
            recordId,
            bindingId,
            bindingType,
            sourceLabel: task.title,
            details: {
              task_id: task.taskId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
              assigned_to: task.assignedTo,
              state: task.state,
            },
          });
          continue;
        }
        const eligibility = evaluateTaskPipelineEligibility({
          task,
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          mode: dispatchMode,
          agent,
        });
        if (eligibility !== 'dispatch') {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: eligibility,
            agentId: agent.agentId,
            sessionId: null,
            recordId,
            bindingId,
            bindingType,
            sourceLabel: task.title,
            details: {
              task_id: task.taskId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
              assigned_to: task.assignedTo,
              state: task.state,
              predecessor_task_ids: task.predecessorTaskIds,
            },
          });
          continue;
        }
        const session = await this.agentWorkRuntime.handleTaskDispatch({
          subscription: record,
          agent,
          recordId,
          recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
          task,
          runtimeContext: profileDecision?.contextText,
        });
        if (session) {
          record = this.appendDispatchHistory(record, {
            at: new Date().toISOString(),
            kind: historyKind,
            action: dispatchModeToAction(dispatchMode),
            agentId: agent.agentId,
            sessionId: session.id,
            recordId,
            bindingId,
            bindingType,
            sourceLabel: task.title,
            details: {
              task_id: task.taskId,
              flow_run_id: task.flowRunId,
              flow_id: task.flowId,
              updater_npub: updaterNpub,
              changed_fields: changedFields,
            },
          });
          continue;
        }
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: historyKind,
          action: dispatchModeToNullSkipAction(dispatchMode),
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId,
          bindingType,
          sourceLabel: task.title,
          details: {
            task_id: task.taskId,
            updater_npub: updaterNpub,
            changed_fields: changedFields,
          },
        });
      }
    } catch (error) {
      console.warn(
        `[agent-work] task advisory failed for subscription ${record.subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return record;
  }

  private async handleApprovalRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const [latest, previous] = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0));
      if (!latest) {
        return record;
      }
      const decrypted = await this.decryptAdvisoryPayload(record, latest);
      const updaterNpub = getRecordUpdaterNpub(latest);
      const approval = normaliseInboundApprovalRecord(decrypted);
      if (!approval?.flowRunId) {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'approval',
          action: 'approval_skip_invalid_payload',
          agentId: 'dispatch-pipeline',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: 'flow_run',
          details: {
            reason: 'missing_flow_run_id',
            updater_npub: updaterNpub,
            payload_keys: Object.keys(decrypted).slice(0, 20),
          },
        });
      }
      const profileDecision = this.resolveProfileRuntimeDecision({
        subscription: record,
        eventType: 'approval_assigned',
      });
      if (!profilePolicyAllowsDispatch(profileDecision)) {
        return this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'approval',
          recordId,
          bindingId: approval.flowRunId,
          bindingType: 'flow_run',
          details: {
            approval_id: approval.approvalId,
            flow_run_id: approval.flowRunId,
            flow_id: approval.flowId,
            approval_state: approval.state,
            updater_npub: updaterNpub,
          },
        });
      }
      let previousApproval: InboundApprovalRecord | null = null;
      if (previous) {
        try {
          previousApproval = normaliseInboundApprovalRecord(await this.decryptAdvisoryPayload(record, previous));
        } catch {
          previousApproval = null;
        }
      }
      if (String(approval.state || '').toLowerCase() !== 'approved') {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'approval',
          action: 'approval_dispatch_skip_not_approved',
          agentId: 'dispatch-pipeline',
          sessionId: null,
          recordId,
          bindingId: approval.flowRunId,
          bindingType: 'flow_run',
          details: {
            approval_id: approval.approvalId,
            flow_run_id: approval.flowRunId,
            flow_id: approval.flowId,
            approval_state: approval.state,
            updater_npub: updaterNpub,
          },
        });
      }
      if (String(previousApproval?.state || '').toLowerCase() === 'approved') {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'approval',
          action: 'approval_dispatch_skip_already_approved',
          agentId: 'dispatch-pipeline',
          sessionId: null,
          recordId,
          bindingId: approval.flowRunId,
          bindingType: 'flow_run',
          details: {
            approval_id: approval.approvalId,
            flow_run_id: approval.flowRunId,
            flow_id: approval.flowId,
            approval_state: approval.state,
            updater_npub: updaterNpub,
          },
        });
      }
      if (!this.dispatchPipelineRuntime) {
        return record;
      }
      const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
        subscription: record,
        triggerKind: 'approval',
        capability: 'approval_dispatch',
        recordId,
        record: latest,
        payload: decrypted,
        recordFamily: 'approval',
        recordState: typeof latest.record_state === 'string' ? latest.record_state : null,
        recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        updaterNpub,
        bindingType: 'flow_run',
        bindingId: approval.flowRunId,
        changedFields: [],
        groupNpubs: [],
        botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
        profileRuntime: this.buildProfileRuntimeContext(profileDecision),
      });
      if (pipelineResult.handled) {
        return this.applyDispatchPipelineResult(record, pipelineResult);
      }
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'approval',
        action: 'approval_dispatch_skip_runtime_returned_null',
        agentId: 'dispatch-pipeline',
        sessionId: null,
        recordId,
        bindingId: approval.flowRunId,
        bindingType: 'flow_run',
        details: {
          approval_id: approval.approvalId,
          flow_run_id: approval.flowRunId,
          flow_id: approval.flowId,
          updater_npub: updaterNpub,
        },
      });
    } catch (error) {
      console.warn(
        `[agent-work] approval advisory failed for subscription ${record.subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return record;
  }

  private async handleCommentRecordChanged(
    record: WorkspaceSubscriptionRecord,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSubscriptionRecord> {
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    if (!recordId) {
      return record;
    }
    if (shouldSkipExistingCommentAdvisory(record, payload)) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'comment_skip_existing_record',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: recordId,
        bindingType: null,
        details: {
          record_updated_at: payload.updated_at ?? payload.updatedAt ?? null,
          startup_reload_at: record.lastSuccessfulStartupReloadAt,
        },
      });
    }

    try {
      const versions = await this.loadAdvisoryRecordVersions(record, recordId);
      const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0] ?? null;
      if (!latest) {
        return record;
      }
      if (shouldSkipExistingCommentAdvisory(record, latest)) {
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'comment_skip_existing_record',
          agentId: 'unknown',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: null,
          details: {
            record_updated_at: latest.updated_at ?? latest.updatedAt ?? null,
            startup_reload_at: record.lastSuccessfulStartupReloadAt,
          },
        });
      }
      record.lastRecordPullResult = buildSuccessDiagnostic('Comment advisory pulled.', {
        record_id: recordId,
        version: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        record_state: typeof latest.record_state === 'string' ? latest.record_state : null,
      });

      const decrypted = await this.decryptAdvisoryPayload(record, latest);
      const comment = normaliseInboundCommentRecord(decrypted, latest);
      if (!comment) {
        record.lastDecryptResult = buildFailureDiagnostic(
          'decrypt_failed',
          'Comment routing skipped because the payload could not be normalized.',
          'normalise_failed',
          { record_id: recordId },
        );
        return this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'comment_skip_invalid_payload',
          agentId: 'unknown',
          sessionId: null,
          recordId,
          bindingId: recordId,
          bindingType: null,
          details: {
            payload_keys: Object.keys(decrypted).slice(0, 20),
          },
        });
      }

      record.lastDecryptResult = buildSuccessDiagnostic('Comment advisory decrypted.', {
        record_id: recordId,
        target_record_id: comment.targetRecordId,
        target_record_family_hash: comment.targetRecordFamilyHash,
      });
      const updaterNpub = getRecordUpdaterNpub(latest);
      const commentActorNpub = firstNpub(updaterNpub, comment.senderNpub);
      if (!this.isAuthorizedDispatchActor(commentActorNpub)) {
        return this.appendUnauthorizedDispatchSuppression({
          record,
          kind: 'comment',
          action: 'comment_skip_unauthorized_actor',
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: null,
          actorNpub: commentActorNpub,
          source: 'record',
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            sender_npub: comment.senderNpub,
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
      }

      if (isTaskCommentTarget(comment)) {
        return await this.handleTaskCommentDispatch(record, recordId, latest, comment, updaterNpub);
      }
      if (isDocumentCommentTarget(comment)) {
        return await this.handleDocumentCommentDispatch(record, recordId, latest, comment, updaterNpub);
      }

      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'comment_skip_unsupported_target',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: null,
        details: {
          target_record_family_hash: comment.targetRecordFamilyHash,
          comment_id: comment.commentId,
        },
      });
    } catch (error) {
      console.warn(
        `[agent-comment] comment advisory failed for subscription ${record.subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return record;
    }
  }

  private async handleTaskCommentDispatch(
    record: WorkspaceSubscriptionRecord,
    recordId: string,
    latest: Record<string, unknown>,
    comment: InboundCommentRecord,
    updaterNpub: string | null,
  ): Promise<WorkspaceSubscriptionRecord> {
    if (await this.isSelfCommentEvent(record, comment, updaterNpub)) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'task_comment_skip_self_update',
        agentId: 'pipeline',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
          is_me: true,
        },
      });
    }

    const commentAgents = this.listCommentDispatchAgents(record);
    if (commentAgents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'task_comment_skip_no_comment_dispatch_agent',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
        },
      });
    }

    const managerAuthored = isManagerAuthoredComment(record, comment, updaterNpub);
    const selectedAgents = managerAuthored
      ? commentAgents
      : commentAgents.filter((agent) => commentMentionsAgent(comment, agent));
    if (selectedAgents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'task_comment_skip_no_agent_mention',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
          eligible_agent_ids: commentAgents.map((agent) => agent.agentId),
          mention_required: true,
        },
      });
    }

    const profileDecision = this.resolveProfileRuntimeDecision({
      subscription: record,
      eventType: 'task_comment',
      builtInDefaultPipelineId: 'fd-agent-dispatch-comment-response',
    });
    if (!profilePolicyAllowsDispatch(profileDecision)) {
      return this.appendProfilePolicySuppression({
        record,
        decision: profileDecision!,
        kind: 'comment',
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
        },
      });
    }

    if (this.dispatchPipelineRuntime) {
      const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
        subscription: record,
        triggerKind: 'comment',
        capability: 'comment_dispatch',
        recordId,
        record: latest,
        payload: { ...comment },
        recordFamily: 'comment',
        recordState: comment.recordState,
        recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        updaterNpub,
        bindingType: 'task',
        bindingId: comment.targetRecordId,
        changedFields: [],
        groupNpubs: extractCommentGroupNpubs(latest),
        botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
        profileRuntime: this.buildProfileRuntimeContext(profileDecision),
      });
      if (pipelineResult.handled) {
        return this.applyDispatchPipelineResult(record, pipelineResult);
      }
    }

    for (const agent of selectedAgents) {
      if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
        record = this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'comment',
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'task',
          agentId: agent.agentId,
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            sender_npub: comment.senderNpub,
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
        continue;
      }
      if (isSelfCommentAuthor(record, agent, comment, updaterNpub)) {
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'task_comment_skip_self_update',
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'task',
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            sender_npub: comment.senderNpub,
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
        continue;
      }
      const decision = this.commentDispatchRuntime?.handleDisabledDispatch({
        target: 'task',
        agent,
        comment,
        updaterNpub,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: decision?.action ?? 'task_comment_dispatch_disabled',
        agentId: agent.agentId,
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'task',
        details: decision?.details ?? {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_family_hash: comment.targetRecordFamilyHash,
          disabled_reason: 'comment_dispatch_stubbed',
        },
      });
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private async handleDocumentCommentDispatch(
    record: WorkspaceSubscriptionRecord,
    recordId: string,
    latest: Record<string, unknown>,
    comment: InboundCommentRecord,
    updaterNpub: string | null,
  ): Promise<WorkspaceSubscriptionRecord> {
    if (await this.isSelfCommentEvent(record, comment, updaterNpub)) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'document_comment_skip_self_update',
        agentId: 'pipeline',
        sessionId: null,
        recordId,
        bindingId: comment.parentCommentId ?? comment.commentId,
        bindingType: 'thread',
        details: {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          is_me: true,
        },
      });
    }

    const agents = this.listDocumentCommentAgents(record, latest);
    if (agents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'document_comment_skip_no_comment_dispatch_agent',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: {
          comment_id: comment.commentId,
          target_record_id: comment.targetRecordId,
        },
      });
    }

    const managerAuthored = isManagerAuthoredComment(record, comment, updaterNpub);
    const selectedAgents = managerAuthored
      ? agents
      : agents.filter((agent) => commentMentionsAgent(comment, agent));
    if (selectedAgents.length === 0) {
      return this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: 'document_comment_skip_no_agent_mention',
        agentId: 'unknown',
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: {
          comment_id: comment.commentId,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          eligible_agent_ids: agents.map((agent) => agent.agentId),
          mention_required: true,
        },
      });
    }

    const profileDecision = this.resolveProfileRuntimeDecision({
      subscription: record,
      eventType: 'document_comment_tagged',
      builtInDefaultPipelineId: 'fd-agent-dispatch-comment-response',
    });
    if (!profilePolicyAllowsDispatch(profileDecision)) {
      return this.appendProfilePolicySuppression({
        record,
        decision: profileDecision!,
        kind: 'comment',
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: {
          comment_id: comment.commentId,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          updater_npub: updaterNpub,
        },
      });
    }

    if (this.dispatchPipelineRuntime) {
      const pipelineResult = await this.dispatchPipelineRuntime.dispatch({
        subscription: record,
        triggerKind: 'comment',
        capability: 'comment_dispatch',
        recordId,
        record: latest,
        payload: { ...comment },
        recordFamily: 'comment',
        recordState: comment.recordState,
        recordVersion: typeof latest.version === 'number' ? latest.version : Number(latest.version ?? 0),
        updaterNpub,
        bindingType: 'document',
        bindingId: comment.targetRecordId,
        changedFields: [],
        groupNpubs: extractCommentGroupNpubs(latest),
        botIdentity: this.getRuntime(record.subscriptionId)?.botIdentity ?? null,
        profileRuntime: this.buildProfileRuntimeContext(profileDecision),
      });
      if (pipelineResult.handled) {
        return this.applyDispatchPipelineResult(record, pipelineResult);
      }
    }

    for (const agent of selectedAgents) {
      if (!profilePolicyAllowsLegacyPrompt(profileDecision)) {
        record = this.appendProfilePolicySuppression({
          record,
          decision: profileDecision!,
          kind: 'comment',
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'document',
          agentId: agent.agentId,
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            target_record_id: comment.targetRecordId,
            target_record_family_hash: comment.targetRecordFamilyHash,
          },
        });
        continue;
      }
      if (isSelfCommentAuthor(record, agent, comment, updaterNpub)) {
        record = this.appendDispatchHistory(record, {
          at: new Date().toISOString(),
          kind: 'comment',
          action: 'document_comment_skip_self_update',
          agentId: agent.agentId,
          sessionId: null,
          recordId,
          bindingId: comment.targetRecordId,
          bindingType: 'document',
          details: {
            comment_id: comment.commentId,
            updater_npub: updaterNpub,
            target_record_id: comment.targetRecordId,
          },
        });
        continue;
      }
      const decision = this.commentDispatchRuntime?.handleDisabledDispatch({
        target: 'document',
        agent,
        comment,
        updaterNpub,
      });
      record = this.appendDispatchHistory(record, {
        at: new Date().toISOString(),
        kind: 'comment',
        action: decision?.action ?? 'document_comment_dispatch_disabled',
        agentId: agent.agentId,
        sessionId: null,
        recordId,
        bindingId: comment.targetRecordId,
        bindingType: 'document',
        details: decision?.details ?? {
          comment_id: comment.commentId,
          updater_npub: updaterNpub,
          sender_npub: comment.senderNpub,
          target_record_id: comment.targetRecordId,
          target_record_family_hash: comment.targetRecordFamilyHash,
          disabled_reason: 'comment_dispatch_stubbed',
        },
      });
    }
    return this.saveRecord(this.recomputeHealth(record));
  }

  private stopRuntime(subscriptionId: string, removed: boolean): void {
    this.flightDeckPgEventWatchdog.stop(subscriptionId);
    const runtime = this.runtimes.get(subscriptionId);
    if (!runtime) {
      return;
    }
    runtime.removed = removed;
    runtime.abortController?.abort();
    runtime.abortController = null;
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    if (removed) {
      runtime.botIdentity.botSecret.fill(0);
    }
  }

  private async repairSubscription(
    record: WorkspaceSubscriptionRecord,
    options: {
      refreshWorkspaceKey: boolean;
      reconnect: boolean;
      allowRegisterWhenInactive: boolean;
      reason: string;
    },
  ): Promise<WorkspaceSubscriptionRecord> {
    const botIdentity = await this.resolveStoredBotIdentity(record.botNpub);
    if (!botIdentity) {
      throw new Error(`Bot key record not found for ${record.botNpub}.`);
    }

    const prepared = await this.prepareWorkspaceSession(record, botIdentity, {
      forceNew: options.refreshWorkspaceKey,
    });

    let next = prepared;
    if (options.refreshWorkspaceKey || (options.allowRegisterWhenInactive && prepared.wsKeyStatus !== 'active')) {
      next = await this.registerWorkspaceKey(prepared, botIdentity);
      this.clearRuntimeFailure(next.subscriptionId, `${options.reason}_workspace_key_registered`);
    }

    next = await this.refreshGroupKeys(next, botIdentity, false);
    if (options.reconnect) {
      await this.ensureConnected(next, botIdentity, false);
    }

    await this.replayPendingIntercepts(next, botIdentity);

    const latest = this.store.getBySubscriptionId(record.subscriptionId) ?? next;
    this.clearRuntimeFailure(latest.subscriptionId, options.reason);
    return latest;
  }

  private async replayPendingIntercepts(
    record: WorkspaceSubscriptionRecord,
    botIdentity: RuntimeBotIdentity,
  ): Promise<void> {
    if (!this.chatRuntime) {
      return;
    }

    const runtime = this.runtimes.get(record.subscriptionId);
    if (!runtime) {
      return;
    }

    const pendingIntercepts = this.routingEvaluator
      .listInterceptsForSubscription(record.subscriptionId)
      .filter((intercept) => this.chatRuntime?.hasRecoverableDirectChat(intercept.routingKey)
        || this.shouldReplayPendingIntercept(intercept));

    if (pendingIntercepts.length === 0) {
      return;
    }

    if (record.workspaceId) {
      for (const intercept of pendingIntercepts) {
        try {
          const hydrated = await hydrateDirectChatThread({ subscription: record, botIdentity,
            channelId: intercept.channelId, threadId: intercept.threadId },
            { fetchChannel: this.fetchFlightDeckPgChannelImpl, fetchMessages: this.fetchFlightDeckPgChannelMessagesImpl });
          const recovery = this.chatRuntime.recoverDirectChat({ subscription: record, botIdentity,
            channel: hydrated.channel, messages: hydrated.messages,
            event: { entity_id: intercept.lastMessageIdSeen, channel_id: intercept.channelId, cursor: intercept.lastEventCursorSeen } },
            intercept.routingKey);
          if (recovery.handled) continue;
          await this.chatRuntime.handleDirectChat({ subscription: record, botIdentity, channel: hydrated.channel, messages: hydrated.messages,
            event: { entity_id: intercept.lastMessageIdSeen, channel_id: intercept.channelId, cursor: intercept.lastEventCursorSeen } });
        } catch (error) {
          console.warn(`[agent-chat] failed to replay direct turn ${intercept.routingKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    if (!runtime.wsSession) {
      return;
    }

    const helpers = await loadYokeBotHelpers();
    if (!runtime.groupKeys && runtime.wrappedKeyRows.length > 0) {
      runtime.groupKeys = helpers.loadBotGroupKeys({
        wsSession: runtime.wsSession!,
        botSecret: botIdentity.botSecret,
        botNpub: botIdentity.botNpub,
        keyRows: runtime.wrappedKeyRows,
      });
    }

    for (const intercept of pendingIntercepts) {
      const agent = this.agentStore.getByAgentId(intercept.agentId);
      if (!agent || !agent.enabled) {
        continue;
      }
      const messageId = intercept.lastMessageIdSeen;
      if (!messageId) {
        continue;
      }

      try {
        const versions = await fetchRecordHistory(
          record.backendBaseUrl,
          this.getEffectiveWorkspaceNpub(record),
          messageId,
          runtime.wsSession!,
        );
        const latest = versions.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
        if (!latest) {
          continue;
        }
        const chatMessage = helpers.decryptChatRecord({
          record: latest,
          wsSession: runtime.wsSession!,
          groupKeys: runtime.groupKeys,
        });
        if (chatMessage?.sender_npub === agent.botNpub) {
          chatInterceptStateStore.save({
            ...intercept,
            state: 'idle',
            lastDecision: 'respond',
            pendingMessageCount: 0,
            lastActivityAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        void this.chatRuntime.handleRoutedChat({
          agent,
          subscription: record,
          intercept,
          botIdentity,
          chatMessage,
        }).catch((runtimeError) => {
          console.warn(
            `[agent-chat] pending-turn replay failed for ${intercept.routingKey}: ${
              runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
            }`,
          );
        });
      } catch (error) {
        console.warn(
          `[agent-chat] failed to reload pending turn ${messageId} for ${intercept.routingKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private shouldReplayPendingIntercept(intercept: ChatInterceptStateRecord): boolean {
    if (!intercept.lastMessageIdSeen) {
      return false;
    }
    if (intercept.workspaceId && intercept.lastCompletedTurnId && intercept.state === 'idle') {
      return false;
    }
    if (!intercept.workspaceId && intercept.lastDecision !== 'pending') {
      return false;
    }
    return intercept.state === 'idle'
      || intercept.state === 'pending'
      || intercept.state === 'active'
      || (intercept.state === 'archived' && intercept.pendingMessageCount > 0)
      || intercept.state === 'interrupting'
      || intercept.state === 'interrupt_failed';
  }

  private async isSelfCommentEvent(
    record: WorkspaceSubscriptionRecord,
    comment: InboundCommentRecord,
    updaterNpub: string | null,
  ): Promise<boolean> {
    if (isSelfCommentEvent(record, comment, updaterNpub)) {
      return true;
    }

    const senderNpub = comment.senderNpub ?? null;
    if (!senderNpub || !updaterNpub || senderNpub !== updaterNpub) {
      return false;
    }

    const resolvedOwner = await this.resolveWorkspaceKeyOwnerNpub(record, senderNpub);
    return resolvedOwner === record.botNpub;
  }

  private async resolveWorkspaceKeyOwnerNpub(
    record: WorkspaceSubscriptionRecord,
    workspaceKeyNpub: string,
  ): Promise<string | null> {
    const cacheKey = `${record.subscriptionId}:${this.getEffectiveWorkspaceNpub(record)}`;
    const now = Date.now();
    const cached = this.workspaceKeyOwnerCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < WORKSPACE_KEY_MAPPING_CACHE_MS) {
      return cached.owners.get(workspaceKeyNpub) ?? null;
    }

    const runtime = this.runtimes.get(record.subscriptionId);
    if (!runtime?.wsSession) {
      return cached?.owners.get(workspaceKeyNpub) ?? null;
    }

    try {
      const mappings = await this.fetchWorkspaceKeyMappingsImpl(
        record.backendBaseUrl,
        this.getEffectiveWorkspaceNpub(record),
        runtime.wsSession!,
      );
      const owners = new Map<string, string>();
      for (const mapping of mappings) {
        if (typeof mapping?.ws_key_npub === 'string' && typeof mapping?.user_npub === 'string') {
          owners.set(mapping.ws_key_npub, mapping.user_npub);
        }
      }
      this.workspaceKeyOwnerCache.set(cacheKey, { fetchedAt: now, owners });
      return owners.get(workspaceKeyNpub) ?? null;
    } catch (error) {
      if (!cached) {
        this.workspaceKeyOwnerCache.set(cacheKey, { fetchedAt: now, owners: new Map() });
      }
      return cached?.owners.get(workspaceKeyNpub) ?? null;
    }
  }

  private getRuntime(subscriptionId: string): RuntimeContext {
    const runtime = this.runtimes.get(subscriptionId);
    if (!runtime) {
      throw new Error(`Missing runtime for subscription ${subscriptionId}`);
    }
    return runtime;
  }

  private saveRecord(record: WorkspaceSubscriptionRecord): WorkspaceSubscriptionRecord {
    record.updatedAt = new Date().toISOString();
    return this.store.save(record);
  }

  private appendDispatchHistory(
    record: WorkspaceSubscriptionRecord,
    entry: AgentChatDispatchHistoryEntry,
  ): WorkspaceSubscriptionRecord {
    record.recentDispatches = trimRecentEntries(
      [...(Array.isArray(record.recentDispatches) ? record.recentDispatches : []), entry],
      MAX_RECENT_DISPATCHES,
    );
    const saved = this.saveRecord(record);
    this.dispatchOutcomeStore.recordHistory(saved.subscriptionId, entry);
    return saved;
  }

  private applyDispatchPipelineResult(
    record: WorkspaceSubscriptionRecord,
    result: DispatchPipelineRuntimeResult,
  ): WorkspaceSubscriptionRecord {
    for (const entry of result.historyEntries) {
      record = this.appendDispatchHistory(record, entry);
    }
    if (result.lastPipelineRunId) {
      record.lastPipelineRunId = result.lastPipelineRunId;
      return this.saveRecord(record);
    }
    return record;
  }

  private markRuntimeFailure(subscriptionId: string, detailCode: string | null, reason: string): void {
    const state = mapFailureState(detailCode);
    if (!state || !this.chatRuntime) {
      return;
    }
    this.chatRuntime.markSubscriptionBlocked(subscriptionId, state, reason);
  }

  private clearRuntimeFailure(subscriptionId: string, reason: string): void {
    if (!this.chatRuntime) {
      return;
    }
    this.chatRuntime.clearSubscriptionBlocked(subscriptionId, reason);
  }

  private recomputeHealth(record: WorkspaceSubscriptionRecord): WorkspaceSubscriptionRecord {
    if (record.wsKeyStatus === 'revoked' || record.wsKeyStatus === 'failed') {
      record.healthStatus = 'unhealthy';
      return record;
    }
    const flightDeckPgSubscription = isFlightDeckPgSubscription(record);
    const groupStateHealthy = flightDeckPgSubscription || record.groupKeyStatus === 'active';
    if ((!groupStateHealthy && (record.groupKeyStatus === 'failed' || record.groupKeyStatus === 'refresh_required')) || record.sseStatus === 'backoff') {
      record.healthStatus = 'degraded';
      return record;
    }
    const eventPollingHealthy = !flightDeckPgSubscription || !record.lastEventPollErrorCode;
    if (record.sseStatus === 'connected' && record.wsKeyStatus === 'active' && groupStateHealthy && eventPollingHealthy) {
      record.healthStatus = 'healthy';
      return record;
    }
    record.healthStatus = 'degraded';
    return record;
  }

  private async resolveAgentGroupNpubs(input: {
    requestedGroupNpubs: string[];
    workspaceOwnerNpub: string;
    botNpub: string;
    managedByNpub: string;
  }): Promise<string[]> {
    if (input.requestedGroupNpubs.length > 0) {
      return input.requestedGroupNpubs;
    }

    const subscription = this.store
      .listForManagerNpub(input.managedByNpub)
      .find((record) => (
        (record.lifecycleStatus ?? 'active') === 'active'
        && this.getEffectiveWorkspaceNpub(record) === input.workspaceOwnerNpub
        && record.botNpub === input.botNpub
      ));
    const cachedGroupNpubs = subscription ? this.deriveGroupNpubsFromSubscription(subscription) : [];
    if (cachedGroupNpubs.length > 0) {
      return cachedGroupNpubs;
    }

    if (!subscription) {
      return [];
    }

    await this.repairSubscription(subscription, {
      refreshWorkspaceKey: false,
      reconnect: subscription.sseStatus !== 'disabled',
      allowRegisterWhenInactive: true,
      reason: 'agent_create_refresh_groups',
    });
    const refreshed = this.store.getBySubscriptionId(subscription.subscriptionId) ?? subscription;
    return this.deriveGroupNpubsFromSubscription(refreshed);
  }
}
