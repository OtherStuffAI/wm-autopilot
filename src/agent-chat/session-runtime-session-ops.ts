import type { AgentType } from '../config';
import { resolveAuthoritativeSessionMessages } from '../agents/authoritative-session-messages';
import { matchesCodexPrompt } from '../agents/codex-session-discovery';
import type { ProcessManager, SessionOrigin, SessionSnapshot } from '../agents/process-manager';
import { scheduleSessionArchive } from '../storage/session-archiver';
import { parseAgentChatReply } from './session-runtime-decision';
import type { ChatInterceptStateStore } from './chat-intercept-state-store';
import type { AgentDefinitionRecord, ChatInterceptStateRecord, WorkspaceSubscriptionRecord } from './types';
import { waitForSessionPromptReadiness } from '../server/session-readiness';

const SESSION_READY_TIMEOUT_MS = 120_000;
const ASSISTANT_REPLY_TIMEOUT_MS = 300_000;
const ASSISTANT_REPLY_POLL_INTERVAL_MS = 250;
const ASSISTANT_REPLY_STABLE_POLLS = 2;
const ASSISTANT_REPLY_DECISION_FALLBACK_STABLE_POLLS = 5;
const NATIVE_SESSION_DISCOVERY_RETRY_MS = 1_000;

export interface AssistantReplyResult {
  content: string;
  createdAt: string;
  settledWithoutStableRuntime?: boolean;
}

export interface AcceptedFinalInspection {
  reply: AssistantReplyResult | null;
  sessionState: 'active' | 'stopped' | 'missing';
}

export interface AssistantReplyWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  stablePolls?: number;
  decisionFallbackStablePolls?: number;
  onAccepted?: () => void | Promise<void>;
  onPoll?: () => void | Promise<void>;
  promptBoundaryTimeoutMs?: number;
}

export class PromptBoundaryNotObservedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} remained stable without exposing the submitted prompt boundary.`);
    this.name = 'PromptBoundaryNotObservedError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDirectChatPromptReadiness(manager: ProcessManager, sessionId: string): Promise<void> {
  const session = manager.getSession(sessionId);
  await waitForSessionPromptReadiness({
    getSession: (id) => manager.getSession(id) ?? null,
    getAdapter: (id) => manager.getAdapter(id),
    sessionId,
    host: '127.0.0.1',
    timeoutMs: session?.agent === 'codex' ? SESSION_READY_TIMEOUT_MS : 60_000,
    pollIntervalMs: 250,
    requiredStablePolls: session?.agent === 'codex' ? 3 : 2,
    requestTimeoutMs: 750,
  });
}

function truncateText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export function resolveReusableSession(
  manager: ProcessManager,
  intercept: ChatInterceptStateRecord,
  idleRetentionMs: number,
): SessionSnapshot | null {
  if (!intercept.sessionId) {
    return null;
  }
  const session = manager.getSession(intercept.sessionId);
  if (!session) {
    return null;
  }
  if (session.status !== 'running' && session.status !== 'starting') {
    return null;
  }
  if (hasExpiredRetention(intercept, idleRetentionMs)) {
    return null;
  }
  return session;
}

export async function createAgentChatSession(params: {
  defaultAgent: AgentType;
  manager: ProcessManager;
  agent: AgentDefinitionRecord;
  intercept: ChatInterceptStateRecord;
  subscription: WorkspaceSubscriptionRecord;
}): Promise<SessionSnapshot> {
  const sessionName = `${params.agent.label || params.agent.agentId} Chat ${truncateText(params.intercept.threadId, 20)}`;
  const origin: SessionOrigin = {
    type: 'agent-chat',
    id: params.intercept.routingKey,
    label: `${params.agent.agentId} ${truncateText(params.intercept.channelId, 12)}:${truncateText(params.intercept.threadId, 12)}`,
  };
  return await params.manager.createSession(
    params.defaultAgent,
    params.agent.workingDirectory,
    sessionName,
    origin,
    undefined,
    params.subscription.managedByNpub ?? undefined,
    {
      AGENT: true,
      role: 'agent-chat',
      routedBy: 'agent-chat',
      agentChatAgentId: params.agent.agentId,
      agentChatBotNpub: params.agent.botNpub,
      createdByNpub: params.subscription.managedByNpub ?? undefined,
      lastManagedByNpub: params.subscription.managedByNpub ?? undefined,
      chargeToNpub: params.subscription.managedByNpub ?? undefined,
    },
  );
}

export async function sendPromptAndAwaitAssistantReply(
  manager: ProcessManager,
  sessionId: string,
  prompt: string,
  waitOptions?: AssistantReplyWaitOptions,
): Promise<AssistantReplyResult> {
  const adapter = manager.getAdapter(sessionId);
  if (!adapter) {
    throw new Error(`No adapter available for session ${sessionId}.`);
  }
  await adapter.waitForReady({
    timeoutMs: SESSION_READY_TIMEOUT_MS,
    pollIntervalMs: 250,
  });
  const initialMessages = await adapter.fetchMessages().catch(() => []);
  await adapter.sendMessage(prompt, 'user');
  await waitOptions?.onAccepted?.();
  return await awaitAssistantReply(manager, sessionId, initialMessages.length, waitOptions);
}

/**
 * Deliver a prompt and return only the adapter's completed final response.
 * Streaming assistant text and `agent-working` progress are not eligible: the
 * adapter must report the turn stable and expose a new assistant/agent card.
 */
export async function sendPromptAndAwaitFinalResponse(
  manager: ProcessManager,
  sessionId: string,
  prompt: string,
  waitOptions?: Pick<AssistantReplyWaitOptions, 'timeoutMs' | 'pollIntervalMs' | 'onAccepted' | 'onPoll' | 'promptBoundaryTimeoutMs'>,
): Promise<AssistantReplyResult> {
  const adapter = manager.getAdapter(sessionId);
  if (!adapter) throw new Error(`No adapter available for session ${sessionId}.`);
  await waitForDirectChatPromptReadiness(manager, sessionId);
  const initialMessages = await adapter.fetchMessages().catch(() => []);
  const initialSession = manager.getSession(sessionId);
  const initialNativeSessionId = initialSession?.metadata?.nativeAgentSession?.agent === 'codex'
    ? initialSession.metadata.nativeAgentSession.sessionId
    : null;
  const initialAuthoritativeMessages = initialSession?.agent === 'codex' && initialNativeSessionId
    ? await resolveAuthoritativeSessionMessages(initialSession, initialMessages, { requireNative: true }).catch(() => [])
    : [];
  const sentAtMs = Date.now();
  await adapter.sendMessage(prompt, 'user');
  await waitOptions?.onAccepted?.();
  await manager.captureAgentapiCodexSessionIdFromPrompt?.(sessionId, prompt, { sentAtMs, attempts: 1, retryMs: 0 });

  const pollIntervalMs = Math.max(10, waitOptions?.pollIntervalMs ?? ASSISTANT_REPLY_POLL_INTERVAL_MS);
  const transcriptRefreshIntervalMs = waitOptions?.pollIntervalMs === undefined ? 400 : pollIntervalMs;
  const deadline = Date.now() + Math.max(pollIntervalMs, waitOptions?.timeoutMs ?? ASSISTANT_REPLY_TIMEOUT_MS);
  const promptBoundaryDeadline = Date.now() + Math.max(pollIntervalMs, waitOptions?.promptBoundaryTimeoutMs ?? 15_000);
  let nextNativeDiscoveryAt = Date.now() + NATIVE_SESSION_DISCOVERY_RETRY_MS;
  let observedActiveRuntime = false;
  while (Date.now() < deadline) {
    let session = manager.getSession(sessionId);
    const currentAdapter = manager.getAdapter(sessionId);
    if (!currentAdapter) throw new Error(`Session ${sessionId} no longer has an adapter.`);
    const agentapiCodex = session?.agent === 'codex' && !currentAdapter.deliversPromptsDirectly?.();
    const nativeCodexMissing = agentapiCodex && !(
      session?.metadata?.nativeAgentSession?.agent === 'codex'
      && session.metadata.nativeAgentSession.sessionId
    );
    if (nativeCodexMissing && Date.now() >= nextNativeDiscoveryAt) {
      await manager.captureAgentapiCodexSessionIdFromPrompt?.(sessionId, prompt, {
        sentAtMs,
        attempts: 1,
        retryMs: 0,
      });
      nextNativeDiscoveryAt = Date.now() + NATIVE_SESSION_DISCOVERY_RETRY_MS;
      session = manager.getSession(sessionId);
    }
    // AgentAPI's status endpoint can time out while the native Codex transcript
    // has already recorded a final answer. Keep the two observations independent
    // so a transient status failure cannot discard an authoritative native final.
    const [messages, runtimeStatus] = await Promise.all([
      currentAdapter.fetchMessages().catch(() => []),
      currentAdapter.fetchStatus().catch(() => null),
    ]);
    const nativeCodexReady = session?.metadata?.nativeAgentSession?.agent === 'codex'
      && Boolean(session.metadata.nativeAgentSession.sessionId);
    const authoritativeMessages = agentapiCodex
      ? nativeCodexReady && session
        ? await resolveAuthoritativeSessionMessages(session, messages, {
            requireNative: true,
            minimumRefreshIntervalMs: transcriptRefreshIntervalMs,
          })
        : []
      : messages;
    await waitOptions?.onPoll?.();
    const currentNativeSessionId = session?.metadata?.nativeAgentSession?.agent === 'codex'
      ? session.metadata.nativeAgentSession.sessionId
      : null;
    const promptBoundaryFloor = initialNativeSessionId && currentNativeSessionId === initialNativeSessionId
      ? initialAuthoritativeMessages.length
      : 0;
    const promptIndex = authoritativeMessages.findLastIndex((message, index) =>
      index >= promptBoundaryFloor && message.role === 'user' && matchesCodexPrompt(message.content, prompt));
    if (promptIndex < 0) {
      if (runtimeStatus && runtimeStatus !== 'stable') observedActiveRuntime = true;
      if (!observedActiveRuntime && Date.now() >= promptBoundaryDeadline) {
        throw new PromptBoundaryNotObservedError(sessionId);
      }
    }
    const nextPromptOffset = promptIndex >= 0
      ? authoritativeMessages.slice(promptIndex + 1).findIndex((message) => message.role === 'user')
      : -1;
    const turnMessages = promptIndex < 0
      ? []
      : nextPromptOffset >= 0
        ? authoritativeMessages.slice(promptIndex + 1, promptIndex + 1 + nextPromptOffset)
        : authoritativeMessages.slice(promptIndex + 1);
    const finalMessage = turnMessages
      .filter((message) => (message.role === 'assistant' || message.role === 'agent') && message.content.trim().length > 0)
      .at(-1);
    if (finalMessage && (nativeCodexReady || runtimeStatus === 'stable')) {
      return { content: finalMessage.content, createdAt: finalMessage.createdAt };
    }
    if (!session || (session.status !== 'running' && session.status !== 'starting')) {
      throw new Error(`Session ${sessionId} stopped before producing a final response.`);
    }
    await sleep(pollIntervalMs);
  }
  const finalSession = manager.getSession(sessionId);
  const finalAdapter = manager.getAdapter(sessionId);
  if (finalSession?.agent === 'codex'
    && !finalAdapter?.deliversPromptsDirectly?.()
    && !(finalSession.metadata?.nativeAgentSession?.agent === 'codex'
      && finalSession.metadata.nativeAgentSession.sessionId)) {
    throw new Error(`Timed out waiting for session ${sessionId}: native Codex session was not captured; terminal output was rejected.`);
  }
  throw new Error(`Timed out waiting for session ${sessionId} to produce a final response.`);
}

export async function awaitAcceptedFinalResponse(
  manager: ProcessManager,
  sessionId: string,
  prompt: string,
  sourceMessageIds: string[],
  waitOptions?: Pick<AssistantReplyWaitOptions, 'timeoutMs' | 'pollIntervalMs' | 'onPoll'> & { acceptedAt?: string },
): Promise<AssistantReplyResult> {
  const acceptedAtMs = Date.parse(waitOptions?.acceptedAt ?? '');
  const sentAtMs = Number.isFinite(acceptedAtMs) ? acceptedAtMs : Date.now();
  await manager.captureAgentapiCodexSessionIdFromPrompt?.(sessionId, prompt, { sentAtMs, attempts: 1, retryMs: 0 });
  const pollIntervalMs = Math.max(10, waitOptions?.pollIntervalMs ?? ASSISTANT_REPLY_POLL_INTERVAL_MS);
  const transcriptRefreshIntervalMs = waitOptions?.pollIntervalMs === undefined ? 400 : pollIntervalMs;
  const deadline = Date.now() + Math.max(pollIntervalMs, waitOptions?.timeoutMs ?? ASSISTANT_REPLY_TIMEOUT_MS);
  let nextNativeDiscoveryAt = Date.now() + NATIVE_SESSION_DISCOVERY_RETRY_MS;
  while (Date.now() < deadline) {
    let session = manager.getSession(sessionId);
    if (!session) throw new Error(`Accepted Direct Chat session ${sessionId} is missing.`);
    const adapter = manager.getAdapter(sessionId);
    const nativeCodexMissing = session.agent === 'codex'
      && !adapter?.deliversPromptsDirectly?.()
      && !(
        session.metadata?.nativeAgentSession?.agent === 'codex'
        && session.metadata.nativeAgentSession.sessionId
      );
    if (nativeCodexMissing && Date.now() >= nextNativeDiscoveryAt) {
      await manager.captureAgentapiCodexSessionIdFromPrompt?.(sessionId, prompt, {
        sentAtMs,
        attempts: 1,
        retryMs: 0,
      });
      nextNativeDiscoveryAt = Date.now() + NATIVE_SESSION_DISCOVERY_RETRY_MS;
      session = manager.getSession(sessionId) ?? session;
    }
    let liveMessages: Array<{ role: string; content: string; createdAt: string }> = [];
    let runtimeStatus: Awaited<ReturnType<NonNullable<typeof adapter>['fetchStatus']>> | null = null;
    if (adapter) {
      [liveMessages, runtimeStatus] = await Promise.all([
        adapter.fetchMessages().catch(() => []),
        adapter.fetchStatus().catch(() => null),
      ]);
    }
    const nativeCodexReady = session.agent === 'codex'
      && session.metadata?.nativeAgentSession?.agent === 'codex'
      && Boolean(session.metadata.nativeAgentSession.sessionId);
    const authoritativeMessages = nativeCodexReady
      ? await resolveAuthoritativeSessionMessages(session, liveMessages, {
          requireNative: true,
          minimumRefreshIntervalMs: transcriptRefreshIntervalMs,
        })
      : adapter?.deliversPromptsDirectly?.() ? liveMessages : [];
    await waitOptions?.onPoll?.();
    const boundaryIndex = authoritativeMessages.findLastIndex((message) => {
      if (message.role !== 'user') return false;
      if (matchesCodexPrompt(message.content, prompt)) return true;
      return sourceMessageIds.some((id) => message.content.includes(id));
    });
    const finalMessage = (boundaryIndex >= 0 ? authoritativeMessages.slice(boundaryIndex + 1) : [])
      .filter((message) => (message.role === 'assistant' || message.role === 'agent') && message.content.trim().length > 0)
      .at(-1);
    if (finalMessage && (nativeCodexReady || runtimeStatus === 'stable')) {
      return { content: finalMessage.content, createdAt: finalMessage.createdAt };
    }
    if (!adapter && session.status !== 'running' && session.status !== 'starting') {
      throw new Error(`Accepted Direct Chat session ${sessionId} stopped without a recoverable final response.`);
    }
    await sleep(pollIntervalMs);
  }
  const finalSession = manager.getSession(sessionId);
  const finalAdapter = manager.getAdapter(sessionId);
  if (finalSession?.agent === 'codex'
    && !finalAdapter?.deliversPromptsDirectly?.()
    && !(finalSession.metadata?.nativeAgentSession?.agent === 'codex'
      && finalSession.metadata.nativeAgentSession.sessionId)) {
    throw new Error(`Timed out waiting for accepted Direct Chat session ${sessionId}: native Codex session was not captured; terminal output was rejected.`);
  }
  throw new Error(`Timed out waiting for accepted Direct Chat session ${sessionId} to produce a final response.`);
}

export async function inspectAcceptedFinalResponse(
  manager: ProcessManager,
  sessionId: string,
  prompt: string,
  sourceMessageIds: string[],
  acceptedAt?: string | null,
): Promise<AcceptedFinalInspection> {
  let session = manager.getSession(sessionId);
  if (!session) return { reply: null, sessionState: 'missing' };
  const adapter = manager.getAdapter(sessionId);
  const acceptedAtMs = Date.parse(acceptedAt ?? '');
  const sentAtMs = Number.isFinite(acceptedAtMs) ? acceptedAtMs : Date.now();
  const nativeCodexMissing = session.agent === 'codex'
    && !adapter?.deliversPromptsDirectly?.()
    && !(session.metadata?.nativeAgentSession?.agent === 'codex' && session.metadata.nativeAgentSession.sessionId);
  if (nativeCodexMissing) {
    await manager.captureAgentapiCodexSessionIdFromPrompt?.(sessionId, prompt, { sentAtMs, attempts: 1, retryMs: 0 });
    session = manager.getSession(sessionId) ?? session;
  }
  let liveMessages: Array<{ role: string; content: string; createdAt: string }> = [];
  let runtimeStatus: Awaited<ReturnType<NonNullable<typeof adapter>['fetchStatus']>> | null = null;
  if (adapter) {
    [liveMessages, runtimeStatus] = await Promise.all([
      adapter.fetchMessages().catch(() => []),
      adapter.fetchStatus().catch(() => null),
    ]);
  }
  const nativeCodexReady = session.agent === 'codex'
    && session.metadata?.nativeAgentSession?.agent === 'codex'
    && Boolean(session.metadata.nativeAgentSession.sessionId);
  const authoritativeMessages = nativeCodexReady
    ? await resolveAuthoritativeSessionMessages(session, liveMessages, { requireNative: true })
    : adapter?.deliversPromptsDirectly?.() ? liveMessages : [];
  const boundaryIndex = authoritativeMessages.findLastIndex((message) => {
    if (message.role !== 'user') return false;
    if (prompt && matchesCodexPrompt(message.content, prompt)) return true;
    return sourceMessageIds.some((id) => message.content.includes(id));
  });
  // Codex records steering input as another user message inside the active turn.
  // The live waiter deliberately accepts the terminal final that follows such a
  // steer, so durable recovery must use the same boundary semantics. Cutting at
  // the next user card leaves a completed turn awaiting_reply forever after the
  // live observation window expires.
  const turnMessages = boundaryIndex < 0 ? [] : authoritativeMessages.slice(boundaryIndex + 1);
  const finalMessage = turnMessages
    .filter((message) => (message.role === 'assistant' || message.role === 'agent') && message.content.trim().length > 0)
    .at(-1);
  if (finalMessage && (nativeCodexReady || runtimeStatus === 'stable')) {
    return { reply: { content: finalMessage.content, createdAt: finalMessage.createdAt }, sessionState: 'active' };
  }
  return { reply: null, sessionState: session.status === 'running' || session.status === 'starting' ? 'active' : 'stopped' };
}

export function hasExpiredRetention(intercept: ChatInterceptStateRecord, idleRetentionMs: number): boolean {
  const lastActivityAt = Date.parse(intercept.lastActivityAt);
  if (!Number.isFinite(lastActivityAt)) {
    return false;
  }
  return Date.now() - lastActivityAt >= idleRetentionMs;
}

export async function archiveChatSession(params: {
  manager: ProcessManager;
  interceptStore: ChatInterceptStateStore;
  intercept: ChatInterceptStateRecord;
  reason: string;
}): Promise<ChatInterceptStateRecord> {
  if (params.intercept.sessionId) {
    try {
      const stopped = await params.manager.stopSession(params.intercept.sessionId);
      if (stopped) {
        scheduleSessionArchive(params.intercept.sessionId, params.manager);
        await logSession(params.manager, stopped.id, `[agent-chat] session archived (${params.reason})`);
      } else if (!params.manager.getSession(params.intercept.sessionId)) {
        scheduleSessionArchive(params.intercept.sessionId, params.manager);
      }
    } catch (error) {
      await logSession(
        params.manager,
        params.intercept.sessionId,
        `[agent-chat] archive stop failed (${params.reason}): ${error instanceof Error ? error.message : 'Unknown error.'}`,
      );
    }
  }
  return saveIntercept(params.interceptStore, params.intercept, {
    sessionId: null,
    state: 'archived',
    pendingMessageCount: 0,
    lastActivityAt: new Date().toISOString(),
  });
}

export async function archiveExpiredSessionIfNeeded(params: {
  manager: ProcessManager;
  interceptStore: ChatInterceptStateStore;
  intercept: ChatInterceptStateRecord;
  idleRetentionMs: number;
  clearIdleTimer: (routingKey: string) => void;
}): Promise<ChatInterceptStateRecord> {
  if (params.intercept.state !== 'idle' || !params.intercept.sessionId) {
    return params.intercept;
  }
  if (!hasExpiredRetention(params.intercept, params.idleRetentionMs)) {
    return params.intercept;
  }
  params.clearIdleTimer(params.intercept.routingKey);
  return await archiveChatSession({
    manager: params.manager,
    interceptStore: params.interceptStore,
    intercept: params.intercept,
    reason: 'retention-expired',
  });
}

export function resolveRecoveryState(params: {
  manager: ProcessManager;
  intercept: ChatInterceptStateRecord;
  idleRetentionMs: number;
}): Partial<ChatInterceptStateRecord> {
  const reusable = resolveReusableSession(params.manager, params.intercept, params.idleRetentionMs);
  if (reusable) {
    return {
      sessionId: reusable.id,
      state: 'idle',
      pendingMessageCount: 0,
      lastActivityAt: new Date().toISOString(),
    };
  }
  return {
    sessionId: null,
    state: hasExpiredRetention(params.intercept, params.idleRetentionMs) ? 'archived' : 'pending',
    pendingMessageCount: 0,
    lastActivityAt: new Date().toISOString(),
  };
}

export function consumePendingMessages(
  interceptStore: ChatInterceptStateStore,
  routingKey: string,
  consumedCount: number,
): number {
  const latest = interceptStore.getByRoutingKey(routingKey);
  const currentCount = latest?.pendingMessageCount ?? 0;
  return Math.max(0, currentCount - consumedCount);
}

export function saveIntercept(
  interceptStore: ChatInterceptStateStore,
  intercept: ChatInterceptStateRecord,
  patch: Partial<ChatInterceptStateRecord>,
): ChatInterceptStateRecord {
  const latest = interceptStore.getByRoutingKey(intercept.routingKey) ?? intercept;
  return interceptStore.save({
    ...latest,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

export function logSession(manager: ProcessManager, sessionId: string, entry: string): Promise<void> {
  manager.appendSessionLog(sessionId, entry);
  return Promise.resolve();
}

async function awaitAssistantReply(
  manager: ProcessManager,
  sessionId: string,
  initialMessageCount: number,
  options?: AssistantReplyWaitOptions,
): Promise<AssistantReplyResult> {
  const pollIntervalMs = Math.max(10, options?.pollIntervalMs ?? ASSISTANT_REPLY_POLL_INTERVAL_MS);
  const stablePollTarget = Math.max(1, options?.stablePolls ?? ASSISTANT_REPLY_STABLE_POLLS);
  const fallbackStablePollTarget = Math.max(
    stablePollTarget,
    options?.decisionFallbackStablePolls ?? ASSISTANT_REPLY_DECISION_FALLBACK_STABLE_POLLS,
  );
  const deadline = Date.now() + Math.max(pollIntervalMs, options?.timeoutMs ?? ASSISTANT_REPLY_TIMEOUT_MS);
  let lastSeenContent = '';
  let stablePolls = 0;
  let settledFallbackReply: AssistantReplyResult | null = null;

  while (Date.now() < deadline) {
    const session = manager.getSession(sessionId);
    const adapter = manager.getAdapter(sessionId);
    if (!adapter) {
      if (settledFallbackReply) {
        return settledFallbackReply;
      }
      throw new Error(`Session ${sessionId} no longer has an adapter.`);
    }

    let messages: Array<{ role: string; content: string; createdAt: string }>;
    try {
      messages = await adapter.fetchMessages();
    } catch {
      await sleep(pollIntervalMs);
      continue;
    }

    const assistantMessages = messages
      .slice(initialMessageCount)
      .filter((message) => (message.role === 'assistant' || message.role === 'agent') && message.content.trim().length > 0);
    const newAssistantMessage = assistantMessages[assistantMessages.length - 1];

    if (!newAssistantMessage) {
      if (!session || (session.status !== 'running' && session.status !== 'starting')) {
        throw new Error(`Session ${sessionId} stopped before producing a reply.`);
      }
      await sleep(pollIntervalMs);
      continue;
    }

    const parsedReply = parseAgentChatReply(newAssistantMessage.content);
    const hasParseableDecision = parsedReply.decision !== 'failed';
    const readyForHandoff = session?.agentRuntimeStatus === 'stable' || session?.agentRuntimeStatus == null;
    const contentUnchanged = newAssistantMessage.content === lastSeenContent;
    if (contentUnchanged) {
      stablePolls += 1;
    } else {
      lastSeenContent = newAssistantMessage.content;
      stablePolls = 1;
    }

    if (readyForHandoff && stablePolls >= stablePollTarget) {
      return {
        content: newAssistantMessage.content.trim(),
        createdAt: newAssistantMessage.createdAt,
      };
    }

    if (hasParseableDecision && stablePolls >= fallbackStablePollTarget) {
      settledFallbackReply = {
        content: newAssistantMessage.content.trim(),
        createdAt: newAssistantMessage.createdAt,
        settledWithoutStableRuntime: !readyForHandoff,
      };
      if (!session || (session.status !== 'running' && session.status !== 'starting') || !readyForHandoff) {
        return settledFallbackReply;
      }
    }

    if (!session || (session.status !== 'running' && session.status !== 'starting')) {
      if (settledFallbackReply) {
        return settledFallbackReply;
      }
      throw new Error(`Session ${sessionId} stopped before producing a reply.`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for an assistant reply from session ${sessionId}.`);
}
