import type { AgentType } from '../config';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { chatInterceptStateStore, type ChatInterceptStateStore } from './chat-intercept-state-store';
import { archiveChatSession, archiveExpiredSessionIfNeeded, consumePendingMessages, createAgentChatSession, hasExpiredRetention, logSession, resolveRecoveryState, resolveReusableSession, saveIntercept, sendPromptAndAwaitAssistantReply } from './session-runtime-session-ops';
import { buildBootstrapPrompt, buildChatCompletionGoal, buildMergedTurnPrompt } from './session-runtime-prompts';
import { parseAgentChatReply } from './session-runtime-decision';
import {
  enqueueTurn,
  FORCE_INTERRUPT_FAILURE_ENV,
  getRoutingState,
  isForcedInterruptFailure,
  isInterruptedTurnError,
  type RoutingRuntimeState,
} from './session-runtime-turns';
import type {
  AgentDefinitionRecord,
  ChatInterceptStateRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from './types';
import { handoffAgentChatReply, prepareAgentChatYokeRuntime } from './yoke-runtime';
import { AgentDirectChatRuntime, type DirectChatRuntimeInput } from './direct-chat-runtime';
import { agentDefinitionStore } from './agent-definition-store';
import { sessionArchiveStore, type SessionArchiveStore } from '../storage/session-archive-store';
import type { FlightDeckSessionTurnBridge } from './flightdeck-session-turn-bridge';
import type { AgentDirectDeliveryReconciler } from './direct-chat-delivery-reconciler';
import {
  flightDeckDispatchOutcomeStore,
  type FlightDeckDispatchOutcomeStore,
} from './flightdeck-dispatch-outcome-store';
import { isSessionWaitTimeout } from './flightdeck-dispatch-lifecycle';
import { buildFlightDeckChatSourceLabel } from './flightdeck-dispatch-metadata';
import type { DuplicateCallbackPublicationFilter } from './duplicate-callback-publication-filter';

const DEFAULT_IDLE_RETENTION_MINUTES = 60;

interface AgentChatSessionRuntimeDependencies {
  defaultAgent: AgentType;
  processManager: ProcessManager;
  interceptStore?: ChatInterceptStateStore;
  idleRetentionMinutes?: number;
  archiveStore?: Pick<SessionArchiveStore, 'getArchivedSession'>;
  turnBridge?: FlightDeckSessionTurnBridge;
  directDeliveryReconciler?: AgentDirectDeliveryReconciler;
  dispatchOutcomeStore?: FlightDeckDispatchOutcomeStore;
  publicationFilter?: DuplicateCallbackPublicationFilter;
  withBotIdentity?: <T>(
    agent: AgentDefinitionRecord,
    operation: (identity: RuntimeBotIdentity) => Promise<T>,
  ) => Promise<T>;
}

export interface AgentChatSessionRuntimeInput {
  agent: AgentDefinitionRecord;
  subscription: WorkspaceSubscriptionRecord;
  intercept: ChatInterceptStateRecord;
  botIdentity: RuntimeBotIdentity;
  chatMessage: Record<string, unknown>;
  runtimeContext?: string | null;
}

export class AgentChatSessionRuntime {
  private readonly defaultAgent: AgentType;
  private readonly manager: ProcessManager;
  private readonly interceptStore: ChatInterceptStateStore;
  private readonly idleRetentionMs: number;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly routingStates = new Map<string, RoutingRuntimeState>();
  private readonly directRuntime: AgentDirectChatRuntime;
  private readonly dispatchOutcomeStore: FlightDeckDispatchOutcomeStore;

  constructor(deps: AgentChatSessionRuntimeDependencies) {
    this.defaultAgent = deps.defaultAgent;
    this.manager = deps.processManager;
    this.interceptStore = deps.interceptStore ?? chatInterceptStateStore;
    this.idleRetentionMs = Math.max(1, deps.idleRetentionMinutes ?? DEFAULT_IDLE_RETENTION_MINUTES) * 60_000;
    this.dispatchOutcomeStore = deps.dispatchOutcomeStore ?? flightDeckDispatchOutcomeStore;
    this.directRuntime = new AgentDirectChatRuntime({ defaultAgent: this.defaultAgent, processManager: this.manager,
      agentStore: agentDefinitionStore, interceptStore: this.interceptStore,
      deliveryReconciler: deps.directDeliveryReconciler,
      withBotIdentity: deps.withBotIdentity,
      publicationFilter: deps.publicationFilter,
      dispatchOutcomeStore: this.dispatchOutcomeStore,
      getArchivedSession: (sessionId) => (deps.archiveStore ?? sessionArchiveStore).getArchivedSession(sessionId) });
    this.restorePersistedStates();
  }

  handleDirectChat(input: DirectChatRuntimeInput): Promise<{ handled: boolean; reason: string }> {
    return this.directRuntime.handle(input);
  }

  recoverDirectChat(input: DirectChatRuntimeInput, routingKey: string): { handled: boolean; reason: string } {
    return this.directRuntime.recover(input, routingKey);
  }

  hasRecoverableDirectChat(routingKey: string): boolean {
    return this.directRuntime.hasRecoverableTurn(routingKey);
  }

  waitForDirectChatIdle(): Promise<void> {
    return this.directRuntime.waitForIdle();
  }

  async handleRoutedChat(input: AgentChatSessionRuntimeInput): Promise<void> {
    let intercept = this.interceptStore.getByRoutingKey(input.intercept.routingKey) ?? input.intercept;
    intercept = await archiveExpiredSessionIfNeeded({
      manager: this.manager,
      interceptStore: this.interceptStore,
      intercept,
      idleRetentionMs: this.idleRetentionMs,
      clearIdleTimer: this.clearIdleTimer.bind(this),
    });

    const state = getRoutingState(this.routingStates, intercept.routingKey);
    state.latestInput = { ...input, intercept };
    enqueueTurn(state, input.chatMessage);

    if (intercept.state === 'blocked_auth' || intercept.state === 'blocked_decrypt') {
      state.blockedState = intercept.state;
      return;
    }

    if (state.processing) {
      await this.requestInterrupt(intercept.routingKey);
      return;
    }

    void this.runRoutingLoop(intercept.routingKey).catch(() => undefined);
  }

  markSubscriptionBlocked(subscriptionId: string, state: 'blocked_auth' | 'blocked_decrypt', reason: string): void {
    const now = new Date().toISOString();
    for (const intercept of this.interceptStore.listBySubscriptionId(subscriptionId)) {
      this.clearIdleTimer(intercept.routingKey);
      const latest = saveIntercept(this.interceptStore, intercept, {
        state,
        lastActivityAt: now,
      });
      const runtime = this.routingStates.get(intercept.routingKey);
      if (runtime) {
        runtime.blockedState = state;
      }
      if (latest.sessionId) void logSession(this.manager, latest.sessionId, `[agent-chat] ${state} (${reason})`);
    }
  }

  clearSubscriptionBlocked(subscriptionId: string, reason: string): void {
    for (const intercept of this.interceptStore.listBySubscriptionId(subscriptionId)) {
      if (intercept.state !== 'blocked_auth' && intercept.state !== 'blocked_decrypt') {
        continue;
      }

      const next = resolveRecoveryState({
        manager: this.manager,
        intercept,
        idleRetentionMs: this.idleRetentionMs,
      });
      const recovered = saveIntercept(this.interceptStore, intercept, next);
      const runtime = this.routingStates.get(intercept.routingKey);
      if (runtime) {
        runtime.blockedState = null;
      }
      if (recovered.state === 'idle') {
        this.scheduleIdleTimer(recovered);
      }
      if (recovered.sessionId) void logSession(this.manager, recovered.sessionId, `[agent-chat] recovered from blocked state (${reason})`);
      if (runtime && runtime.queuedTurns.length > 0 && !runtime.processing) {
        void this.runRoutingLoop(intercept.routingKey).catch(() => undefined);
      }
    }
  }

  private async runRoutingLoop(routingKey: string): Promise<void> {
    const runtime = getRoutingState(this.routingStates, routingKey);
    if (runtime.processing) {
      return;
    }
    runtime.processing = true;

    try {
      while (true) {
        const latestInput = runtime.latestInput;
        if (!latestInput || runtime.queuedTurns.length === 0) {
          break;
        }

        let intercept = this.interceptStore.getByRoutingKey(routingKey) ?? latestInput.intercept;
        intercept = await archiveExpiredSessionIfNeeded({
          manager: this.manager,
          interceptStore: this.interceptStore,
          intercept,
          idleRetentionMs: this.idleRetentionMs,
          clearIdleTimer: this.clearIdleTimer.bind(this),
        });
        if (intercept.state === 'blocked_auth' || intercept.state === 'blocked_decrypt') {
          runtime.blockedState = intercept.state;
          break;
        }

        let session: SessionSnapshot;
        let isNewSession = false;
        try {
          const reusable = resolveReusableSession(this.manager, intercept, this.idleRetentionMs);
          if (reusable) {
            session = reusable;
          } else {
            session = await createAgentChatSession({
              defaultAgent: this.defaultAgent,
              manager: this.manager,
              agent: latestInput.agent,
              intercept,
              subscription: latestInput.subscription,
            });
            isNewSession = true;
          }
        } catch (error) {
          saveIntercept(this.interceptStore, intercept, {
            state: 'pending',
            sessionId: null,
            lastActivityAt: new Date().toISOString(),
          });
          throw error;
        }

        const cycleTurns = runtime.queuedTurns.splice(0);
        for (const turn of cycleTurns) {
          const recordId = turn.messageId;
          if (!recordId) continue;
          this.dispatchOutcomeStore.recordSession({
            subscriptionId: latestInput.subscription.subscriptionId,
            recordId,
            agentId: latestInput.agent.agentId,
            sessionId: session.id,
            receivedAt: turn.sentAt,
            sourceLabel: buildFlightDeckChatSourceLabel({ messageBody: turn.content }),
            details: {
              routing_key: routingKey,
              channel_id: intercept.channelId,
              thread_id: intercept.threadId,
            },
          });
        }
        const promptMode = runtime.needsMergedFollowUp || cycleTurns.length > 1
          ? (intercept.state === 'interrupt_failed' ? 'interrupt_failed_follow_up' : 'interrupt_resumed')
          : null;
        runtime.currentSessionId = session.id;
        runtime.interruptRequested = false;
        runtime.needsMergedFollowUp = false;
        this.clearIdleTimer(routingKey);

        intercept = saveIntercept(this.interceptStore, intercept, {
          sessionId: session.id,
          state: 'active',
          pendingMessageCount: consumePendingMessages(this.interceptStore, routingKey, cycleTurns.length),
          lastActivityAt: new Date().toISOString(),
        });

        const yokeRuntime = await prepareAgentChatYokeRuntime({
          sessionId: session.id,
          workingDirectory: session.workingDirectory,
          subscription: latestInput.subscription,
          botIdentity: latestInput.botIdentity,
          channelId: intercept.channelId,
          threadId: intercept.threadId,
          options: {
            syncMode: isNewSession ? 'eager' : 'lazy',
          },
        });

        await logSession(
          this.manager,
          session.id,
          `[agent-chat] ${isNewSession ? 'created' : 'reused'} routing_key=${intercept.routingKey} channel=${intercept.channelId} thread=${intercept.threadId}`,
        );
        if (yokeRuntime.contextError) await logSession(this.manager, session.id, `[agent-chat] yoke context warning: ${yokeRuntime.contextError}`);

        this.manager.updateSessionMetadata(session.id, {
          goal: buildChatCompletionGoal(cycleTurns[cycleTurns.length - 1]!),
          nextAction: 'reflect',
        });

        const prompt = promptMode
          ? buildMergedTurnPrompt({
              agent: latestInput.agent,
              intercept,
              yokeStateDir: yokeRuntime.stateDir,
              contextError: yokeRuntime.contextError,
              turns: cycleTurns,
              followUpMode: promptMode,
              runtimeContext: latestInput.runtimeContext,
            })
          : buildBootstrapPrompt({
              agent: latestInput.agent,
              isNewSession,
              subscription: latestInput.subscription,
              intercept,
              session,
              yokeStateDir: yokeRuntime.stateDir,
              context: yokeRuntime.context,
              contextError: yokeRuntime.contextError,
              latestTurn: cycleTurns[cycleTurns.length - 1]!,
              runtimeContext: latestInput.runtimeContext,
            });

        try {
          const reply = await sendPromptAndAwaitAssistantReply(this.manager, session.id, prompt);
          for (const turn of cycleTurns) {
            if (!turn.messageId) continue;
            this.dispatchOutcomeStore.recordSessionRecovered({
              subscriptionId: latestInput.subscription.subscriptionId,
              recordId: turn.messageId,
              agentId: latestInput.agent.agentId,
              sessionId: session.id,
              receivedAt: turn.sentAt,
              evidence: 'final_turn',
              sourceLabel: buildFlightDeckChatSourceLabel({ messageBody: turn.content }),
              details: { routing_key: routingKey },
            });
          }
          if (reply.settledWithoutStableRuntime) {
            await logSession(
              this.manager,
              session.id,
              '[agent-chat] settling completed turn from stable assistant decision without waiting for runtime status to flip stable',
            );
          }
          const parsedReply = parseAgentChatReply(reply.content);
          if (parsedReply.decision === 'respond') {
            if (!parsedReply.replyBody) {
              intercept = saveIntercept(this.interceptStore, intercept, {
                lastDecision: 'respond',
                lastActivityAt: new Date().toISOString(),
              });
              await logSession(
                this.manager,
                session.id,
                '[agent-chat] decision=respond (agent published reply directly or declined inline handoff body)',
              );
            } else {
              const handoff = await handoffAgentChatReply({
                workingDirectory: session.workingDirectory,
                stateDir: yokeRuntime.stateDir,
                botIdentity: latestInput.botIdentity,
                channelId: intercept.channelId,
                threadId: intercept.threadId,
                body: parsedReply.replyBody,
              });
              intercept = saveIntercept(this.interceptStore, intercept, {
                lastDecision: 'respond',
                lastActivityAt: new Date().toISOString(),
              });
              await logSession(
                this.manager,
                session.id,
                `[agent-chat] reply-current status=${handoff.status} message_id=${handoff.message_id} decision=respond`,
              );
            }
          } else if (parsedReply.decision === 'ignore') {
            intercept = saveIntercept(this.interceptStore, intercept, {
              lastDecision: 'ignore',
              lastActivityAt: new Date().toISOString(),
            });
            await logSession(this.manager, session.id, '[agent-chat] decision=ignore');
          } else {
            intercept = saveIntercept(this.interceptStore, intercept, {
              lastDecision: 'failed',
              lastActivityAt: new Date().toISOString(),
            });
            for (const turn of cycleTurns) {
              if (!turn.messageId) continue;
              this.dispatchOutcomeStore.recordSessionFailure({
                subscriptionId: latestInput.subscription.subscriptionId,
                recordId: turn.messageId,
                agentId: latestInput.agent.agentId,
                receivedAt: turn.sentAt,
                error: 'Agent response did not include an Agent Chat decision.',
                sourceLabel: buildFlightDeckChatSourceLabel({ messageBody: turn.content }),
                details: { routing_key: routingKey },
              });
            }
            await logSession(this.manager, session.id, '[agent-chat] decision failed: missing AGENT_CHAT_DECISION header');
          }
        } catch (error) {
          if (isInterruptedTurnError(error)) {
            await logSession(this.manager, session.id, '[agent-chat] turn interrupted for merged follow-up');
            intercept = saveIntercept(this.interceptStore, intercept, {
              state: 'active',
              pendingMessageCount: runtime.queuedTurns.length,
              lastActivityAt: new Date().toISOString(),
            });
            continue;
          }
          intercept = saveIntercept(this.interceptStore, intercept, {
            lastDecision: 'failed',
            lastActivityAt: new Date().toISOString(),
          });
          for (const turn of cycleTurns) {
            if (!turn.messageId) continue;
            const shared = {
              subscriptionId: latestInput.subscription.subscriptionId,
              recordId: turn.messageId,
              agentId: latestInput.agent.agentId,
              receivedAt: turn.sentAt,
              sourceLabel: buildFlightDeckChatSourceLabel({ messageBody: turn.content }),
              details: { routing_key: routingKey },
            };
            const errorMessage = error instanceof Error ? error.message : 'Unknown error.';
            if (isSessionWaitTimeout(error)) {
              this.dispatchOutcomeStore.recordSessionWaitTimeout({ ...shared, sessionId: session.id, error: errorMessage });
            } else {
              this.dispatchOutcomeStore.recordSessionFailure({ ...shared, error: errorMessage });
            }
          }
          await logSession(
            this.manager,
            session.id,
            `[agent-chat] turn failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
          );
        }

        const latestIntercept = this.interceptStore.getByRoutingKey(routingKey);
        if (latestIntercept && (latestIntercept.state === 'blocked_auth' || latestIntercept.state === 'blocked_decrypt')) {
          runtime.blockedState = latestIntercept.state;
          break;
        }

        if (runtime.queuedTurns.length > 0) {
          intercept = saveIntercept(this.interceptStore, intercept, {
            state: 'active',
            pendingMessageCount: runtime.queuedTurns.length,
            lastActivityAt: new Date().toISOString(),
          });
          continue;
        }

        intercept = saveIntercept(this.interceptStore, intercept, {
          sessionId: session.id,
          state: 'idle',
          pendingMessageCount: 0,
          lastActivityAt: new Date().toISOString(),
        });
        this.scheduleIdleTimer(intercept);
      }
    } finally {
      runtime.processing = false;
      runtime.currentSessionId = null;
      runtime.interruptRequested = false;
      runtime.interruptAttemptInFlight = false;
    }
  }

  private async requestInterrupt(routingKey: string): Promise<void> {
    const runtime = this.routingStates.get(routingKey);
    const intercept = this.interceptStore.getByRoutingKey(routingKey);
    if (!runtime || !intercept || !runtime.processing || !runtime.currentSessionId) {
      return;
    }
    if (runtime.interruptRequested || runtime.interruptAttemptInFlight) {
      runtime.needsMergedFollowUp = true;
      return;
    }

    runtime.interruptRequested = true;
    runtime.interruptAttemptInFlight = true;
    runtime.needsMergedFollowUp = true;
    saveIntercept(this.interceptStore, intercept, {
      state: 'interrupting',
      pendingMessageCount: runtime.queuedTurns.length,
      lastActivityAt: new Date().toISOString(),
    });

    try {
      if (isForcedInterruptFailure()) {
        throw new Error(`Forced by ${FORCE_INTERRUPT_FAILURE_ENV}`);
      }
      const session = this.manager.getSession(runtime.currentSessionId);
      if (!session || (session.status !== 'running' && session.status !== 'starting')) {
        runtime.interruptRequested = false;
        saveIntercept(this.interceptStore, intercept, {
          state: 'active',
          pendingMessageCount: runtime.queuedTurns.length,
          lastActivityAt: new Date().toISOString(),
        });
        if (runtime.currentSessionId) await logSession(
          this.manager,
          runtime.currentSessionId,
          '[agent-chat] interrupt skipped; session is not running, queued follow-up prompt will continue on the next loop',
        );
        return;
      }
      const adapter = this.manager.getAdapter(runtime.currentSessionId);
      if (!adapter) {
        runtime.interruptRequested = false;
        saveIntercept(this.interceptStore, intercept, {
          state: 'active',
          pendingMessageCount: runtime.queuedTurns.length,
          lastActivityAt: new Date().toISOString(),
        });
        await logSession(
          this.manager,
          runtime.currentSessionId,
          '[agent-chat] interrupt skipped; no adapter available, queued follow-up prompt will continue on the next loop',
        );
        return;
      }
      const interrupted = await adapter.interruptCurrentTurn();
      if (!interrupted) {
        runtime.interruptRequested = false;
        saveIntercept(this.interceptStore, intercept, {
          state: 'active',
          pendingMessageCount: runtime.queuedTurns.length,
          lastActivityAt: new Date().toISOString(),
        });
        await logSession(
          this.manager,
          runtime.currentSessionId,
          '[agent-chat] interrupt unavailable; queued follow-up prompt will continue on the next loop',
        );
        return;
      }
      await logSession(this.manager, runtime.currentSessionId, '[agent-chat] interrupt requested');
    } catch (error) {
      runtime.interruptRequested = false;
      saveIntercept(this.interceptStore, intercept, {
        state: 'interrupt_failed',
        pendingMessageCount: runtime.queuedTurns.length,
        lastActivityAt: new Date().toISOString(),
      });
      if (runtime.currentSessionId) await logSession(
        this.manager,
        runtime.currentSessionId,
        `[agent-chat] interrupt failed; queued follow-up prompt: ${error instanceof Error ? error.message : 'Unknown error.'}`,
      );
    } finally {
      runtime.interruptAttemptInFlight = false;
    }
  }

  private restorePersistedStates(): void {
    for (const intercept of this.interceptStore.listAll()) {
      let next = intercept;
      if (intercept.state === 'active' || intercept.state === 'interrupting' || intercept.state === 'interrupt_failed') {
        next = saveIntercept(
          this.interceptStore,
          intercept,
          resolveRecoveryState({
            manager: this.manager,
            intercept,
            idleRetentionMs: this.idleRetentionMs,
          }),
        );
      }
      if (next.state === 'idle' && next.sessionId) {
        if (hasExpiredRetention(next, this.idleRetentionMs)) {
          void archiveChatSession({ manager: this.manager, interceptStore: this.interceptStore, intercept: next, reason: 'retention-expired-startup' });
          continue;
        }
        this.scheduleIdleTimer(next);
      }
    }
  }

  private scheduleIdleTimer(intercept: ChatInterceptStateRecord): void {
    if (!intercept.sessionId) {
      return;
    }
    this.clearIdleTimer(intercept.routingKey);
    const lastActivityAt = Date.parse(intercept.lastActivityAt);
    const elapsed = Number.isFinite(lastActivityAt) ? Date.now() - lastActivityAt : 0;
    const delayMs = Math.max(1_000, this.idleRetentionMs - elapsed);
    const timer = setTimeout(() => {
      this.idleTimers.delete(intercept.routingKey);
      const latest = this.interceptStore.getByRoutingKey(intercept.routingKey);
      if (!latest || latest.state !== 'idle' || !latest.sessionId) {
        return;
      }
      void archiveChatSession({ manager: this.manager, interceptStore: this.interceptStore, intercept: latest, reason: 'retention-expired' });
    }, delayMs);
    timer.unref?.();
    this.idleTimers.set(intercept.routingKey, timer);
  }

  private clearIdleTimer(routingKey: string): void {
    const timer = this.idleTimers.get(routingKey);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.idleTimers.delete(routingKey);
  }
}
