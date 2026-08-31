import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import type {
  AgentChatDiagnostic,
  BackendConnectionRecord,
  PipelineVersionPolicy,
  WorkspaceSubscriptionRecord,
} from './types';
import {
  DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
  normaliseBuiltInDispatchPipelineId,
  normaliseDispatchPipelineVersionPolicy,
} from './dispatch-pipelines/pipeline-policy';

const DEFAULT_DB_PATH = databaseFile;
const BUILT_IN_DEFAULT_PIPELINE_ID = 'fd-agent-dispatch-chat';
export const DEFAULT_DUPLICATE_CALLBACK_MARKER = 'duplicate callback:';
export const DEFAULT_DUPLICATE_CALLBACK_WINDOW_SECONDS = 180;
export const DUPLICATE_CALLBACK_MARKER_MAX_LENGTH = 512;

export function normaliseDuplicateCallbackMarker(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Duplicate callback marker must be a string.');
  }
  if (value.length > DUPLICATE_CALLBACK_MARKER_MAX_LENGTH) {
    throw new Error(`Duplicate callback marker must be ${DUPLICATE_CALLBACK_MARKER_MAX_LENGTH} characters or fewer.`);
  }
  return value;
}

export function normaliseDuplicateCallbackWindowSeconds(value: unknown): number {
  const parsed = typeof value === 'string' && value.length > 0 ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) {
    throw new Error('Duplicate callback window must be a non-negative whole number of seconds.');
  }
  return Number(parsed);
}

export type AgentWorkspaceEventType =
  | 'direct_message'
  | 'chat_mention'
  | 'chat_observe'
  | 'document_created'
  | 'document_invocation'
  | 'document_comment_tagged'
  | 'document_comment_observe'
  | 'task_assigned'
  | 'task_invocation'
  | 'task_comment'
  | 'approval_assigned'
  | 'flow_step_assigned';

export type AgentWorkspacePolicyAction =
  | 'respond'
  | 'ignore'
  | 'observe'
  | 'index'
  | 'work'
  | 'acknowledge'
  | 'notify'
  | 'process'
  | 'run_flow_handler';

export type AgentWorkspaceOnboardingStatus =
  | 'found'
  | 'verified'
  | 'ready'
  | 'revoked'
  | 'deleted'
  | 'stale'
  | 'failed';

export type AgentWorkspacePipelineOverrideTarget = 'scope' | 'channel';
export type AgentWorkspaceContextKind = 'workspace' | 'scope' | 'channel' | 'event_policy';

export interface AgentProfileRecord {
  profileId: string;
  managedByNpub: string;
  agentNpub: string;
  label: string;
  defaultPipelineDefinitionId: string | null;
  promptContext: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileWorkspaceRecord {
  profileWorkspaceId: string;
  profileId: string;
  managedByNpub: string;
  subscriptionId: string;
  backendConnectionId: string | null;
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  backendBaseUrl: string;
  towerServiceNpub: string | null;
  workspaceId: string | null;
  workspaceServiceNpub: string | null;
  workspaceTitle: string | null;
  appPubkey: string | null;
  towerUrl: string;
  connectionHealth: string;
  yokeSyncStatus: string;
  relayOnboardingStatus: AgentWorkspaceOnboardingStatus;
  defaultPipelineDefinitionId: string | null;
  workspaceContext: string | null;
  duplicateCallbackMarker: string;
  duplicateCallbackWindowSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkspaceEventPolicyRecord {
  profileWorkspaceId: string;
  eventType: AgentWorkspaceEventType;
  enabled: boolean;
  defaultAction: AgentWorkspacePolicyAction;
  pipelineDefinitionId: string | null;
  pipelineVersionPolicy: PipelineVersionPolicy;
  promptContext: string | null;
  quietMode: boolean;
  lastDiagnostic: AgentChatDiagnostic | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkspacePipelineOverrideRecord {
  profileWorkspaceId: string;
  targetKind: AgentWorkspacePipelineOverrideTarget;
  targetId: string;
  pipelineDefinitionId: string;
  pipelineVersionPolicy: PipelineVersionPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkspaceAppendedContextRecord {
  profileWorkspaceId: string;
  contextKind: AgentWorkspaceContextKind;
  targetId: string | null;
  eventType: AgentWorkspaceEventType | null;
  contextText: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileWorkspaceBundle {
  profile: AgentProfileRecord;
  workspace: AgentProfileWorkspaceRecord;
  policies: AgentWorkspaceEventPolicyRecord[];
  pipelineOverrides: AgentWorkspacePipelineOverrideRecord[];
  appendedContexts: AgentWorkspaceAppendedContextRecord[];
}

export interface ResolvedPipelineSelection {
  pipelineDefinitionId: string;
  pipelineVersionPolicy: PipelineVersionPolicy;
  source: 'event_policy' | 'channel_override' | 'scope_override' | 'workspace_default' | 'profile_default' | 'built_in_default';
}

export interface ResolvedAppendedContext {
  kind: AgentWorkspaceContextKind | 'agent_profile';
  targetId: string | null;
  eventType: AgentWorkspaceEventType | null;
  contextText: string;
}

export interface ResolvedAgentWorkspaceRuntimeSettings {
  policy: AgentWorkspaceEventPolicyRecord | null;
  pipeline: ResolvedPipelineSelection;
  appendedContext: ResolvedAppendedContext[];
}

const DEFAULT_EVENT_POLICIES: Array<Pick<AgentWorkspaceEventPolicyRecord, 'eventType' | 'enabled' | 'defaultAction' | 'quietMode'>> = [
  { eventType: 'direct_message', enabled: true, defaultAction: 'respond', quietMode: false },
  { eventType: 'chat_mention', enabled: true, defaultAction: 'respond', quietMode: false },
  { eventType: 'chat_observe', enabled: false, defaultAction: 'observe', quietMode: true },
  { eventType: 'document_created', enabled: false, defaultAction: 'index', quietMode: true },
  { eventType: 'document_invocation', enabled: true, defaultAction: 'work', quietMode: false },
  { eventType: 'document_comment_tagged', enabled: true, defaultAction: 'respond', quietMode: false },
  { eventType: 'document_comment_observe', enabled: false, defaultAction: 'observe', quietMode: true },
  { eventType: 'task_assigned', enabled: true, defaultAction: 'work', quietMode: false },
  { eventType: 'task_invocation', enabled: true, defaultAction: 'work', quietMode: false },
  { eventType: 'task_comment', enabled: true, defaultAction: 'respond', quietMode: false },
  { eventType: 'approval_assigned', enabled: true, defaultAction: 'notify', quietMode: false },
  { eventType: 'flow_step_assigned', enabled: true, defaultAction: 'run_flow_handler', quietMode: false },
];

function jsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function jsonString(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function stableWorkspaceId(input: {
  managedByNpub: string;
  profileId: string;
  subscriptionId: string;
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
}): string {
  return [
    'profile-workspace',
    input.managedByNpub,
    input.profileId,
    input.subscriptionId,
    input.workspaceOwnerNpub,
    input.sourceAppNpub,
  ].map((part) => encodeURIComponent(part)).join(':');
}

export function defaultAgentWorkspaceEventPolicies(): AgentWorkspaceEventPolicyRecord[] {
  const now = new Date(0).toISOString();
  return DEFAULT_EVENT_POLICIES.map((policy) => ({
    profileWorkspaceId: '',
    eventType: policy.eventType,
    enabled: policy.enabled,
    defaultAction: policy.defaultAction,
    pipelineDefinitionId: null,
    pipelineVersionPolicy: DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
    promptContext: null,
    quietMode: policy.quietMode,
    lastDiagnostic: null,
    createdAt: now,
    updatedAt: now,
  }));
}

export function resolveAgentWorkspacePipeline(input: {
  eventPolicy?: Pick<AgentWorkspaceEventPolicyRecord, 'pipelineDefinitionId' | 'pipelineVersionPolicy'> | null;
  channelOverride?: Pick<AgentWorkspacePipelineOverrideRecord, 'pipelineDefinitionId' | 'pipelineVersionPolicy'> | null;
  scopeOverride?: Pick<AgentWorkspacePipelineOverrideRecord, 'pipelineDefinitionId' | 'pipelineVersionPolicy'> | null;
  workspace?: Pick<AgentProfileWorkspaceRecord, 'defaultPipelineDefinitionId'> | null;
  profile?: Pick<AgentProfileRecord, 'defaultPipelineDefinitionId'> | null;
  builtInDefaultPipelineId?: string | null;
}): ResolvedPipelineSelection {
  const eventPipeline = textOrNull(input.eventPolicy?.pipelineDefinitionId ?? null);
  if (eventPipeline) {
    return {
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(eventPipeline) ?? eventPipeline,
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(input.eventPolicy?.pipelineVersionPolicy),
      source: 'event_policy',
    };
  }
  const channelPipeline = textOrNull(input.channelOverride?.pipelineDefinitionId ?? null);
  if (channelPipeline) {
    return {
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(channelPipeline) ?? channelPipeline,
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(input.channelOverride?.pipelineVersionPolicy),
      source: 'channel_override',
    };
  }
  const scopePipeline = textOrNull(input.scopeOverride?.pipelineDefinitionId ?? null);
  if (scopePipeline) {
    return {
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(scopePipeline) ?? scopePipeline,
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(input.scopeOverride?.pipelineVersionPolicy),
      source: 'scope_override',
    };
  }
  const workspacePipeline = textOrNull(input.workspace?.defaultPipelineDefinitionId ?? null);
  if (workspacePipeline) {
    return {
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(workspacePipeline) ?? workspacePipeline,
      pipelineVersionPolicy: DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
      source: 'workspace_default',
    };
  }
  const profilePipeline = textOrNull(input.profile?.defaultPipelineDefinitionId ?? null);
  if (profilePipeline) {
    return {
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(profilePipeline) ?? profilePipeline,
      pipelineVersionPolicy: DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
      source: 'profile_default',
    };
  }
  return {
    pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(textOrNull(input.builtInDefaultPipelineId ?? null))
      ?? textOrNull(input.builtInDefaultPipelineId ?? null)
      ?? BUILT_IN_DEFAULT_PIPELINE_ID,
    pipelineVersionPolicy: DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
    source: 'built_in_default',
  };
}

export function resolveAgentWorkspaceAppendedContext(input: {
  workspaceContext?: string | null;
  scopeContext?: string | null;
  channelContext?: string | null;
  eventPolicyContext?: string | null;
  scopeId?: string | null;
  channelId?: string | null;
  eventType?: AgentWorkspaceEventType | null;
}): ResolvedAppendedContext[] {
  const rows: ResolvedAppendedContext[] = [];
  const workspaceContext = textOrNull(input.workspaceContext ?? null);
  if (workspaceContext) {
    rows.push({ kind: 'workspace', targetId: null, eventType: null, contextText: workspaceContext });
  }
  const scopeContext = textOrNull(input.scopeContext ?? null);
  if (scopeContext) {
    rows.push({ kind: 'scope', targetId: input.scopeId ?? null, eventType: null, contextText: scopeContext });
  }
  const channelContext = textOrNull(input.channelContext ?? null);
  if (channelContext) {
    rows.push({ kind: 'channel', targetId: input.channelId ?? null, eventType: null, contextText: channelContext });
  }
  const eventPolicyContext = textOrNull(input.eventPolicyContext ?? null);
  if (eventPolicyContext) {
    rows.push({
      kind: 'event_policy',
      targetId: null,
      eventType: input.eventType ?? null,
      contextText: eventPolicyContext,
    });
  }
  return rows;
}

class AgentProfilePolicyStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.initialise();
  }

  ensureProfileWorkspaceForSubscription(input: {
    managedByNpub: string;
    agentProfileId?: string | null;
    agentLabel?: string | null;
    agentNpub: string;
    subscription: WorkspaceSubscriptionRecord;
    backendConnection?: BackendConnectionRecord | null;
    relayOnboardingStatus?: AgentWorkspaceOnboardingStatus;
    workspaceTitle?: string | null;
  }): AgentProfileWorkspaceBundle {
    const now = new Date().toISOString();
    const profileId = textOrNull(input.agentProfileId) ?? input.agentNpub;
    const existingProfile = this.getProfile(profileId, input.managedByNpub);
    const profile = this.saveProfile({
      profileId,
      managedByNpub: input.managedByNpub,
      agentNpub: input.agentNpub,
      label: textOrNull(input.agentLabel) ?? existingProfile?.label ?? profileId,
      defaultPipelineDefinitionId: existingProfile?.defaultPipelineDefinitionId ?? null,
      promptContext: existingProfile?.promptContext ?? null,
      createdAt: existingProfile?.createdAt ?? now,
      updatedAt: now,
    });

    const workspaceId = stableWorkspaceId({
      managedByNpub: input.managedByNpub,
      profileId,
      subscriptionId: input.subscription.subscriptionId,
      workspaceOwnerNpub: input.subscription.workspaceOwnerNpub,
      sourceAppNpub: input.subscription.sourceAppNpub,
    });
    const existingWorkspace = this.getWorkspace(workspaceId);
    const workspace = this.saveWorkspace({
      profileWorkspaceId: workspaceId,
      profileId,
      managedByNpub: input.managedByNpub,
      subscriptionId: input.subscription.subscriptionId,
      backendConnectionId: input.subscription.backendConnectionId ?? input.backendConnection?.backendConnectionId ?? null,
      workspaceOwnerNpub: input.subscription.workspaceOwnerNpub,
      sourceAppNpub: input.subscription.sourceAppNpub,
      backendBaseUrl: input.subscription.backendBaseUrl,
      towerServiceNpub: input.subscription.towerServiceNpub ?? input.backendConnection?.serviceNpub ?? null,
      workspaceId: input.subscription.workspaceId ?? null,
      workspaceServiceNpub: input.subscription.workspaceServiceNpub ?? null,
      workspaceTitle: existingWorkspace?.workspaceTitle ?? textOrNull(input.workspaceTitle),
      appPubkey: input.subscription.sourceAppNpub,
      towerUrl: input.backendConnection?.backendBaseUrl ?? input.subscription.backendBaseUrl,
      connectionHealth: input.backendConnection?.healthStatus ?? input.subscription.healthStatus,
      yokeSyncStatus: input.subscription.lastSyncCursor ? 'synced' : input.subscription.groupKeyStatus,
      relayOnboardingStatus: input.relayOnboardingStatus ?? existingWorkspace?.relayOnboardingStatus ?? 'verified',
      defaultPipelineDefinitionId: existingWorkspace?.defaultPipelineDefinitionId ?? null,
      workspaceContext: existingWorkspace?.workspaceContext ?? null,
      duplicateCallbackMarker: existingWorkspace?.duplicateCallbackMarker ?? DEFAULT_DUPLICATE_CALLBACK_MARKER,
      duplicateCallbackWindowSeconds: existingWorkspace?.duplicateCallbackWindowSeconds
        ?? DEFAULT_DUPLICATE_CALLBACK_WINDOW_SECONDS,
      createdAt: existingWorkspace?.createdAt ?? now,
      updatedAt: now,
    });

    this.ensureDefaultPolicies(workspace.profileWorkspaceId, now);
    const bundle = {
      profile,
      workspace,
      policies: this.listPolicies(workspace.profileWorkspaceId),
      pipelineOverrides: this.listPipelineOverrides(workspace.profileWorkspaceId),
      appendedContexts: this.listAppendedContexts(workspace.profileWorkspaceId),
    };
    return bundle;
  }

  getProfile(profileId: string, managedByNpub: string): AgentProfileRecord | null {
    const row = this.db.query(
      `SELECT profile_id, managed_by_npub, agent_npub, label, default_pipeline_definition_id,
              prompt_context, created_at, updated_at
       FROM agent_profiles
       WHERE profile_id = ?1 AND managed_by_npub = ?2
       LIMIT 1`,
    ).get(profileId, managedByNpub) as Record<string, string | null> | null;
    return row ? this.mapProfile(row) : null;
  }

  getWorkspace(profileWorkspaceId: string): AgentProfileWorkspaceRecord | null {
    const row = this.db.query(
      `SELECT profile_workspace_id, profile_id, managed_by_npub, subscription_id,
              backend_connection_id, workspace_owner_npub, source_app_npub, backend_base_url,
              tower_service_npub, workspace_id, workspace_service_npub,
              workspace_title, app_pubkey, tower_url, connection_health, yoke_sync_status,
              relay_onboarding_status, default_pipeline_definition_id, workspace_context,
              duplicate_callback_marker, duplicate_callback_window_seconds,
              created_at, updated_at
       FROM agent_profile_workspaces
       WHERE profile_workspace_id = ?1
       LIMIT 1`,
    ).get(profileWorkspaceId) as Record<string, string | number | null> | null;
    return row ? this.mapWorkspace(row) : null;
  }

  listWorkspacesForProfile(profileId: string, managedByNpub: string): AgentProfileWorkspaceRecord[] {
    return this.db.query(
      `SELECT profile_workspace_id, profile_id, managed_by_npub, subscription_id,
              backend_connection_id, workspace_owner_npub, source_app_npub, backend_base_url,
              tower_service_npub, workspace_id, workspace_service_npub,
              workspace_title, app_pubkey, tower_url, connection_health, yoke_sync_status,
              relay_onboarding_status, default_pipeline_definition_id, workspace_context,
              duplicate_callback_marker, duplicate_callback_window_seconds,
              created_at, updated_at
       FROM agent_profile_workspaces
       WHERE profile_id = ?1 AND managed_by_npub = ?2
       ORDER BY updated_at DESC`,
    ).all(profileId, managedByNpub).map((row) => this.mapWorkspace(row as Record<string, string | number | null>));
  }

  deleteProfile(profileId: string, managedByNpub: string): boolean {
    const result = this.db.query(
      'DELETE FROM agent_profiles WHERE profile_id = ?1 AND managed_by_npub = ?2',
    ).run(profileId, managedByNpub);
    return result.changes > 0;
  }

  listPolicies(profileWorkspaceId: string): AgentWorkspaceEventPolicyRecord[] {
    return this.db.query(
      `SELECT profile_workspace_id, event_type, enabled, default_action,
              pipeline_definition_id, pipeline_version_policy, prompt_context, quiet_mode,
              last_diagnostic_json, created_at, updated_at
       FROM agent_profile_event_policies
       WHERE profile_workspace_id = ?1
       ORDER BY event_type ASC`,
    ).all(profileWorkspaceId).map((row) => this.mapPolicy(row as Record<string, string | number | null>));
  }

  listPipelineOverrides(profileWorkspaceId: string): AgentWorkspacePipelineOverrideRecord[] {
    return this.db.query(
      `SELECT profile_workspace_id, target_kind, target_id, pipeline_definition_id, pipeline_version_policy, created_at, updated_at
       FROM agent_profile_pipeline_overrides
       WHERE profile_workspace_id = ?1
       ORDER BY target_kind ASC, target_id ASC`,
    ).all(profileWorkspaceId).map((row) => {
      const record = row as Record<string, string | null>;
      return {
        profileWorkspaceId: record.profile_workspace_id!,
        targetKind: record.target_kind as AgentWorkspacePipelineOverrideTarget,
        targetId: record.target_id!,
        pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(record.pipeline_definition_id) ?? record.pipeline_definition_id!,
        pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(record.pipeline_version_policy),
        createdAt: record.created_at!,
        updatedAt: record.updated_at!,
      };
    });
  }

  listAppendedContexts(profileWorkspaceId: string): AgentWorkspaceAppendedContextRecord[] {
    return this.db.query(
      `SELECT profile_workspace_id, context_kind, target_id, event_type, context_text, created_at, updated_at
       FROM agent_profile_appended_contexts
       WHERE profile_workspace_id = ?1
       ORDER BY context_kind ASC, target_id ASC, event_type ASC`,
    ).all(profileWorkspaceId).map((row) => {
      const record = row as Record<string, string | null>;
      return {
        profileWorkspaceId: record.profile_workspace_id!,
        contextKind: record.context_kind as AgentWorkspaceContextKind,
        targetId: record.target_id || null,
        eventType: record.event_type ? record.event_type as AgentWorkspaceEventType : null,
        contextText: record.context_text!,
        createdAt: record.created_at!,
        updatedAt: record.updated_at!,
      };
    });
  }

  getPolicy(profileWorkspaceId: string, eventType: AgentWorkspaceEventType): AgentWorkspaceEventPolicyRecord | null {
    const row = this.db.query(
      `SELECT profile_workspace_id, event_type, enabled, default_action,
              pipeline_definition_id, pipeline_version_policy, prompt_context, quiet_mode,
              last_diagnostic_json, created_at, updated_at
       FROM agent_profile_event_policies
       WHERE profile_workspace_id = ?1 AND event_type = ?2
       LIMIT 1`,
    ).get(profileWorkspaceId, eventType) as Record<string, string | number | null> | null;
    return row ? this.mapPolicy(row) : null;
  }

  saveEventPolicy(input: AgentWorkspaceEventPolicyRecord): AgentWorkspaceEventPolicyRecord {
    this.db.query(
      `INSERT INTO agent_profile_event_policies (
         profile_workspace_id, event_type, enabled, default_action,
         pipeline_definition_id, pipeline_version_policy, prompt_context, quiet_mode,
         last_diagnostic_json, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(profile_workspace_id, event_type) DO UPDATE SET
         enabled = excluded.enabled,
         default_action = excluded.default_action,
         pipeline_definition_id = excluded.pipeline_definition_id,
         pipeline_version_policy = excluded.pipeline_version_policy,
         prompt_context = excluded.prompt_context,
         quiet_mode = excluded.quiet_mode,
         last_diagnostic_json = excluded.last_diagnostic_json,
         updated_at = excluded.updated_at`,
    ).run(
      input.profileWorkspaceId,
      input.eventType,
      input.enabled ? 1 : 0,
      input.defaultAction,
      normaliseBuiltInDispatchPipelineId(input.pipelineDefinitionId) ?? input.pipelineDefinitionId,
      normaliseDispatchPipelineVersionPolicy(input.pipelineVersionPolicy),
      input.promptContext,
      input.quietMode ? 1 : 0,
      jsonString(input.lastDiagnostic),
      input.createdAt,
      input.updatedAt,
    );
    return this.getPolicy(input.profileWorkspaceId, input.eventType) ?? input;
  }

  savePipelineOverride(input: {
    profileWorkspaceId: string;
    targetKind: AgentWorkspacePipelineOverrideTarget;
    targetId: string;
    pipelineDefinitionId: string;
    pipelineVersionPolicy?: PipelineVersionPolicy;
  }): AgentWorkspacePipelineOverrideRecord {
    const now = new Date().toISOString();
    const existing = this.getPipelineOverride(input.profileWorkspaceId, input.targetKind, input.targetId);
    const record = {
      ...input,
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(input.pipelineDefinitionId) ?? input.pipelineDefinitionId,
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(input.pipelineVersionPolicy),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.query(
      `INSERT INTO agent_profile_pipeline_overrides (
         profile_workspace_id, target_kind, target_id, pipeline_definition_id, pipeline_version_policy, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(profile_workspace_id, target_kind, target_id) DO UPDATE SET
         pipeline_definition_id = excluded.pipeline_definition_id,
         pipeline_version_policy = excluded.pipeline_version_policy,
         updated_at = excluded.updated_at`,
    ).run(
      record.profileWorkspaceId,
      record.targetKind,
      record.targetId,
      record.pipelineDefinitionId,
      record.pipelineVersionPolicy,
      record.createdAt,
      record.updatedAt,
    );
    return this.getPipelineOverride(input.profileWorkspaceId, input.targetKind, input.targetId) ?? record;
  }

  replacePipelineOverrides(
    profileWorkspaceId: string,
    overrides: Array<{
      targetKind: AgentWorkspacePipelineOverrideTarget;
      targetId: string;
      pipelineDefinitionId: string;
    }>,
  ): AgentWorkspacePipelineOverrideRecord[] {
    this.db.query('DELETE FROM agent_profile_pipeline_overrides WHERE profile_workspace_id = ?1').run(profileWorkspaceId);
    const saved: AgentWorkspacePipelineOverrideRecord[] = [];
    for (const override of overrides) {
      const targetId = textOrNull(override.targetId);
      const pipelineDefinitionId = textOrNull(override.pipelineDefinitionId);
      if (!targetId || !pipelineDefinitionId) {
        continue;
      }
      saved.push(this.savePipelineOverride({
        profileWorkspaceId,
        targetKind: override.targetKind,
        targetId,
        pipelineDefinitionId,
        pipelineVersionPolicy: DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
      }));
    }
    return saved;
  }

  getPipelineOverride(
    profileWorkspaceId: string,
    targetKind: AgentWorkspacePipelineOverrideTarget,
    targetId: string | null | undefined,
  ): AgentWorkspacePipelineOverrideRecord | null {
    const row = this.db.query(
      `SELECT profile_workspace_id, target_kind, target_id, pipeline_definition_id, pipeline_version_policy, created_at, updated_at
       FROM agent_profile_pipeline_overrides
       WHERE profile_workspace_id = ?1 AND target_kind = ?2 AND target_id = ?3
       LIMIT 1`,
    ).get(profileWorkspaceId, targetKind, targetId ?? '') as Record<string, string | null> | null;
    return row ? {
      profileWorkspaceId: row.profile_workspace_id!,
      targetKind: row.target_kind as AgentWorkspacePipelineOverrideTarget,
      targetId: row.target_id!,
      pipelineDefinitionId: normaliseBuiltInDispatchPipelineId(row.pipeline_definition_id) ?? row.pipeline_definition_id!,
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(row.pipeline_version_policy),
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    } : null;
  }

  saveAppendedContext(input: {
    profileWorkspaceId: string;
    contextKind: AgentWorkspaceContextKind;
    targetId?: string | null;
    eventType?: AgentWorkspaceEventType | null;
    contextText: string;
  }): AgentWorkspaceAppendedContextRecord {
    const now = new Date().toISOString();
    const targetId = input.targetId ?? '';
    const eventType = input.eventType ?? '';
    const existing = this.getAppendedContext(input.profileWorkspaceId, input.contextKind, targetId, eventType);
    const record: AgentWorkspaceAppendedContextRecord = {
      profileWorkspaceId: input.profileWorkspaceId,
      contextKind: input.contextKind,
      targetId: targetId || null,
      eventType: eventType ? eventType as AgentWorkspaceEventType : null,
      contextText: input.contextText,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.query(
      `INSERT INTO agent_profile_appended_contexts (
         profile_workspace_id, context_kind, target_id, event_type, context_text, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(profile_workspace_id, context_kind, target_id, event_type) DO UPDATE SET
         context_text = excluded.context_text,
         updated_at = excluded.updated_at`,
    ).run(
      record.profileWorkspaceId,
      record.contextKind,
      targetId,
      eventType,
      record.contextText,
      record.createdAt,
      record.updatedAt,
    );
    return this.getAppendedContext(input.profileWorkspaceId, input.contextKind, targetId, eventType) ?? record;
  }

  replaceAppendedContexts(
    profileWorkspaceId: string,
    contexts: Array<{
      contextKind: AgentWorkspaceContextKind;
      targetId?: string | null;
      eventType?: AgentWorkspaceEventType | null;
      contextText: string;
    }>,
  ): AgentWorkspaceAppendedContextRecord[] {
    this.db.query('DELETE FROM agent_profile_appended_contexts WHERE profile_workspace_id = ?1').run(profileWorkspaceId);
    const saved: AgentWorkspaceAppendedContextRecord[] = [];
    for (const context of contexts) {
      const contextText = textOrNull(context.contextText);
      if (!contextText) {
        continue;
      }
      saved.push(this.saveAppendedContext({
        profileWorkspaceId,
        contextKind: context.contextKind,
        targetId: context.targetId,
        eventType: context.eventType,
        contextText,
      }));
    }
    return saved;
  }

  updateProfileDefaults(input: {
    profileId: string;
    managedByNpub: string;
    defaultPipelineDefinitionId?: string | null;
    promptContext?: string | null;
  }): AgentProfileRecord {
    const existing = this.getProfile(input.profileId, input.managedByNpub);
    if (!existing) {
      throw new Error(`Agent profile ${input.profileId} was not found.`);
    }
    return this.saveProfile({
      ...existing,
      defaultPipelineDefinitionId: input.defaultPipelineDefinitionId === undefined
        ? existing.defaultPipelineDefinitionId
        : textOrNull(input.defaultPipelineDefinitionId),
      promptContext: input.promptContext === undefined
        ? existing.promptContext
        : textOrNull(input.promptContext),
      updatedAt: new Date().toISOString(),
    });
  }

  updateWorkspaceDefaults(input: {
    profileWorkspaceId: string;
    defaultPipelineDefinitionId?: string | null;
    workspaceContext?: string | null;
    workspaceTitle?: string | null;
    duplicateCallbackMarker?: string;
    duplicateCallbackWindowSeconds?: number;
  }): AgentProfileWorkspaceRecord {
    const existing = this.getWorkspace(input.profileWorkspaceId);
    if (!existing) {
      throw new Error(`Agent profile workspace ${input.profileWorkspaceId} was not found.`);
    }
    return this.saveWorkspace({
      ...existing,
      defaultPipelineDefinitionId: input.defaultPipelineDefinitionId === undefined
        ? existing.defaultPipelineDefinitionId
        : textOrNull(input.defaultPipelineDefinitionId),
      workspaceContext: input.workspaceContext === undefined
        ? existing.workspaceContext
        : textOrNull(input.workspaceContext),
      workspaceTitle: input.workspaceTitle === undefined
        ? existing.workspaceTitle
        : textOrNull(input.workspaceTitle) ?? existing.workspaceTitle,
      duplicateCallbackMarker: input.duplicateCallbackMarker === undefined
        ? existing.duplicateCallbackMarker
        : normaliseDuplicateCallbackMarker(input.duplicateCallbackMarker),
      duplicateCallbackWindowSeconds: input.duplicateCallbackWindowSeconds
        === undefined
        ? existing.duplicateCallbackWindowSeconds
        : normaliseDuplicateCallbackWindowSeconds(input.duplicateCallbackWindowSeconds),
      updatedAt: new Date().toISOString(),
    });
  }

  getDuplicateCallbackPublicationConfig(input: {
    subscriptionId: string;
    agentNpub: string;
  }): { marker: string; windowSeconds: number } | null {
    const row = this.db.query(
      `SELECT workspace.duplicate_callback_marker, workspace.duplicate_callback_window_seconds
       FROM agent_profile_workspaces AS workspace
       JOIN agent_profiles AS profile
         ON profile.profile_id = workspace.profile_id
        AND profile.managed_by_npub = workspace.managed_by_npub
       WHERE workspace.subscription_id = ?1 AND profile.agent_npub = ?2
       ORDER BY workspace.updated_at DESC
       LIMIT 1`,
    ).get(input.subscriptionId, input.agentNpub) as Record<string, string | number | null> | null;
    if (!row) return null;
    return {
      marker: typeof row.duplicate_callback_marker === 'string'
        ? row.duplicate_callback_marker
        : DEFAULT_DUPLICATE_CALLBACK_MARKER,
      windowSeconds: typeof row.duplicate_callback_window_seconds === 'number'
        ? row.duplicate_callback_window_seconds
        : DEFAULT_DUPLICATE_CALLBACK_WINDOW_SECONDS,
    };
  }

  resolvePipelineForEvent(input: {
    profileId: string;
    managedByNpub: string;
    profileWorkspaceId: string;
    eventType: AgentWorkspaceEventType;
    scopeId?: string | null;
    channelId?: string | null;
    builtInDefaultPipelineId?: string | null;
  }): ResolvedPipelineSelection {
    return resolveAgentWorkspacePipeline({
      eventPolicy: this.getPolicy(input.profileWorkspaceId, input.eventType),
      channelOverride: input.channelId
        ? this.getPipelineOverride(input.profileWorkspaceId, 'channel', input.channelId)
        : null,
      scopeOverride: input.scopeId
        ? this.getPipelineOverride(input.profileWorkspaceId, 'scope', input.scopeId)
        : null,
      workspace: this.getWorkspace(input.profileWorkspaceId),
      profile: this.getProfile(input.profileId, input.managedByNpub),
      builtInDefaultPipelineId: input.builtInDefaultPipelineId,
    });
  }

  resolveAppendedContextForEvent(input: {
    profileWorkspaceId: string;
    eventType: AgentWorkspaceEventType;
    scopeId?: string | null;
    channelId?: string | null;
  }): ResolvedAppendedContext[] {
    const workspace = this.getAppendedContext(input.profileWorkspaceId, 'workspace', '', '');
    const scope = input.scopeId
      ? this.getAppendedContext(input.profileWorkspaceId, 'scope', input.scopeId, '')
      : null;
    const channel = input.channelId
      ? this.getAppendedContext(input.profileWorkspaceId, 'channel', input.channelId, '')
      : null;
    const event = this.getAppendedContext(input.profileWorkspaceId, 'event_policy', '', input.eventType);
    return resolveAgentWorkspaceAppendedContext({
      workspaceContext: workspace?.contextText,
      scopeContext: scope?.contextText,
      channelContext: channel?.contextText,
      eventPolicyContext: event?.contextText,
      scopeId: input.scopeId,
      channelId: input.channelId,
      eventType: input.eventType,
    });
  }

  resolveRuntimeSettingsForEvent(input: {
    profileId: string;
    managedByNpub: string;
    profileWorkspaceId: string;
    eventType: AgentWorkspaceEventType;
    scopeId?: string | null;
    channelId?: string | null;
    builtInDefaultPipelineId?: string | null;
  }): ResolvedAgentWorkspaceRuntimeSettings {
    const profile = this.getProfile(input.profileId, input.managedByNpub);
    const workspace = this.getWorkspace(input.profileWorkspaceId);
    const policy = this.getPolicy(input.profileWorkspaceId, input.eventType);
    const pipeline = resolveAgentWorkspacePipeline({
      eventPolicy: policy,
      channelOverride: input.channelId
        ? this.getPipelineOverride(input.profileWorkspaceId, 'channel', input.channelId)
        : null,
      scopeOverride: input.scopeId
        ? this.getPipelineOverride(input.profileWorkspaceId, 'scope', input.scopeId)
        : null,
      workspace,
      profile,
      builtInDefaultPipelineId: input.builtInDefaultPipelineId,
    });
    const profileContext = textOrNull(profile?.promptContext ?? null);
    const workspaceContext = textOrNull(workspace?.workspaceContext ?? null);
    const policyContext = textOrNull(policy?.promptContext ?? null);
    const appendedContext: ResolvedAppendedContext[] = [
      ...(profileContext
        ? [{
            kind: 'agent_profile' as const,
            targetId: input.profileId,
            eventType: null,
            contextText: profileContext,
          }]
        : []),
      ...(workspaceContext
        ? [{
            kind: 'workspace' as const,
            targetId: null,
            eventType: null,
            contextText: workspaceContext,
          }]
        : []),
      ...this.resolveAppendedContextForEvent({
        profileWorkspaceId: input.profileWorkspaceId,
        eventType: input.eventType,
        scopeId: input.scopeId,
        channelId: input.channelId,
      }),
      ...(policyContext
        ? [{
            kind: 'event_policy' as const,
            targetId: null,
            eventType: input.eventType,
            contextText: policyContext,
          }]
        : []),
    ];
    return { policy, pipeline, appendedContext };
  }

  private getAppendedContext(
    profileWorkspaceId: string,
    contextKind: AgentWorkspaceContextKind,
    targetId: string,
    eventType: string,
  ): AgentWorkspaceAppendedContextRecord | null {
    const row = this.db.query(
      `SELECT profile_workspace_id, context_kind, target_id, event_type, context_text, created_at, updated_at
       FROM agent_profile_appended_contexts
       WHERE profile_workspace_id = ?1 AND context_kind = ?2 AND target_id = ?3 AND event_type = ?4
       LIMIT 1`,
    ).get(profileWorkspaceId, contextKind, targetId, eventType) as Record<string, string | null> | null;
    return row ? {
      profileWorkspaceId: row.profile_workspace_id!,
      contextKind: row.context_kind as AgentWorkspaceContextKind,
      targetId: row.target_id || null,
      eventType: row.event_type ? row.event_type as AgentWorkspaceEventType : null,
      contextText: row.context_text!,
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    } : null;
  }

  private saveProfile(record: AgentProfileRecord): AgentProfileRecord {
    this.db.query(
      `INSERT INTO agent_profiles (
         profile_id, managed_by_npub, agent_npub, label, default_pipeline_definition_id,
         prompt_context, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(profile_id, managed_by_npub) DO UPDATE SET
         agent_npub = excluded.agent_npub,
         label = excluded.label,
         default_pipeline_definition_id = excluded.default_pipeline_definition_id,
         prompt_context = excluded.prompt_context,
         updated_at = excluded.updated_at`,
    ).run(
      record.profileId,
      record.managedByNpub,
      record.agentNpub,
      record.label,
      record.defaultPipelineDefinitionId,
      record.promptContext,
      record.createdAt,
      record.updatedAt,
    );
    return this.getProfile(record.profileId, record.managedByNpub) ?? record;
  }

  private saveWorkspace(record: AgentProfileWorkspaceRecord): AgentProfileWorkspaceRecord {
    this.db.query(
      `INSERT INTO agent_profile_workspaces (
         profile_workspace_id, profile_id, managed_by_npub, subscription_id,
         backend_connection_id, workspace_owner_npub, source_app_npub, backend_base_url,
         tower_service_npub, workspace_id, workspace_service_npub,
         workspace_title, app_pubkey, tower_url, connection_health, yoke_sync_status,
         relay_onboarding_status, default_pipeline_definition_id, workspace_context,
         duplicate_callback_marker, duplicate_callback_window_seconds,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
       ON CONFLICT(profile_workspace_id) DO UPDATE SET
         subscription_id = excluded.subscription_id,
         backend_connection_id = excluded.backend_connection_id,
         backend_base_url = excluded.backend_base_url,
         tower_service_npub = excluded.tower_service_npub,
         workspace_id = excluded.workspace_id,
         workspace_service_npub = excluded.workspace_service_npub,
         workspace_title = excluded.workspace_title,
         tower_url = excluded.tower_url,
         connection_health = excluded.connection_health,
         yoke_sync_status = excluded.yoke_sync_status,
         relay_onboarding_status = excluded.relay_onboarding_status,
         default_pipeline_definition_id = excluded.default_pipeline_definition_id,
         workspace_context = excluded.workspace_context,
         duplicate_callback_marker = excluded.duplicate_callback_marker,
         duplicate_callback_window_seconds = excluded.duplicate_callback_window_seconds,
         updated_at = excluded.updated_at`,
    ).run(
      record.profileWorkspaceId,
      record.profileId,
      record.managedByNpub,
      record.subscriptionId,
      record.backendConnectionId,
      record.workspaceOwnerNpub,
      record.sourceAppNpub,
      record.backendBaseUrl,
      record.towerServiceNpub,
      record.workspaceId,
      record.workspaceServiceNpub,
      record.workspaceTitle,
      record.appPubkey,
      record.towerUrl,
      record.connectionHealth,
      record.yokeSyncStatus,
      record.relayOnboardingStatus,
      record.defaultPipelineDefinitionId,
      record.workspaceContext,
      record.duplicateCallbackMarker,
      record.duplicateCallbackWindowSeconds,
      record.createdAt,
      record.updatedAt,
    );
    return this.getWorkspace(record.profileWorkspaceId) ?? record;
  }

  private ensureDefaultPolicies(profileWorkspaceId: string, now: string): void {
    for (const policy of DEFAULT_EVENT_POLICIES) {
      if (this.getPolicy(profileWorkspaceId, policy.eventType)) {
        continue;
      }
      this.saveEventPolicy({
        profileWorkspaceId,
        eventType: policy.eventType,
        enabled: policy.enabled,
        defaultAction: policy.defaultAction,
        pipelineDefinitionId: null,
        pipelineVersionPolicy: DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY,
        promptContext: null,
        quietMode: policy.quietMode,
        lastDiagnostic: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private mapProfile(row: Record<string, string | null>): AgentProfileRecord {
    return {
      profileId: row.profile_id!,
      managedByNpub: row.managed_by_npub!,
      agentNpub: row.agent_npub!,
      label: row.label!,
      defaultPipelineDefinitionId: row.default_pipeline_definition_id ?? null,
      promptContext: row.prompt_context ?? null,
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    };
  }

  private mapWorkspace(row: Record<string, string | number | null>): AgentProfileWorkspaceRecord {
    return {
      profileWorkspaceId: String(row.profile_workspace_id!),
      profileId: String(row.profile_id!),
      managedByNpub: String(row.managed_by_npub!),
      subscriptionId: String(row.subscription_id!),
      backendConnectionId: typeof row.backend_connection_id === 'string' ? row.backend_connection_id : null,
      workspaceOwnerNpub: String(row.workspace_owner_npub!),
      sourceAppNpub: String(row.source_app_npub!),
      backendBaseUrl: String(row.backend_base_url!),
      towerServiceNpub: typeof row.tower_service_npub === 'string' ? row.tower_service_npub : null,
      workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
      workspaceServiceNpub: typeof row.workspace_service_npub === 'string' ? row.workspace_service_npub : null,
      workspaceTitle: typeof row.workspace_title === 'string' ? row.workspace_title : null,
      appPubkey: typeof row.app_pubkey === 'string' ? row.app_pubkey : null,
      towerUrl: String(row.tower_url!),
      connectionHealth: String(row.connection_health!),
      yokeSyncStatus: String(row.yoke_sync_status!),
      relayOnboardingStatus: String(row.relay_onboarding_status) as AgentWorkspaceOnboardingStatus,
      defaultPipelineDefinitionId: typeof row.default_pipeline_definition_id === 'string'
        ? row.default_pipeline_definition_id
        : null,
      workspaceContext: typeof row.workspace_context === 'string' ? row.workspace_context : null,
      duplicateCallbackMarker: typeof row.duplicate_callback_marker === 'string'
        ? row.duplicate_callback_marker
        : DEFAULT_DUPLICATE_CALLBACK_MARKER,
      duplicateCallbackWindowSeconds: typeof row.duplicate_callback_window_seconds === 'number'
        ? row.duplicate_callback_window_seconds
        : Number(row.duplicate_callback_window_seconds ?? DEFAULT_DUPLICATE_CALLBACK_WINDOW_SECONDS),
      createdAt: String(row.created_at!),
      updatedAt: String(row.updated_at!),
    };
  }

  private mapPolicy(row: Record<string, string | number | null>): AgentWorkspaceEventPolicyRecord {
    return {
      profileWorkspaceId: String(row.profile_workspace_id!),
      eventType: row.event_type as AgentWorkspaceEventType,
      enabled: row.enabled === 1 || row.enabled === '1',
      defaultAction: row.default_action as AgentWorkspacePolicyAction,
      pipelineDefinitionId: typeof row.pipeline_definition_id === 'string'
        ? normaliseBuiltInDispatchPipelineId(row.pipeline_definition_id)
        : null,
      pipelineVersionPolicy: normaliseDispatchPipelineVersionPolicy(
        typeof row.pipeline_version_policy === 'string' ? row.pipeline_version_policy : null,
      ),
      promptContext: typeof row.prompt_context === 'string' ? row.prompt_context : null,
      quietMode: row.quiet_mode === 1 || row.quiet_mode === '1',
      lastDiagnostic: jsonParse<AgentChatDiagnostic>(
        typeof row.last_diagnostic_json === 'string' ? row.last_diagnostic_json : null,
      ),
      createdAt: String(row.created_at!),
      updatedAt: String(row.updated_at!),
    };
  }

  private initialise(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        profile_id TEXT NOT NULL,
        managed_by_npub TEXT NOT NULL,
        agent_npub TEXT NOT NULL,
        label TEXT NOT NULL,
        default_pipeline_definition_id TEXT,
        prompt_context TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, managed_by_npub)
      );

      CREATE TABLE IF NOT EXISTS agent_profile_workspaces (
        profile_workspace_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        managed_by_npub TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        backend_connection_id TEXT,
        workspace_owner_npub TEXT NOT NULL,
        source_app_npub TEXT NOT NULL,
        backend_base_url TEXT NOT NULL,
        tower_service_npub TEXT,
        workspace_id TEXT,
        workspace_service_npub TEXT,
        workspace_title TEXT,
        app_pubkey TEXT,
        tower_url TEXT NOT NULL,
        connection_health TEXT NOT NULL,
        yoke_sync_status TEXT NOT NULL,
        relay_onboarding_status TEXT NOT NULL,
        default_pipeline_definition_id TEXT,
        workspace_context TEXT,
        duplicate_callback_marker TEXT NOT NULL DEFAULT 'duplicate callback:',
        duplicate_callback_window_seconds INTEGER NOT NULL DEFAULT 180,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (profile_id, managed_by_npub)
          REFERENCES agent_profiles(profile_id, managed_by_npub)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_profile_workspaces_profile
        ON agent_profile_workspaces(profile_id, managed_by_npub, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_profile_event_policies (
        profile_workspace_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        default_action TEXT NOT NULL,
        pipeline_definition_id TEXT,
        pipeline_version_policy TEXT NOT NULL DEFAULT 'latest',
        prompt_context TEXT,
        quiet_mode INTEGER NOT NULL,
        last_diagnostic_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_workspace_id, event_type),
        FOREIGN KEY (profile_workspace_id)
          REFERENCES agent_profile_workspaces(profile_workspace_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_profile_pipeline_overrides (
        profile_workspace_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        pipeline_definition_id TEXT NOT NULL,
        pipeline_version_policy TEXT NOT NULL DEFAULT 'latest',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_workspace_id, target_kind, target_id),
        FOREIGN KEY (profile_workspace_id)
          REFERENCES agent_profile_workspaces(profile_workspace_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_profile_appended_contexts (
        profile_workspace_id TEXT NOT NULL,
        context_kind TEXT NOT NULL,
        target_id TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT '',
        context_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_workspace_id, context_kind, target_id, event_type),
        FOREIGN KEY (profile_workspace_id)
          REFERENCES agent_profile_workspaces(profile_workspace_id)
          ON DELETE CASCADE
      );
    `);

    if (!hasColumn(this.db, 'agent_profile_workspaces', 'tower_service_npub')) {
      this.db.exec('ALTER TABLE agent_profile_workspaces ADD COLUMN tower_service_npub TEXT');
    }
    if (!hasColumn(this.db, 'agent_profile_workspaces', 'workspace_id')) {
      this.db.exec('ALTER TABLE agent_profile_workspaces ADD COLUMN workspace_id TEXT');
    }
    if (!hasColumn(this.db, 'agent_profile_workspaces', 'workspace_service_npub')) {
      this.db.exec('ALTER TABLE agent_profile_workspaces ADD COLUMN workspace_service_npub TEXT');
    }
    if (!hasColumn(this.db, 'agent_profile_workspaces', 'duplicate_callback_marker')) {
      this.db.exec("ALTER TABLE agent_profile_workspaces ADD COLUMN duplicate_callback_marker TEXT NOT NULL DEFAULT 'duplicate callback:'");
    }
    if (!hasColumn(this.db, 'agent_profile_workspaces', 'duplicate_callback_window_seconds')) {
      this.db.exec('ALTER TABLE agent_profile_workspaces ADD COLUMN duplicate_callback_window_seconds INTEGER NOT NULL DEFAULT 180');
    }
    if (!hasColumn(this.db, 'agent_profile_event_policies', 'pipeline_version_policy')) {
      this.db.exec(`ALTER TABLE agent_profile_event_policies ADD COLUMN pipeline_version_policy TEXT NOT NULL DEFAULT '${DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY}'`);
    }
    if (!hasColumn(this.db, 'agent_profile_pipeline_overrides', 'pipeline_version_policy')) {
      this.db.exec(`ALTER TABLE agent_profile_pipeline_overrides ADD COLUMN pipeline_version_policy TEXT NOT NULL DEFAULT '${DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY}'`);
    }
  }
}

export const agentProfilePolicyStore = new AgentProfilePolicyStore();
export { AgentProfilePolicyStore };
