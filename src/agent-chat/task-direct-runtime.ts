import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AgentType } from '../config';
import { isAgentType } from '../agent-types';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { databaseFile } from '../storage/message-store';
import type { AgentDefinitionStore } from './agent-definition-store';
import { sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';
import {
  createFlightDeckPgTaskComment,
  fetchFlightDeckPgChannel,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgTask,
  fetchFlightDeckPgTaskComments,
  fetchFlightDeckPgWorkroomContext,
  type FlightDeckPgEvent,
} from './tower-client';
import type { AgentDefinitionRecord, RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';
import {
  buildTaskDirectRoutingKey,
  buildTaskDirectTurnId,
  normaliseTaskDirectTrigger,
  type TaskDirectTrigger,
} from './task-direct-contract';

interface TaskDirectState {
  routingKey: string;
  subscriptionId: string;
  agentId: string;
  agentNpub: string;
  taskId: string;
  sessionId: string | null;
  generation: number;
  previousSessionIds: string[];
  lastTurnId: string | null;
}

interface TaskDirectRuntimeInput {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  event: FlightDeckPgEvent;
}

interface TaskDirectRuntimeDependencies {
  defaultAgent: AgentType;
  processManager: ProcessManager;
  agentStore: AgentDefinitionStore;
  store?: TaskDirectStore;
  fetchTask?: typeof fetchFlightDeckPgTask;
  fetchComments?: typeof fetchFlightDeckPgTaskComments;
  fetchChannel?: typeof fetchFlightDeckPgChannel;
  fetchMessages?: typeof fetchFlightDeckPgChannelMessages;
  fetchWorkroomContext?: typeof fetchFlightDeckPgWorkroomContext;
  publish?: typeof createFlightDeckPgTaskComment;
  sendFinalResponse?: typeof sendPromptAndAwaitFinalResponse;
  log?: Pick<Console, 'error' | 'warn'>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export class TaskDirectStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_direct_sessions (
        routing_key TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        agent_npub TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT, generation INTEGER NOT NULL,
        previous_session_ids_json TEXT NOT NULL, last_turn_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_direct_events (
        routing_key TEXT NOT NULL, event_signature TEXT NOT NULL, event_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (routing_key, event_signature)
      );
      CREATE TABLE IF NOT EXISTS task_direct_publications (
        turn_id TEXT PRIMARY KEY, routing_key TEXT NOT NULL, task_id TEXT NOT NULL,
        published_comment_id TEXT, state TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
  }

  get(routingKey: string): TaskDirectState | null {
    const row = this.db.query('SELECT * FROM task_direct_sessions WHERE routing_key=?1').get(routingKey) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      routingKey: String(row.routing_key), subscriptionId: String(row.subscription_id),
      agentId: String(row.agent_id), agentNpub: String(row.agent_npub), taskId: String(row.task_id),
      sessionId: text(row.session_id), generation: Number(row.generation),
      previousSessionIds: JSON.parse(String(row.previous_session_ids_json || '[]')),
      lastTurnId: text(row.last_turn_id),
    };
  }

  save(state: TaskDirectState): TaskDirectState {
    this.db.query(`INSERT INTO task_direct_sessions
      (routing_key,subscription_id,agent_id,agent_npub,task_id,session_id,generation,previous_session_ids_json,last_turn_id,updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
      ON CONFLICT(routing_key) DO UPDATE SET session_id=excluded.session_id,generation=excluded.generation,
      previous_session_ids_json=excluded.previous_session_ids_json,last_turn_id=excluded.last_turn_id,updated_at=excluded.updated_at`)
      .run(state.routingKey, state.subscriptionId, state.agentId, state.agentNpub, state.taskId,
        state.sessionId, state.generation, JSON.stringify(state.previousSessionIds), state.lastTurnId, new Date().toISOString());
    return this.get(state.routingKey)!;
  }

  acceptEvent(routingKey: string, trigger: TaskDirectTrigger): boolean {
    return this.db.query(`INSERT OR IGNORE INTO task_direct_events
      (routing_key,event_signature,event_id,created_at) VALUES (?1,?2,?3,?4)`)
      .run(routingKey, trigger.eventSignature, trigger.eventId, new Date().toISOString()).changes > 0;
  }

  releaseEvents(routingKey: string, signatures: string[]): void {
    const remove = this.db.query('DELETE FROM task_direct_events WHERE routing_key=?1 AND event_signature=?2');
    this.db.transaction(() => {
      for (const signature of signatures) remove.run(routingKey, signature);
    })();
  }

  publication(turnId: string): string | null {
    const row = this.db.query('SELECT published_comment_id FROM task_direct_publications WHERE turn_id=?1 AND state=?2')
      .get(turnId, 'published') as { published_comment_id?: string } | null;
    return text(row?.published_comment_id);
  }

  savePublication(turnId: string, routingKey: string, taskId: string, commentId: string): void {
    this.db.query(`INSERT INTO task_direct_publications
      (turn_id,routing_key,task_id,published_comment_id,state,updated_at) VALUES (?1,?2,?3,?4,'published',?5)
      ON CONFLICT(turn_id) DO NOTHING`).run(turnId, routingKey, taskId, commentId, new Date().toISOString());
  }
}

export class TaskDirectRuntime {
  private readonly store: TaskDirectStore;
  private readonly queued = new Map<string, Array<{ input: TaskDirectRuntimeInput; trigger: TaskDirectTrigger }>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly log: Pick<Console, 'error' | 'warn'>;

  constructor(private readonly deps: TaskDirectRuntimeDependencies) {
    this.store = deps.store ?? new TaskDirectStore();
    this.log = deps.log ?? console;
  }

  async handle(input: TaskDirectRuntimeInput): Promise<{ handled: boolean; reason: string }> {
    const trigger = normaliseTaskDirectTrigger(input.event);
    if (!trigger || !input.subscription.workspaceId) return { handled: false, reason: 'ineligible_event' };
    const actorNpub = text(input.event.actor_npub);
    const workspaceIdentity = input.subscription.workspaceServiceNpub?.trim() || input.subscription.workspaceOwnerNpub;
    const agents = this.deps.agentStore.listByWorkspaceAndBot(workspaceIdentity, input.subscription.botNpub)
      .filter((agent) => agent.enabled
        && trigger.reasonsByAgentNpub.has(agent.botNpub)
        && actorNpub !== agent.botNpub
        && actorNpub !== input.subscription.wsKeyNpub);
    for (const agent of agents) {
      const routingKey = buildTaskDirectRoutingKey({
        towerServiceNpub: input.subscription.towerServiceNpub || input.subscription.backendBaseUrl,
        workspaceId: input.subscription.workspaceId,
        agentId: agent.botNpub,
        taskId: trigger.taskId,
      });
      if (!this.store.acceptEvent(routingKey, trigger)) continue;
      const queue = this.queued.get(routingKey) ?? [];
      queue.push({ input, trigger });
      this.queued.set(routingKey, queue);
      if (!this.running.has(routingKey)) {
        const work = this.run(routingKey, agent).finally(() => this.running.delete(routingKey));
        this.running.set(routingKey, work);
        void work.catch((error) => this.log.error('[task-direct] queued task session failed', {
          routingKey, error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return { handled: agents.length > 0, reason: agents.length > 0 ? 'task_direct_queued' : 'not_targeted' };
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.running.values());
  }

  private async run(routingKey: string, agent: AgentDefinitionRecord): Promise<void> {
    // Tower writes a description update and an assignment as separate adjacent
    // outbox rows. Let the subscription drain its current event batch before
    // snapshotting this route's queue so both reasons share one effective turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while ((this.queued.get(routingKey)?.length ?? 0) > 0) {
      const queued = this.queued.get(routingKey)!;
      this.queued.delete(routingKey);
      const latest = queued.at(-1)!;
      const triggerSignatures = queued.map((entry) => entry.trigger.eventSignature);
      const turnId = buildTaskDirectTurnId(routingKey, triggerSignatures);
      if (this.store.publication(turnId)) continue;
      try {
        const state = this.store.get(routingKey) ?? {
          routingKey, subscriptionId: latest.input.subscription.subscriptionId, agentId: agent.agentId,
          agentNpub: agent.botNpub, taskId: latest.trigger.taskId, sessionId: null,
          generation: 0, previousSessionIds: [], lastTurnId: null,
        };
        const hydrated = await this.hydrate(latest.input, latest.trigger.taskId);
        // The typed task read is the authorization gate. Do not create or reuse a
        // session until Tower confirms this bot can still see the current task.
        const session = await this.resolveSession(state, agent, latest.input.subscription);
        const prompt = this.buildPrompt({ state: this.store.get(routingKey)!, hydrated, queued });
        const reply = await (this.deps.sendFinalResponse ?? sendPromptAndAwaitFinalResponse)(
          this.deps.processManager, session.id, prompt,
        );
        const result = await (this.deps.publish ?? createFlightDeckPgTaskComment)({
          backendBaseUrl: latest.input.subscription.backendBaseUrl,
          workspaceId: latest.input.subscription.workspaceId!, taskId: latest.trigger.taskId,
          appNpub: latest.input.subscription.sourceAppNpub, botIdentity: latest.input.botIdentity,
          body: reply.content, metadata: {
            source: 'autopilot_task_session', turn_id: turnId, routing_key: routingKey,
            session_id: session.id, agent_npub: agent.botNpub,
            source_event_ids: queued.map((entry) => entry.trigger.eventId),
          },
          clientRequestId: `task-direct:${turnId}`,
        });
        const commentId = text(result.comment?.id) ?? text(result.id);
        if (!commentId) throw new Error('Task-direct publication did not return a comment id.');
        this.store.savePublication(turnId, routingKey, latest.trigger.taskId, commentId);
        this.store.save({ ...this.store.get(routingKey)!, lastTurnId: turnId });
      } catch (error) {
        this.store.releaseEvents(routingKey, triggerSignatures);
        throw error;
      }
    }
  }

  private async resolveSession(
    state: TaskDirectState,
    agent: AgentDefinitionRecord,
    subscription: WorkspaceSubscriptionRecord,
  ): Promise<SessionSnapshot> {
    const existing = state.sessionId ? this.deps.processManager.getSession(state.sessionId) : null;
    const compatible = existing?.metadata?.agentChatAgentId === agent.agentId
      && existing?.metadata?.agentChatBotNpub === agent.botNpub
      && existing.agent === (agent.directChat?.sessionAgent || this.deps.defaultAgent)
      && existing.workingDirectory === (agent.directChat?.directory || agent.workingDirectory);
    if (compatible && (existing?.status === 'running' || existing?.status === 'starting')) return existing;
    const previousSessionIds = state.sessionId
      ? [...new Set([...state.previousSessionIds, state.sessionId])]
      : state.previousSessionIds;
    const generation = state.generation + 1;
    const configuredAgent = agent.directChat?.sessionAgent;
    const sessionAgent = configuredAgent && isAgentType(configuredAgent)
      ? configuredAgent
      : this.deps.defaultAgent;
    const directory = agent.directChat?.directory || agent.workingDirectory;
    const session = await this.deps.processManager.createSession(
      sessionAgent,
      directory,
      `${agent.label || agent.agentId} Task ${state.taskId}`.slice(0, 120),
      { type: 'agent-work', id: state.taskId, label: routingKeyLabel(state.routingKey, generation) },
      undefined,
      subscription.managedByNpub ?? undefined,
      {
        AGENT: true, role: 'agent-work', bindingType: 'task', bindingId: state.taskId,
        taskIds: [state.taskId], nextAction: 'reflect', createdByNpub: subscription.managedByNpub ?? undefined,
        agentChatAgentId: agent.agentId, agentChatBotNpub: agent.botNpub,
        flightdeckWorkspaceId: subscription.workspaceId!, flightdeckAgentNpub: agent.botNpub,
        flightdeckRoutingKey: state.routingKey, sessionGeneration: generation,
      },
      agent.directChat?.model ?? undefined,
    );
    this.store.save({ ...state, sessionId: session.id, generation, previousSessionIds });
    return session;
  }

  private async hydrate(input: TaskDirectRuntimeInput, taskId: string): Promise<Record<string, unknown>> {
    const base = {
      backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId!,
      appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity,
    };
    const taskResult = await (this.deps.fetchTask ?? fetchFlightDeckPgTask)({ ...base, taskId });
    const task = object(taskResult.task);
    const commentsResult = await (this.deps.fetchComments ?? fetchFlightDeckPgTaskComments)({ ...base, taskId, limit: 200 });
    const channelId = text(task.channel_id) ?? text(input.event.channel_id);
    const threadId = text(task.thread_id);
    const [channel, threadMessages, workroom] = await Promise.all([
      channelId ? (this.deps.fetchChannel ?? fetchFlightDeckPgChannel)({ ...base, channelId }) : Promise.resolve(null),
      channelId && threadId
        ? (this.deps.fetchMessages ?? fetchFlightDeckPgChannelMessages)({ ...base, channelId, threadId, limit: 100 })
        : Promise.resolve(null),
      channelId && threadId
        ? (this.deps.fetchWorkroomContext ?? fetchFlightDeckPgWorkroomContext)({ ...base, channelId, threadId }).catch(() => null)
        : Promise.resolve(null),
    ]);
    return { task, comments: commentsResult.comments, commentsTruncated: Boolean(commentsResult.next_cursor),
      channel, associatedThread: threadMessages, workroom };
  }

  private buildPrompt(input: {
    state: TaskDirectState;
    hydrated: Record<string, unknown>;
    queued: Array<{ input: TaskDirectRuntimeInput; trigger: TaskDirectTrigger }>;
  }): string {
    const firstGeneration = input.state.generation === 1 && !input.state.lastTurnId;
    const reasons = [...new Set(input.queued.flatMap((entry) =>
      [...entry.trigger.reasonsByAgentNpub.values()].flat()))];
    return [
      firstGeneration ? 'FLIGHT DECK TASK SESSION' : 'FLIGHT DECK TASK SESSION UPDATE',
      '',
      'Your standing responsibility is to progress this Flight Deck task using its latest description, state, assignments, comments, linked context, and associated threads.',
      'Report progress, questions, blockers, and completion as task comments. Your captured final assistant turn is published once to the task.',
      'Before reasoning or acting, perform a fresh typed Flight Deck PG read of the task and comments. Do not use Yoke or retired local-sync assumptions.',
      'Continue until ordered task updates queued during a turn have been handled.',
      '',
      `Routing binding: ${input.state.routingKey}`,
      `Generation: ${input.state.generation}`,
      `Previous sessions: ${input.state.previousSessionIds.join(', ') || '-'}`,
      `Trigger reasons: ${reasons.join(', ')}`,
      'Exact latest changes:',
      json(input.queued.map((entry) => ({ event_id: entry.trigger.eventId, reasons: [...entry.trigger.reasonsByAgentNpub.values()].flat(), change: entry.trigger.latestChange }))),
      '',
      'Current typed-PG hydration (bounded comments include a truncation signal):',
      json(input.hydrated),
    ].join('\n');
  }
}

function routingKeyLabel(routingKey: string, generation: number): string {
  return `${routingKey}:generation:${generation}`;
}
