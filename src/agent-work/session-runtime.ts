import { dirname } from 'node:path';

import type { AgentType } from '../config';
import type { SessionOrigin, SessionSnapshot } from '../agents/process-manager';
import type { SessionMetadataInput } from '../sessions/session-metadata';
import type {
  AgentDefinitionRecord,
  InboundApprovalRecord,
  InboundCommentRecord,
  InboundTaskRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from '../agent-chat/types';
import { nip19 } from 'nostr-tools';
import {
  agentWorkSessionBindingStore,
  type AgentWorkBindingType,
  type AgentWorkSessionBindingRecord,
  AgentWorkSessionBindingStore,
} from './session-binding-store';
import {
  buildAgentWorkGoal,
  buildTaskCommentDispatchPrompt,
  buildTaskDispatchPrompt,
} from './prompts';
import {
  buildAgentTaskCommentYokeCommands,
  prepareAgentWorkspaceYokeRuntime,
  type AgentWorkspaceYokeRuntime,
} from '../agent-chat/yoke-runtime';
import { expandHomeDirectory } from '../server/path-utils';

type DispatchReason = 'new task' | 'task updated';
export type AgentWorkTaskDispatchDecisionCode =
  | 'dispatch'
  | 'skip_terminal'
  | 'skip_assignment'
  | 'skip_not_ready';

export interface AgentWorkRuntimeDependencies {
  defaultAgent: AgentType;
  bindingStore?: AgentWorkSessionBindingStore;
  getSession: (sessionId: string) => SessionSnapshot | null;
  createSession: (
    agent: AgentType,
    workingDirectory: string,
    name: string,
    origin: SessionOrigin,
    explicitNpub?: string,
    metadata?: SessionMetadataInput,
  ) => Promise<SessionSnapshot>;
  updateSessionMetadata: (sessionId: string, metadata: SessionMetadataInput) => SessionSnapshot | null;
  addPrompt: (sessionId: string, content: string) => unknown;
  hasQueuedPrompt?: (sessionId: string, content: string) => boolean;
  hasQueuedTaskDispatchPrompt?: (sessionId: string, taskId: string) => boolean;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => void | Promise<void>;
  enableNightWatch: (sessionId: string) => unknown;
  prepareWorkspaceYokeRuntime?: (params: {
    sessionId: string;
    workingDirectory: string;
    subscription: WorkspaceSubscriptionRecord;
    botIdentity: RuntimeBotIdentity;
  }) => Promise<AgentWorkspaceYokeRuntime>;
}

export interface AgentWorkTaskDispatchInput {
  subscription: WorkspaceSubscriptionRecord;
  agent: AgentDefinitionRecord;
  recordId: string;
  recordState: string | null;
  task: InboundTaskRecord;
  runtimeContext?: string | null;
}

export interface AgentWorkTaskCommentDispatchInput {
  subscription: WorkspaceSubscriptionRecord;
  agent: AgentDefinitionRecord;
  recordId: string;
  comment: InboundCommentRecord;
  botIdentity: RuntimeBotIdentity;
  runtimeContext?: string | null;
}

const TERMINAL_TASK_STATES = new Set([
  'done',
  'completed',
  'cancelled',
  'canceled',
  'archived',
  'deleted',
  'rejected',
]);

function compactText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => compactText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function compactRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactStringArrayFromMixed(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        return compactText(entry);
      }
      const record = compactRecord(entry);
      if (!record) {
        return null;
      }
      return compactText(record.task_id)
        ?? compactText(record.taskId)
        ?? compactText(record.id);
    })
    .filter((entry): entry is string => Boolean(entry));
}

function compactBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function pickFirstText(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = compactText(payload[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function pickFirstBoolean(payload: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (compactBoolean(payload[key])) {
      return true;
    }
  }
  return false;
}

function pickFirstStringArray(payload: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const values = compactStringArrayFromMixed(payload[key]);
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

function candidatePayloads(payload: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const directData = compactRecord(payload.data);
  if (directData) {
    candidates.push({ ...payload, ...directData });
    candidates.push(directData);
  }
  candidates.push(payload);
  for (const key of ['task', 'approval', 'payload', 'record', 'content']) {
    const nested = compactRecord(payload[key]);
    if (nested) {
      const nestedData = compactRecord(nested.data);
      if (nestedData) {
        candidates.push({ ...nested, ...nestedData });
        candidates.push(nestedData);
      }
      candidates.push(nested);
    }
  }
  return candidates;
}

function normaliseIdentityValue(value: string | null): string | null {
  const compact = compactText(value);
  return compact ? compact.toLowerCase() : null;
}

function decodeNpubToHex(npub: string | null): string | null {
  const compact = compactText(npub);
  if (!compact || !compact.startsWith('npub1')) {
    return null;
  }
  try {
    const decoded = nip19.decode(compact);
    return decoded.type === 'npub' && typeof decoded.data === 'string'
      ? decoded.data.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function buildSessionName(
  agent: AgentDefinitionRecord,
  task: InboundTaskRecord,
  mode: 'task_dispatch' = 'task_dispatch',
): string {
  const title = compactText(task.title) ?? task.taskId;
  const prefix = 'Work';
  return `${agent.label || agent.agentId} ${prefix} ${title}`.slice(0, 120);
}

function buildSessionOrigin(
  agent: AgentDefinitionRecord,
  task: InboundTaskRecord,
  mode: 'task_dispatch' = 'task_dispatch',
): SessionOrigin {
  return {
    type: 'agent-work',
    id: task.flowRunId ?? task.taskId,
    label: `${agent.agentId}:${mode}:${task.taskId}`,
  };
}

function normalisePathCandidate(value: string | null | undefined): string | null {
  const compact = compactText(value);
  if (!compact) {
    return null;
  }
  const withoutLineSuffix = compact.replace(/:(\d+)(?::\d+)?$/, '');
  const cleaned = withoutLineSuffix
    .replace(/^[<('"`]+/, '')
    .replace(/[>)"'`,;:.]+$/, '');
  if (!cleaned) {
    return null;
  }
  const homeRelative = cleaned.replace(/^[Cc]ode\//, 'code/');
  const candidate = /^[Cc]ode\//.test(cleaned)
    ? `~/${homeRelative}`
    : cleaned;
  const expanded = expandHomeDirectory(candidate);
  return expanded.startsWith('/') ? expanded : null;
}

function pathCandidateToWorkingDirectory(candidate: string): string {
  if (candidate.endsWith('/docs')) {
    return dirname(candidate);
  }
  const docsIndex = candidate.indexOf('/docs/');
  if (docsIndex >= 0) {
    return candidate.slice(0, docsIndex);
  }
  if (/\.[a-z0-9]+$/i.test(candidate)) {
    return dirname(candidate);
  }
  return candidate;
}

function extractWorkingDirectoryFromText(value: string | null | undefined): string | null {
  const compact = compactText(value);
  if (!compact) {
    return null;
  }
  const labelledMatches = Array.from(
    compact.matchAll(/(?:^|\n)\s*(?:working directory|repo root|directory override|primary workdir|project directory|repo)\s*:\s*([^\n]+)/gi),
  );
  for (const match of labelledMatches) {
    const candidate = normalisePathCandidate(match[1]);
    if (candidate) {
      return pathCandidateToWorkingDirectory(candidate);
    }
  }
  const pathMatches = compact.match(/(?:~\/|\/Users\/|\/home\/|[Cc]ode\/)[^\s<>"'`),;]+/g) ?? [];
  for (const match of pathMatches) {
    const candidate = normalisePathCandidate(match);
    if (candidate) {
      return pathCandidateToWorkingDirectory(candidate);
    }
  }
  return null;
}

function resolveDispatchWorkingDirectory(task: InboundTaskRecord | null | undefined, agent: AgentDefinitionRecord): string {
  return extractWorkingDirectoryFromText(task?.description)
    ?? extractWorkingDirectoryFromText(task?.title)
    ?? agent.workingDirectory;
}

function isLiveSession(session: SessionSnapshot | null): session is SessionSnapshot {
  if (!session) {
    return false;
  }
  return session.status === 'running' || session.status === 'starting';
}

function mergeTaskIds(session: SessionSnapshot | null, taskId: string): string[] {
  const existing = Array.isArray(session?.metadata?.taskIds) ? session.metadata.taskIds : [];
  return uniqueStrings([...existing, taskId]);
}

function isAssignedToAgent(task: InboundTaskRecord, agent: AgentDefinitionRecord): boolean {
  const assignedTo = normaliseIdentityValue(task.assignedTo);
  if (!assignedTo) {
    return false;
  }
  const botNpub = normaliseIdentityValue(agent.botNpub);
  const botPubkeyHex = decodeNpubToHex(agent.botNpub);
  return assignedTo === botNpub || assignedTo === botPubkeyHex;
}

function isTerminalTask(task: InboundTaskRecord, recordState: string | null): boolean {
  if (recordState === 'deleted' || task.deleted || task.done) {
    return true;
  }
  return Boolean(task.state && TERMINAL_TASK_STATES.has(task.state));
}

function isReadyTask(task: InboundTaskRecord): boolean {
  return task.state === 'ready';
}

export function evaluateTaskDispatchEligibility(params: {
  task: InboundTaskRecord;
  recordState: string | null;
  agent: AgentDefinitionRecord;
}): AgentWorkTaskDispatchDecisionCode {
  if (isTerminalTask(params.task, params.recordState)) {
    return 'skip_terminal';
  }
  if (!isAssignedToAgent(params.task, params.agent)) {
    return 'skip_assignment';
  }
  if (!isReadyTask(params.task)) {
    return 'skip_not_ready';
  }
  return 'dispatch';
}

function resolveTaskDispatchReason(
  taskBinding: AgentWorkSessionBindingRecord | null,
): DispatchReason {
  return taskBinding ? 'task updated' : 'new task';
}

function buildMetadataPatch(params: {
  session: SessionSnapshot | null;
  task: InboundTaskRecord;
  bindingType: AgentWorkBindingType;
  bindingId: string;
  managedByNpub: string | null;
}): SessionMetadataInput {
  return {
    AGENT: true,
    role: 'agent-work',
    goal: buildAgentWorkGoal(params.task),
    nextAction: 'reflect',
    bindingType: params.bindingType,
    bindingId: params.bindingId,
    flowId: params.task.flowId ?? undefined,
    flowRunId: params.task.flowRunId ?? undefined,
    taskIds: mergeTaskIds(params.session, params.task.taskId),
    createdByNpub: params.session?.metadata?.createdByNpub ?? params.managedByNpub ?? undefined,
    lastManagedByNpub: params.managedByNpub ?? undefined,
    chargeToNpub: params.session?.metadata?.chargeToNpub ?? params.managedByNpub ?? undefined,
  };
}

export function normaliseInboundTaskRecord(payload: Record<string, unknown>): InboundTaskRecord | null {
  for (const candidate of candidatePayloads(payload)) {
    const taskId = pickFirstText(candidate, ['task_id', 'taskId', 'record_id', 'id']);
    if (!taskId) {
      continue;
    }
    return {
      taskId,
      flowId: pickFirstText(candidate, ['flow_id', 'flowId']),
      flowRunId: pickFirstText(candidate, ['flow_run_id', 'flowRunId']),
      flowStep: pickFirstText(candidate, ['flow_step', 'flowStep']),
      scopeId: pickFirstText(candidate, ['scope_id', 'scopeId']),
      scopeL1Id: pickFirstText(candidate, ['scope_l1_id', 'scopeL1Id']),
      scopeL2Id: pickFirstText(candidate, ['scope_l2_id', 'scopeL2Id']),
      scopeL3Id: pickFirstText(candidate, ['scope_l3_id', 'scopeL3Id']),
      scopeL4Id: pickFirstText(candidate, ['scope_l4_id', 'scopeL4Id']),
      scopeL5Id: pickFirstText(candidate, ['scope_l5_id', 'scopeL5Id']),
      title: pickFirstText(candidate, ['title', 'name']) ?? taskId,
      description: pickFirstText(candidate, ['description', 'details', 'body']),
      state: pickFirstText(candidate, ['state', 'status'])?.toLowerCase() ?? null,
      // Mirror the Yoke inboundTask translator field names first.
      assignedTo: pickFirstText(candidate, ['assigned_to_npub', 'assigned_to', 'assignedTo', 'assignee', 'assignee_npub']),
      deleted: pickFirstBoolean(candidate, ['deleted', 'is_deleted', 'isDeleted']),
      done: pickFirstBoolean(candidate, ['done', 'is_done', 'isDone', 'completed', 'complete']),
      predecessorTaskIds: pickFirstStringArray(candidate, [
        'predecessor_task_ids',
        'predecessorTaskIds',
        'depends_on_task_ids',
        'dependsOnTaskIds',
        'predecessors',
      ]),
    };
  }
  return null;
}

export function normaliseInboundApprovalRecord(payload: Record<string, unknown>): InboundApprovalRecord | null {
  for (const candidate of candidatePayloads(payload)) {
    const flowRunId = pickFirstText(candidate, ['flow_run_id', 'flowRunId']);
    if (!flowRunId) {
      continue;
    }
    return {
      approvalId: pickFirstText(candidate, ['approval_id', 'approvalId', 'record_id', 'id']),
      flowId: pickFirstText(candidate, ['flow_id', 'flowId']),
      flowRunId,
      flowStep: pickFirstText(candidate, ['flow_step', 'flowStep']),
      // Yoke inboundApproval exposes status rather than state.
      state: pickFirstText(candidate, ['status', 'state']),
    };
  }
  return null;
}

export class AgentWorkSessionRuntime {
  private readonly defaultAgent: AgentType;
  private readonly bindingStore: AgentWorkSessionBindingStore;
  private readonly getSession: AgentWorkRuntimeDependencies['getSession'];
  private readonly createSession: AgentWorkRuntimeDependencies['createSession'];
  private readonly updateSessionMetadata: AgentWorkRuntimeDependencies['updateSessionMetadata'];
  private readonly addPrompt: AgentWorkRuntimeDependencies['addPrompt'];
  private readonly hasQueuedPrompt: AgentWorkRuntimeDependencies['hasQueuedPrompt'];
  private readonly hasQueuedTaskDispatchPrompt: AgentWorkRuntimeDependencies['hasQueuedTaskDispatchPrompt'];
  private readonly maybeAutoDispatchQueuedPrompt: AgentWorkRuntimeDependencies['maybeAutoDispatchQueuedPrompt'];
  private readonly enableNightWatch: AgentWorkRuntimeDependencies['enableNightWatch'];
  private readonly prepareWorkspaceYokeRuntime: NonNullable<AgentWorkRuntimeDependencies['prepareWorkspaceYokeRuntime']>;

  constructor(deps: AgentWorkRuntimeDependencies) {
    this.defaultAgent = deps.defaultAgent;
    this.bindingStore = deps.bindingStore ?? agentWorkSessionBindingStore;
    this.getSession = deps.getSession;
    this.createSession = deps.createSession;
    this.updateSessionMetadata = deps.updateSessionMetadata;
    this.addPrompt = deps.addPrompt;
    this.hasQueuedPrompt = deps.hasQueuedPrompt;
    this.hasQueuedTaskDispatchPrompt = deps.hasQueuedTaskDispatchPrompt;
    this.maybeAutoDispatchQueuedPrompt = deps.maybeAutoDispatchQueuedPrompt;
    this.enableNightWatch = deps.enableNightWatch;
    this.prepareWorkspaceYokeRuntime = deps.prepareWorkspaceYokeRuntime ?? prepareAgentWorkspaceYokeRuntime;
  }

  async handleTaskDispatch(input: AgentWorkTaskDispatchInput): Promise<SessionSnapshot | null> {
    if (evaluateTaskDispatchEligibility(input) !== 'dispatch') {
      return null;
    }

    const taskBinding = this.bindingStore.getByBinding(
      input.subscription.subscriptionId,
      input.agent.agentId,
      'task',
      input.task.taskId,
    );
    const taskSession = this.resolveLiveBindingSession(taskBinding);
    const workingDirectory = resolveDispatchWorkingDirectory(input.task, input.agent);
    const session = taskSession ?? await this.createSession(
      this.defaultAgent,
      workingDirectory,
      buildSessionName(input.agent, input.task, 'task_dispatch'),
      buildSessionOrigin(input.agent, input.task, 'task_dispatch'),
      input.subscription.managedByNpub ?? undefined,
      {
        AGENT: true,
        role: 'agent-work',
        goal: buildAgentWorkGoal(input.task),
        nextAction: 'reflect',
        bindingType: 'task',
        bindingId: input.task.taskId,
        flowId: input.task.flowId ?? undefined,
        flowRunId: input.task.flowRunId ?? undefined,
        taskIds: [input.task.taskId],
        createdByNpub: input.subscription.managedByNpub ?? undefined,
        lastManagedByNpub: input.subscription.managedByNpub ?? undefined,
        chargeToNpub: input.subscription.managedByNpub ?? undefined,
      },
    );

    const liveSession = this.updateSessionMetadata(
      session.id,
      buildMetadataPatch({
        session,
        task: input.task,
        bindingType: 'task',
        bindingId: input.task.taskId,
        managedByNpub: input.subscription.managedByNpub,
      }),
    ) ?? session;

    this.saveBinding({
      subscriptionId: input.subscription.subscriptionId,
      agentId: input.agent.agentId,
      bindingType: 'task',
      bindingId: input.task.taskId,
      sessionId: liveSession.id,
      lastRecordIdSeen: input.recordId,
    });

    this.queueTaskPromptIfMissing(
      liveSession.id,
      input.task.taskId,
      buildTaskDispatchPrompt({
        agent: input.agent,
        task: input.task,
        dispatchReason: resolveTaskDispatchReason(taskBinding),
        runtimeContext: input.runtimeContext,
      }),
    );
    await this.maybeAutoDispatchQueuedPrompt(this.getSession(liveSession.id) ?? liveSession);
    return this.getSession(liveSession.id) ?? liveSession;
  }

  async handleTaskCommentDispatch(input: AgentWorkTaskCommentDispatchInput): Promise<SessionSnapshot | null> {
    const taskId = compactText(input.comment.targetRecordId);
    if (!taskId) {
      return null;
    }

    const taskBinding = this.bindingStore.getByBinding(
      input.subscription.subscriptionId,
      input.agent.agentId,
      'task',
      taskId,
    );
    const liveSession = this.resolveLiveBindingSession(taskBinding);
    if (!liveSession) {
      return null;
    }
    const commentBinding = this.bindingStore.getByBinding(
      input.subscription.subscriptionId,
      input.agent.agentId,
      'thread',
      input.comment.commentId,
    );
    if (
      commentBinding
      && commentBinding.sessionId === liveSession.id
      && commentBinding.lastRecordIdSeen === input.recordId
    ) {
      return liveSession;
    }

    const yokeRuntime = await this.prepareWorkspaceYokeRuntime({
      sessionId: liveSession.id,
      workingDirectory: liveSession.workingDirectory,
      subscription: input.subscription,
      botIdentity: input.botIdentity,
    });
    const commands = buildAgentTaskCommentYokeCommands(
      yokeRuntime.stateDir,
      taskId,
      input.comment.commentId,
    );
    this.queuePromptIfMissing(
      liveSession.id,
      buildTaskCommentDispatchPrompt({
        agent: input.agent,
        taskId,
        comment: input.comment,
        commands,
        runtimeContext: input.runtimeContext,
      }),
    );
    this.saveBinding({
      subscriptionId: input.subscription.subscriptionId,
      agentId: input.agent.agentId,
      bindingType: 'thread',
      bindingId: input.comment.commentId,
      sessionId: liveSession.id,
      lastRecordIdSeen: input.recordId,
    });
    await this.maybeAutoDispatchQueuedPrompt(this.getSession(liveSession.id) ?? liveSession);
    return this.getSession(liveSession.id) ?? liveSession;
  }

  private queuePromptIfMissing(sessionId: string, content: string): void {
    if (this.hasQueuedPrompt?.(sessionId, content)) {
      return;
    }
    this.addPrompt(sessionId, content);
  }

  private queueTaskPromptIfMissing(sessionId: string, taskId: string, content: string): void {
    if (this.hasQueuedTaskDispatchPrompt?.(sessionId, taskId)) {
      return;
    }
    this.queuePromptIfMissing(sessionId, content);
  }

  private resolveLiveBindingSession(
    binding: AgentWorkSessionBindingRecord | null,
  ): SessionSnapshot | null {
    if (!binding || binding.state !== 'active') {
      return null;
    }
    const session = this.getSession(binding.sessionId);
    if (isLiveSession(session)) {
      return session;
    }
    this.bindingStore.markStaleForSession(binding.sessionId);
    return null;
  }

  private saveBinding(input: {
    subscriptionId: string;
    agentId: string;
    bindingType: AgentWorkBindingType;
    bindingId: string;
    sessionId: string;
    lastRecordIdSeen: string | null;
  }): AgentWorkSessionBindingRecord {
    const existing = this.bindingStore.getByBinding(
      input.subscriptionId,
      input.agentId,
      input.bindingType,
      input.bindingId,
    );
    const now = new Date().toISOString();
    return this.bindingStore.save({
      subscriptionId: input.subscriptionId,
      agentId: input.agentId,
      bindingType: input.bindingType,
      bindingId: input.bindingId,
      sessionId: input.sessionId,
      lastRecordIdSeen: input.lastRecordIdSeen,
      state: 'active',
      lastActivityAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}
