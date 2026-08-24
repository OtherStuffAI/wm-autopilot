/**
 * Prompt queue dispatch engine.
 * Extracted from server.ts to reduce file size.
 */

import type { AgentType } from "../config";
import type { SessionSnapshot } from "../agents/process-manager";
import { resolveSessionChargeNpub } from "../sessions/session-metadata";
import { deliverSessionAgentMessage } from "./session-agent-message";
import { getSessionPromptReadiness } from "./prompt-readiness";
import type { FlightDeckSessionTurnBridge } from "../agent-chat/flightdeck-session-turn-bridge";
import type { DispatchInboxWakeClaim, SessionDispatchInboxCoordinator } from "../session-dispatch/session-dispatch-inbox";

// ---------- Context supplied by server.ts ----------

export interface PromptDispatchContext {
  manager: {
    getSession: (id: string) => SessionSnapshot | undefined;
    listSessions: () => SessionSnapshot[];
    getAdapter: (id: string) => import("../agents/agent-adapter").AgentAdapter | null;
    captureAgentapiCodexSessionIdFromPrompt?: (
      id: string,
      prompt: string,
      options?: { sentAtMs?: number },
    ) => Promise<boolean>;
  };
  agentHost: string;
  messageStore: {
    listSessionMessages: (id: string) => unknown[];
  };
  isUserApprovedForWork?: (npub: string) => boolean;
  promptQueueStore: {
    getNextQueuedPrompt: (sessionId: string) => { id?: string; content: string; timestamp?: string } | null;
    removeNextPrompt: (sessionId: string) => void;
    getQueueCount: (sessionId: string) => number;
  };
  buildAgentUrl: (host: string, port: number, path: string) => string | URL;
  waitForSessionPromptReadiness: (opts: {
    getSession: (id: string) => SessionSnapshot | null;
    getAdapter: (id: string) => import("../agents/agent-adapter").AgentAdapter | null;
    sessionId: string;
    host: string;
    timeoutMs: number;
    pollIntervalMs: number;
    requiredStablePolls: number;
    requestTimeoutMs: number;
  }) => Promise<void>;
  syncSessionMessages: (sessionId: string, force?: boolean) => Promise<unknown[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeTriggerNightWatch: (session: SessionSnapshot | null, deps: any) => void | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nightWatchDeps: any;
  flightDeckTurnBridge?: FlightDeckSessionTurnBridge;
  dispatchInbox?: SessionDispatchInboxCoordinator;
}

// ---------- Custom error ----------

export class QueueDispatchError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "QueueDispatchError";
  }
}

// ---------- Engine return type ----------

export interface PromptDispatchEngine {
  dispatchNextQueuedPromptForSession: (session: SessionSnapshot, userNpub: string | null) => Promise<{
    id: string;
    messages: unknown[];
    sentPrompt: { content: string };
  }>;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => Promise<void>;
  reconcileNextTurn: (session: SessionSnapshot | null) => Promise<void>;
  sweepQueuedSessionsForDispatch: () => void;
  markPromptStartupReady: (sessionId: string) => void;
  clearPromptStartupReady: (sessionId: string) => void;
  markQueueDispatchCooldown: (sessionId: string, retryAfterMs?: number) => void;
  queueDispatchInFlight: Set<string>;
  waitForMessageUpdate: (sessionId: string, initialCount: number, timeoutMs?: number) => Promise<unknown[]>;
}

// ---------- Factory ----------

const QUEUE_DISPATCH_RETRY_MS = 5000;
const QUEUE_DISPATCH_TIMING_LOG_THRESHOLD_MS = 750;
const QUEUE_DEFERRED_LOG_INTERVAL_MS = 30000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function elapsedSince(startedAt: number): number {
  return Date.now() - startedAt;
}

function logQueueDispatchTiming(params: {
  sessionId: string;
  agent: AgentType;
  status: "sent" | "failed";
  totalMs: number;
  readinessMs: number;
  deliveryMs: number;
  messageSyncMs: number;
  errorStatus?: number;
}): void {
  if (params.totalMs < QUEUE_DISPATCH_TIMING_LOG_THRESHOLD_MS && params.status === "sent") {
    return;
  }
  const message =
    `[queue] dispatch ${params.status} session=${params.sessionId} agent=${params.agent}`
    + ` total=${params.totalMs}ms readiness=${params.readinessMs}ms`
    + ` delivery=${params.deliveryMs}ms`
    + ` messageSync=${params.messageSyncMs}ms`
    + (params.errorStatus ? ` status=${params.errorStatus}` : "");
  if (params.status === "sent") {
    console.info(message);
  } else {
    console.warn(message);
  }
}

export function createPromptDispatchEngine(ctx: PromptDispatchContext): PromptDispatchEngine {
  const queueDispatchInFlight = new Set<string>();
  const queueDispatchCooldowns = new Map<string, number>();
  const promptStartupReadiness = new Set<string>();
  const lastDeferredLog = new Map<string, { key: string; loggedAt: number }>();

  function logDeferredReadiness(sessionId: string, state: string, reason: string, retryAfterMs: number): void {
    const now = Date.now();
    const key = `${state}:${reason}`;
    const previous = lastDeferredLog.get(sessionId);
    if (previous?.key === key && now - previous.loggedAt < QUEUE_DEFERRED_LOG_INTERVAL_MS) return;
    lastDeferredLog.set(sessionId, { key, loggedAt: now });
    console.info(
      `[queue] deferred session=${sessionId} readiness=${state}`
      + ` reason=${reason} retry=${retryAfterMs}ms`,
    );
  }

  function markPromptStartupReady(sessionId: string): void {
    promptStartupReadiness.add(sessionId);
  }

  function clearPromptStartupReady(sessionId: string): void {
    promptStartupReadiness.delete(sessionId);
  }

  function getQueueDispatchCooldown(sessionId: string): number {
    return queueDispatchCooldowns.get(sessionId) ?? 0;
  }

  function clearQueueDispatchCooldown(sessionId: string): void {
    queueDispatchCooldowns.delete(sessionId);
  }

  function markQueueDispatchCooldown(sessionId: string, retryAfterMs = QUEUE_DISPATCH_RETRY_MS): void {
    queueDispatchCooldowns.set(sessionId, Date.now() + Math.max(retryAfterMs, 250));
  }

  function shouldAutoDispatchSession(session: SessionSnapshot | null): boolean {
    if (!session) return false;
    return session.status === "running";
  }

  function getPromptStartupTimeoutMs(agent: AgentType): number {
    return agent === "codex" ? 120000 : 60000;
  }

  async function waitForMessageUpdate(sessionId: string, initialCount: number, timeoutMs = 20000): Promise<unknown[]> {
    let messages = await ctx.syncSessionMessages(sessionId, true);
    if (messages.length > initialCount) {
      return messages;
    }

    const deadline = Date.now() + Math.max(timeoutMs, 1000);
    while (Date.now() < deadline) {
      await sleep(250);
      messages = await ctx.syncSessionMessages(sessionId, true);
      if (messages.length > initialCount) {
        return messages;
      }
    }
    return messages;
  }

  async function ensureSessionReadyForPromptDispatch(session: SessionSnapshot): Promise<void> {
    const timeoutMs = getPromptStartupTimeoutMs(session.agent);
    await ctx.waitForSessionPromptReadiness({
      getSession: (sessionId) => ctx.manager.getSession(sessionId) ?? null,
      getAdapter: (sessionId) => ctx.manager.getAdapter(sessionId),
      sessionId: session.id,
      host: ctx.agentHost,
      timeoutMs,
      pollIntervalMs: 250,
      requiredStablePolls: session.agent === "codex" ? 3 : 2,
      requestTimeoutMs: 750,
    });
    markPromptStartupReady(session.id);
  }

  async function deliverAcceptedPrompt(input: {
    session: SessionSnapshot;
    content: string;
    promptType: string;
    boundaryIdentity: string;
    acceptedAt?: string;
    onAccepted?: () => void;
  }): Promise<{ messages: unknown[]; deliveryMs: number; messageSyncMs: number; turnObserved: boolean }> {
    const initialCount = ctx.messageStore.listSessionMessages(input.session.id).length;
    const deliveryStartedAt = Date.now();
    const sentAtMs = Date.now();
    const result = await deliverSessionAgentMessage({
      agentHost: ctx.agentHost,
      buildAgentUrl: ctx.buildAgentUrl,
      agent: input.session.agent,
      port: input.session.port,
      content: input.content,
      type: "user",
      pm2Name: input.session.pm2Name,
      adapter: ctx.manager.getAdapter(input.session.id),
    });
    const deliveryMs = elapsedSince(deliveryStartedAt);
    if (!result.ok) throw new QueueDispatchError(result.message, result.status);

    input.onAccepted?.();
    void ctx.manager.captureAgentapiCodexSessionIdFromPrompt?.(input.session.id, input.content, { sentAtMs });
    const flightDeckTurn = ctx.flightDeckTurnBridge?.accept({ session: input.session, prompt: input.content,
      promptType: input.promptType, boundaryIdentity: input.boundaryIdentity, acceptedAt: input.acceptedAt });
    if (flightDeckTurn) ctx.flightDeckTurnBridge?.observe(flightDeckTurn);
    const messageSyncStartedAt = Date.now();
    const messages = await waitForMessageUpdate(input.session.id, initialCount);
    return { messages, deliveryMs, messageSyncMs: elapsedSince(messageSyncStartedAt),
      turnObserved: messages.length > initialCount };
  }

  async function dispatchNextQueuedPromptForSession(session: SessionSnapshot, userNpub: string | null) {
    const dispatchStartedAt = Date.now();
    let readinessMs = 0;
    let deliveryMs = 0;
    let messageSyncMs = 0;

    if (!userNpub) {
      throw new QueueDispatchError("Sign in to send messages", 403);
    }
    if (ctx.isUserApprovedForWork && !ctx.isUserApprovedForWork(userNpub)) {
      throw new QueueDispatchError("User is not approved to use Wingman", 403, {
        approvalRequired: true,
      });
    }

    try {
      const readinessStartedAt = Date.now();
      await ensureSessionReadyForPromptDispatch(session);
      readinessMs = elapsedSince(readinessStartedAt);
    } catch (error) {
      throw new QueueDispatchError(
        `Session is not ready for prompt dispatch: ${(error as Error).message}`,
        503,
      );
    }

    const nextPrompt = ctx.promptQueueStore.getNextQueuedPrompt(session.id);
    if (!nextPrompt) {
      throw new QueueDispatchError("No prompts in queue", 404);
    }

    try {
      const delivered = await deliverAcceptedPrompt({ session, content: nextPrompt.content,
        promptType: "queued_prompt",
        boundaryIdentity: nextPrompt.id ?? `${nextPrompt.timestamp ?? dispatchStartedAt}:${nextPrompt.content}`,
        acceptedAt: nextPrompt.timestamp,
        onAccepted: () => ctx.promptQueueStore.removeNextPrompt(session.id) });
      deliveryMs = delivered.deliveryMs;
      messageSyncMs = delivered.messageSyncMs;
      clearQueueDispatchCooldown(session.id);
      logQueueDispatchTiming({
        sessionId: session.id,
        agent: session.agent,
        status: "sent",
        totalMs: elapsedSince(dispatchStartedAt),
        readinessMs,
        deliveryMs,
        messageSyncMs,
      });
      return { id: session.id, messages: delivered.messages, sentPrompt: nextPrompt };
    } catch (error) {
      if (error instanceof QueueDispatchError) {
        error.payload = { failedPrompt: nextPrompt, ...error.payload };
        logQueueDispatchTiming({
          sessionId: session.id,
          agent: session.agent,
          status: "failed",
          totalMs: elapsedSince(dispatchStartedAt),
          readinessMs,
          deliveryMs,
          messageSyncMs,
          errorStatus: error.status,
        });
        throw error;
      }
      logQueueDispatchTiming({
        sessionId: session.id,
        agent: session.agent,
        status: "failed",
        totalMs: elapsedSince(dispatchStartedAt),
        readinessMs,
        deliveryMs,
        messageSyncMs,
        errorStatus: 502,
      });
      throw new QueueDispatchError(`Failed to contact agent: ${(error as Error).message}`, 502, {
        failedPrompt: nextPrompt,
      });
    }
  }

  async function dispatchInboxWake(session: SessionSnapshot, claim: DispatchInboxWakeClaim): Promise<void> {
    const dispatchStartedAt = Date.now();
    let readinessMs = 0;
    let deliveryMs = 0;
    let messageSyncMs = 0;
    try {
      const readinessStartedAt = Date.now();
      await ensureSessionReadyForPromptDispatch(session);
      readinessMs = elapsedSince(readinessStartedAt);
      const delivered = await deliverAcceptedPrompt({ session, content: claim.prompt,
        promptType: "dispatch_inbox_wake",
        boundaryIdentity: `${claim.inboxFingerprint}:${claim.attemptCount}`,
        onAccepted: () => ctx.dispatchInbox?.markSubmitted(claim) });
      // A synced message proves the accepted wake reached the session even when
      // a very fast turn skips a separately observable runtime=running event.
      // Record that boundary before releasing the in-flight arbitration lock so
      // the next stable reconciliation can evaluate progress without waiting
      // for the full submission lease to expire.
      if (delivered.turnObserved) ctx.dispatchInbox?.noteSessionBusy(session.id);
      deliveryMs = delivered.deliveryMs;
      messageSyncMs = delivered.messageSyncMs;
      clearQueueDispatchCooldown(session.id);
      logQueueDispatchTiming({ sessionId: session.id, agent: session.agent, status: "sent",
        totalMs: elapsedSince(dispatchStartedAt), readinessMs, deliveryMs, messageSyncMs });
    } catch (error) {
      ctx.dispatchInbox?.markSubmissionFailed(claim, error instanceof Error ? error.message : String(error));
      logQueueDispatchTiming({ sessionId: session.id, agent: session.agent, status: "failed",
        totalMs: elapsedSince(dispatchStartedAt), readinessMs, deliveryMs, messageSyncMs,
        errorStatus: error instanceof QueueDispatchError ? error.status : 502 });
      throw error;
    }
  }

  async function maybeAutoDispatchQueuedPrompt(session: SessionSnapshot | null) {
    if (!session) return;
    if (queueDispatchInFlight.has(session.id)) {
      if (session.agentRuntimeStatus === "running") ctx.dispatchInbox?.noteSessionBusy(session.id);
      return;
    }
    if (!shouldAutoDispatchSession(session)) return;
    const queuedPromptCount = ctx.promptQueueStore.getQueueCount(session.id);
    const hasCallbacks = ctx.dispatchInbox?.hasUnresolved(session.id) ?? false;
    if (queuedPromptCount === 0 && !hasCallbacks) {
      if (session.agentRuntimeStatus === "stable") {
        void ctx.maybeTriggerNightWatch(session, ctx.nightWatchDeps);
      }
      return;
    }
    const userNpub = resolveSessionChargeNpub(session.metadata, session.npub ?? null);
    if (!userNpub) {
      console.warn(`[queue] cannot auto-dispatch session ${session.id} without owner npub`);
      return;
    }
    const cooldownUntil = getQueueDispatchCooldown(session.id);
    if (cooldownUntil && cooldownUntil > Date.now()) {
      return;
    }

    queueDispatchInFlight.add(session.id);
    try {
      const readiness = await getSessionPromptReadiness({
        session,
        adapter: ctx.manager.getAdapter(session.id),
        timeoutMs: 750,
      });
      if (readiness.state !== "ready") {
        if (readiness.state === "busy") ctx.dispatchInbox?.noteSessionBusy(session.id);
        markQueueDispatchCooldown(session.id, readiness.retryAfterMs);
        logDeferredReadiness(session.id, readiness.state, readiness.reason, readiness.retryAfterMs);
        return;
      }

      if (queuedPromptCount > 0) {
        await dispatchNextQueuedPromptForSession(session, userNpub);
      } else {
        if (hasCallbacks && session.agentRuntimeStatus !== "stable") {
          ctx.dispatchInbox?.noteSessionBusy(session.id);
          return;
        }
        const claim = ctx.dispatchInbox?.claimForStableSession(session.id) ?? null;
        if (claim) await dispatchInboxWake(session, claim);
        else if (!hasCallbacks) void ctx.maybeTriggerNightWatch(session, ctx.nightWatchDeps);
      }
    } catch (error) {
      if (error instanceof QueueDispatchError) {
        if (error.status === 404) {
          clearQueueDispatchCooldown(session.id);
        } else {
          markQueueDispatchCooldown(session.id);
          console.warn(`[queue] auto-dispatch failed for session ${session.id}: ${error.message}`);
        }
      } else {
        markQueueDispatchCooldown(session.id);
        console.error(`[queue] auto-dispatch failed for session ${session.id}:`, error);
      }
    } finally {
      queueDispatchInFlight.delete(session.id);
    }
  }

  function sweepQueuedSessionsForDispatch() {
    for (const session of ctx.manager.listSessions()) {
      void maybeAutoDispatchQueuedPrompt(session);
    }
  }

  // Auto-start sweep on creation
  sweepQueuedSessionsForDispatch();
  setInterval(sweepQueuedSessionsForDispatch, 5000).unref?.();

  return {
    dispatchNextQueuedPromptForSession,
    maybeAutoDispatchQueuedPrompt,
    reconcileNextTurn: maybeAutoDispatchQueuedPrompt,
    sweepQueuedSessionsForDispatch,
    markPromptStartupReady,
    clearPromptStartupReady,
    markQueueDispatchCooldown,
    queueDispatchInFlight,
    waitForMessageUpdate,
  };
}
