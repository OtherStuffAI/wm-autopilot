import type { ProcessManager } from '../agents/process-manager';
import { resolveAuthoritativeSessionMessages } from '../agents/authoritative-session-messages';
import { matchesCodexPrompt } from '../agents/codex-session-discovery';
import { waitForSessionPromptReadiness } from '../server/session-readiness';
import type { AssistantReplyResult, AssistantReplyWaitOptions } from './session-runtime-session-ops';

const SESSION_READY_TIMEOUT_MS = 120_000;
const ASSISTANT_REPLY_TIMEOUT_MS = 300_000;
const ASSISTANT_REPLY_POLL_INTERVAL_MS = 250;
const NATIVE_SESSION_DISCOVERY_RETRY_MS = 1_000;

export const DIRECT_CHAT_SUBMISSION_LEASE_MS = SESSION_READY_TIMEOUT_MS + ASSISTANT_REPLY_TIMEOUT_MS + 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AcceptedFinalInspection {
  reply: AssistantReplyResult | null;
  sessionState: 'active' | 'stopped' | 'missing';
  promptBoundary?: 'observed' | 'missing' | 'unavailable';
  runtimeStable?: boolean;
}

export class PromptBoundaryNotObservedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} remained stable without exposing the submitted prompt boundary.`);
    this.name = 'PromptBoundaryNotObservedError';
  }
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
  const usesNativeTranscript = initialSession?.agent === 'codex' && !adapter.deliversPromptsDirectly?.();
  const initialAuthoritativeMessages = usesNativeTranscript && initialNativeSessionId
    ? await resolveAuthoritativeSessionMessages(initialSession, initialMessages, { requireNative: true }).catch(() => [])
    : initialMessages;
  const sentAtMs = Date.now();
  await adapter.sendMessage(prompt, 'user');
  await manager.captureAgentapiCodexSessionIdFromPrompt?.(sessionId, prompt, { sentAtMs, attempts: 1, retryMs: 0 });

  const pollIntervalMs = Math.max(10, waitOptions?.pollIntervalMs ?? ASSISTANT_REPLY_POLL_INTERVAL_MS);
  const transcriptRefreshIntervalMs = waitOptions?.pollIntervalMs === undefined ? 400 : pollIntervalMs;
  const deadline = Date.now() + Math.max(pollIntervalMs, waitOptions?.timeoutMs ?? ASSISTANT_REPLY_TIMEOUT_MS);
  const promptBoundaryDeadline = Date.now() + Math.max(pollIntervalMs, waitOptions?.promptBoundaryTimeoutMs ?? 15_000);
  let nextNativeDiscoveryAt = Date.now() + NATIVE_SESSION_DISCOVERY_RETRY_MS;
  let observedActiveRuntime = false;
  let accepted = false;
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
    const promptBoundaryFloor = !usesNativeTranscript || (initialNativeSessionId && currentNativeSessionId === initialNativeSessionId)
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
    // A successful transport write is not evidence that the agent received it.
    // In particular, a resumed Codex goal may run without consuming this input.
    if (promptIndex >= 0 && !accepted) {
      accepted = true;
      await waitOptions?.onAccepted?.();
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
  return {
    reply: null,
    sessionState: session.status === 'running' || session.status === 'starting' ? 'active' : 'stopped',
    promptBoundary: boundaryIndex >= 0 ? 'observed' : authoritativeMessages.length > 0 ? 'missing' : 'unavailable',
    runtimeStable: runtimeStatus === 'stable',
  };
}

