import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import {
  DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
  normalisePromptTemplate,
} from './prompt-templates';
import type {
  AgentCapability,
  AgentDefinitionRecord,
} from './types';

const DEFAULT_DB_PATH = databaseFile;

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function serialiseJsonArray(values: string[]): string {
  return JSON.stringify(values);
}

function normaliseDirectChat(record: AgentDefinitionRecord): NonNullable<AgentDefinitionRecord['directChat']> {
  const profile = record.directChat;
  const idleRetention = Number(profile?.idleRetentionMinutes ?? 60);
  return {
    enabled: profile?.enabled ?? false,
    sessionAgent: record.harness?.trim() || profile?.sessionAgent?.trim() || null,
    directory: profile?.directory?.trim() || record.workingDirectory,
    model: record.model?.trim() || profile?.model?.trim() || null,
    idleRetentionMinutes: Number.isFinite(idleRetention) ? Math.max(1, Math.floor(idleRetention)) : 60,
  };
}

function normaliseCapabilities(values: string[]): AgentCapability[] {
  const set = new Set<AgentCapability>();
  for (const value of values) {
    if (value === 'chat_intercept') {
      set.add(value);
      continue;
    }
    if (value === 'task_dispatch') {
      set.add(value);
      continue;
    }
    if (value === 'comment_dispatch') {
      set.add(value);
      continue;
    }
    if (value === 'flow_dispatch') {
      set.add(value);
      continue;
    }
    if (value === 'task_review') {
      set.add(value);
      continue;
    }
    if (value === 'approval_dispatch') {
      set.add(value);
    }
  }
  return set.size > 0 ? [...set] : ['chat_intercept'];
}

function normaliseGroupNpubs(values: string[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  }
  return [...set].sort();
}

class AgentDefinitionStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listForManagerNpub(npub: string): AgentDefinitionRecord[] {
    return this.listWhere('managed_by_npub = ?1', [npub]);
  }

  listByWorkspaceAndBot(workspaceOwnerNpub: string, botNpub: string): AgentDefinitionRecord[] {
    const subscriptionAgent = this.getByBotNpub(botNpub);
    if (!subscriptionAgent?.managedByNpub) {
      return subscriptionAgent ? [subscriptionAgent] : [];
    }
    return this.listWhere(
      `managed_by_npub = ?1
       AND (workspace_owner_npub = ?2 OR workspace_owner_npub = ?1 OR bot_npub = ?3)`,
      [subscriptionAgent.managedByNpub, workspaceOwnerNpub, botNpub],
    );
  }

  getByAgentId(agentId: string): AgentDefinitionRecord | null {
    return this.getWhere('agent_id = ?1', [agentId]);
  }

  getByBotNpub(botNpub: string): AgentDefinitionRecord | null {
    return this.getWhere('bot_npub = ?1', [botNpub]);
  }

  getDefaultForManagerNpub(npub: string): AgentDefinitionRecord | null {
    const binding = this.db.query(
      `SELECT agent_id
       FROM agent_definition_defaults
       WHERE managed_by_npub = ?1
       LIMIT 1`,
    ).get(npub) as { agent_id?: string } | null;
    if (!binding?.agent_id) return null;
    const agent = this.getByAgentId(binding.agent_id);
    return agent?.managedByNpub === npub && agent.enabled && agent.archived !== true ? agent : null;
  }

  setDefaultForManagerNpub(npub: string, agentId: string): AgentDefinitionRecord {
    const agent = this.getByAgentId(agentId);
    if (!agent || agent.managedByNpub !== npub) {
      throw new Error('Agent profile not found');
    }
    if (!agent.enabled || agent.archived === true) {
      throw new Error('The default agent profile must be enabled and active');
    }
    const now = new Date().toISOString();
    this.db.query(
      `INSERT INTO agent_definition_defaults (managed_by_npub, agent_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(managed_by_npub) DO UPDATE SET
         agent_id = excluded.agent_id,
         updated_at = excluded.updated_at`,
    ).run(npub, agentId, now);
    return agent;
  }

  save(record: AgentDefinitionRecord): AgentDefinitionRecord {
    const identityOwner = this.getByBotNpub(record.botNpub);
    if (identityOwner && identityOwner.agentId !== record.agentId) {
      throw new Error(`Agent identity ${record.botNpub} is already bound to profile ${identityOwner.agentId}.`);
    }
    const statement = this.db.query(
      `INSERT INTO agent_definitions (
         agent_id, label, bot_npub, workspace_owner_npub, group_npubs_json,
         working_directory, harness, model, archived, public_profile_json, capabilities_json, chat_prompt_template, task_prompt_template,
         flow_dispatch_prompt_template, task_review_prompt_template, approval_dispatch_prompt_template,
         direct_chat_json, enabled, created_at, updated_at, managed_by_npub, public_profile_refresh_json
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
       )
       ON CONFLICT(agent_id) DO UPDATE SET
         label = excluded.label,
         bot_npub = excluded.bot_npub,
         workspace_owner_npub = excluded.workspace_owner_npub,
         group_npubs_json = excluded.group_npubs_json,
         working_directory = excluded.working_directory,
         harness = excluded.harness,
         model = excluded.model,
         archived = excluded.archived,
         public_profile_json = excluded.public_profile_json,
         capabilities_json = excluded.capabilities_json,
         chat_prompt_template = excluded.chat_prompt_template,
         task_prompt_template = excluded.task_prompt_template,
         flow_dispatch_prompt_template = excluded.flow_dispatch_prompt_template,
         task_review_prompt_template = excluded.task_review_prompt_template,
         approval_dispatch_prompt_template = excluded.approval_dispatch_prompt_template,
         direct_chat_json = excluded.direct_chat_json,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at,
         managed_by_npub = excluded.managed_by_npub,
         public_profile_refresh_json = excluded.public_profile_refresh_json`,
    );
    const bindings: SQLQueryBindings[] = [
      record.agentId,
      record.label,
      record.botNpub,
      record.workspaceOwnerNpub,
      serialiseJsonArray(record.groupNpubs),
      record.workingDirectory,
      record.harness ?? null,
      record.model ?? null,
      record.archived ? 1 : 0,
      JSON.stringify(record.publicProfile ?? { name: record.label, picture: null, about: null, nip05: null }),
      serialiseJsonArray(record.capabilities),
      normalisePromptTemplate(record.chatPromptTemplate, DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.taskPromptTemplate, DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.flowDispatchPromptTemplate, DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.taskReviewPromptTemplate, DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.approvalDispatchPromptTemplate, DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE),
      record.directChat ? JSON.stringify(normaliseDirectChat(record)) : null,
      record.enabled ? 1 : 0,
      record.createdAt,
      record.updatedAt,
      record.managedByNpub,
      JSON.stringify(record.publicProfileRefresh ?? {
        lastAttemptAt: null, lastSuccessAt: null, sourceEventId: null,
        sourceEventCreatedAt: null, result: null, error: null,
      }),
    ];
    statement.run(...bindings);
    const saved = this.getByAgentId(record.agentId) ?? record;
    if (saved.managedByNpub && saved.enabled && saved.archived !== true) {
      this.ensureDefaultForManager(saved.managedByNpub, saved.agentId);
    }
    return saved;
  }

  updatePublicProfileSnapshot(
    agentId: string,
    publicProfile: NonNullable<AgentDefinitionRecord['publicProfile']>,
    refresh: NonNullable<AgentDefinitionRecord['publicProfileRefresh']>,
  ): AgentDefinitionRecord | null {
    this.db.query(
      `UPDATE agent_definitions
       SET public_profile_json = ?2, public_profile_refresh_json = ?3
       WHERE agent_id = ?1`,
    ).run(agentId, JSON.stringify(publicProfile), JSON.stringify(refresh));
    return this.getByAgentId(agentId);
  }

  updatePublicProfileRefresh(
    agentId: string,
    refresh: NonNullable<AgentDefinitionRecord['publicProfileRefresh']>,
  ): AgentDefinitionRecord | null {
    this.db.query(
      `UPDATE agent_definitions SET public_profile_refresh_json = ?2 WHERE agent_id = ?1`,
    ).run(agentId, JSON.stringify(refresh));
    return this.getByAgentId(agentId);
  }

  delete(agentId: string): boolean {
    const existing = this.getByAgentId(agentId);
    if (existing?.managedByNpub) {
      this.db.query(
        'DELETE FROM agent_definition_defaults WHERE managed_by_npub = ?1 AND agent_id = ?2',
      ).run(existing.managedByNpub, agentId);
    }
    const result = this.db.query('DELETE FROM agent_definitions WHERE agent_id = ?1').run(agentId);
    if (result.changes > 0 && existing?.managedByNpub) {
      const replacement = this.listForManagerNpub(existing.managedByNpub)
        .filter((agent) => agent.enabled && agent.archived !== true)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.agentId.localeCompare(right.agentId))[0];
      if (replacement) this.ensureDefaultForManager(existing.managedByNpub, replacement.agentId);
    }
    return result.changes > 0;
  }

  private ensureDefaultForManager(npub: string, agentId: string): void {
    const now = new Date().toISOString();
    this.db.query(
      `INSERT OR IGNORE INTO agent_definition_defaults (
         managed_by_npub, agent_id, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?3)`,
    ).run(npub, agentId, now);
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): AgentDefinitionRecord[] {
    return this.db
      .query(
        `SELECT
           agent_id,
           label,
           bot_npub,
           workspace_owner_npub,
           group_npubs_json,
           working_directory,
           harness,
           model,
           archived,
           public_profile_json,
           capabilities_json,
           chat_prompt_template,
           task_prompt_template,
           flow_dispatch_prompt_template,
           task_review_prompt_template,
           approval_dispatch_prompt_template,
           direct_chat_json,
           enabled,
           created_at,
           updated_at,
           managed_by_npub,
           public_profile_refresh_json
         FROM agent_definitions
         WHERE ${whereClause}
         ORDER BY updated_at DESC, agent_id ASC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | number | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): AgentDefinitionRecord | null {
    const row = this.db
      .query(
        `SELECT
           agent_id,
           label,
           bot_npub,
           workspace_owner_npub,
           group_npubs_json,
           working_directory,
           harness,
           model,
           archived,
           public_profile_json,
           capabilities_json,
           chat_prompt_template,
           task_prompt_template,
           flow_dispatch_prompt_template,
           task_review_prompt_template,
           approval_dispatch_prompt_template,
           direct_chat_json,
           enabled,
           created_at,
           updated_at,
           managed_by_npub,
           public_profile_refresh_json
         FROM agent_definitions
         WHERE ${whereClause}
         ORDER BY updated_at DESC, agent_id ASC
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | number | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | number | null>): AgentDefinitionRecord {
    return {
      agentId: String(row.agent_id ?? ''),
      label: String(row.label ?? ''),
      botNpub: String(row.bot_npub ?? ''),
      workspaceOwnerNpub: String(row.workspace_owner_npub ?? ''),
      groupNpubs: normaliseGroupNpubs(parseJsonArray(typeof row.group_npubs_json === 'string' ? row.group_npubs_json : null)),
      workingDirectory: String(row.working_directory ?? ''),
      harness: typeof row.harness === 'string' && row.harness.trim() ? row.harness.trim() : null,
      model: typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null,
      archived: Number(row.archived ?? 0) === 1,
      publicProfile: (() => {
        try {
          const value = JSON.parse(typeof row.public_profile_json === 'string' ? row.public_profile_json : '{}') as Record<string, unknown>;
          return {
            name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : String(row.label ?? ''),
            picture: typeof value.picture === 'string' && value.picture.trim() ? value.picture.trim() : null,
            about: typeof value.about === 'string' && value.about.trim() ? value.about.trim() : null,
            nip05: typeof value.nip05 === 'string' && value.nip05.trim() ? value.nip05.trim() : null,
          };
        } catch {
          return { name: String(row.label ?? ''), picture: null, about: null, nip05: null };
        }
      })(),
      publicProfileRefresh: (() => {
        const empty = {
          lastAttemptAt: null, lastSuccessAt: null, sourceEventId: null,
          sourceEventCreatedAt: null, result: null, error: null,
        } satisfies NonNullable<AgentDefinitionRecord['publicProfileRefresh']>;
        try {
          const value = JSON.parse(typeof row.public_profile_refresh_json === 'string'
            ? row.public_profile_refresh_json : '{}') as Record<string, unknown>;
          const result = value.result;
          return {
            lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
            lastSuccessAt: typeof value.lastSuccessAt === 'string' ? value.lastSuccessAt : null,
            sourceEventId: typeof value.sourceEventId === 'string' ? value.sourceEventId : null,
            sourceEventCreatedAt: typeof value.sourceEventCreatedAt === 'number' ? value.sourceEventCreatedAt : null,
            result: result === 'hydrated' || result === 'unchanged' || result === 'published' || result === 'failed'
              ? result : null,
            error: typeof value.error === 'string' ? value.error : null,
          };
        } catch {
          return empty;
        }
      })(),
      directChat: (() => {
        if (typeof row.direct_chat_json !== 'string' || row.direct_chat_json.trim().length === 0) return undefined;
        try {
          const parsed = JSON.parse(row.direct_chat_json) as Record<string, unknown>;
          return normaliseDirectChat({
            workingDirectory: String(row.working_directory ?? ''),
            directChat: {
              enabled: parsed.enabled === true,
              sessionAgent: typeof parsed.sessionAgent === 'string' ? parsed.sessionAgent : null,
              directory: typeof parsed.directory === 'string' ? parsed.directory : '',
              model: typeof parsed.model === 'string' ? parsed.model : null,
              idleRetentionMinutes: Number(parsed.idleRetentionMinutes ?? 60),
            },
          } as AgentDefinitionRecord);
        } catch {
          return undefined;
        }
      })(),
      capabilities: normaliseCapabilities(parseJsonArray(typeof row.capabilities_json === 'string' ? row.capabilities_json : null)),
      chatPromptTemplate: normalisePromptTemplate(
        typeof row.chat_prompt_template === 'string' ? row.chat_prompt_template : null,
        DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
      ),
      taskPromptTemplate: normalisePromptTemplate(
        typeof row.task_prompt_template === 'string' ? row.task_prompt_template : null,
        DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
      ),
      flowDispatchPromptTemplate: normalisePromptTemplate(
        typeof row.flow_dispatch_prompt_template === 'string' ? row.flow_dispatch_prompt_template : null,
        DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
      ),
      taskReviewPromptTemplate: normalisePromptTemplate(
        typeof row.task_review_prompt_template === 'string' ? row.task_review_prompt_template : null,
        DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
      ),
      approvalDispatchPromptTemplate: normalisePromptTemplate(
        typeof row.approval_dispatch_prompt_template === 'string' ? row.approval_dispatch_prompt_template : null,
        DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
      ),
      enabled: Number(row.enabled ?? 0) === 1,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      managedByNpub: typeof row.managed_by_npub === 'string' ? row.managed_by_npub : null,
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_definitions (
        agent_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        workspace_owner_npub TEXT NOT NULL,
        group_npubs_json TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        harness TEXT,
        model TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        public_profile_json TEXT NOT NULL DEFAULT '{}',
        capabilities_json TEXT NOT NULL,
        chat_prompt_template TEXT,
        task_prompt_template TEXT,
        flow_dispatch_prompt_template TEXT,
        task_review_prompt_template TEXT,
        approval_dispatch_prompt_template TEXT,
        direct_chat_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        managed_by_npub TEXT,
        public_profile_refresh_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_agent_definitions_manager
        ON agent_definitions(managed_by_npub, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_definitions_workspace_bot
        ON agent_definitions(workspace_owner_npub, bot_npub, enabled);

      CREATE TABLE IF NOT EXISTS agent_definition_defaults (
        managed_by_npub TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

    `);
    const columns = this.db.query('PRAGMA table_info(agent_definitions)').all() as Array<{ name?: string }>;
    const hasChatTemplate = columns.some((row) => row.name === 'chat_prompt_template');
    const hasTaskTemplate = columns.some((row) => row.name === 'task_prompt_template');
    const hasFlowDispatchTemplate = columns.some((row) => row.name === 'flow_dispatch_prompt_template');
    const hasTaskReviewTemplate = columns.some((row) => row.name === 'task_review_prompt_template');
    const hasApprovalDispatchTemplate = columns.some((row) => row.name === 'approval_dispatch_prompt_template');
    const hasDirectChat = columns.some((row) => row.name === 'direct_chat_json');
    const hasHarness = columns.some((row) => row.name === 'harness');
    const hasModel = columns.some((row) => row.name === 'model');
    const hasArchived = columns.some((row) => row.name === 'archived');
    const hasPublicProfile = columns.some((row) => row.name === 'public_profile_json');
    const hasPublicProfileRefresh = columns.some((row) => row.name === 'public_profile_refresh_json');
    if (!hasChatTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN chat_prompt_template TEXT');
    }
    if (!hasTaskTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN task_prompt_template TEXT');
    }
    if (!hasFlowDispatchTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN flow_dispatch_prompt_template TEXT');
    }
    if (!hasTaskReviewTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN task_review_prompt_template TEXT');
    }
    if (!hasApprovalDispatchTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN approval_dispatch_prompt_template TEXT');
    }
    if (!hasDirectChat) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN direct_chat_json TEXT');
    }
    if (!hasHarness) this.db.exec('ALTER TABLE agent_definitions ADD COLUMN harness TEXT');
    if (!hasModel) this.db.exec('ALTER TABLE agent_definitions ADD COLUMN model TEXT');
    if (!hasArchived) this.db.exec('ALTER TABLE agent_definitions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    if (!hasPublicProfile) this.db.exec("ALTER TABLE agent_definitions ADD COLUMN public_profile_json TEXT NOT NULL DEFAULT '{}'");
    if (!hasPublicProfileRefresh) this.db.exec("ALTER TABLE agent_definitions ADD COLUMN public_profile_refresh_json TEXT NOT NULL DEFAULT '{}'");
    this.db.exec(`
      INSERT OR IGNORE INTO agent_definition_defaults (
        managed_by_npub, agent_id, created_at, updated_at
      )
      SELECT candidate.managed_by_npub, candidate.agent_id, candidate.created_at, candidate.updated_at
      FROM agent_definitions AS candidate
      WHERE candidate.managed_by_npub IS NOT NULL
        AND candidate.enabled = 1
        AND candidate.archived = 0
        AND candidate.agent_id = (
          SELECT eligible.agent_id
          FROM agent_definitions AS eligible
          WHERE eligible.managed_by_npub = candidate.managed_by_npub
            AND eligible.enabled = 1
            AND eligible.archived = 0
          ORDER BY eligible.created_at ASC, eligible.agent_id ASC
          LIMIT 1
        );
    `);
  }
}

export const agentDefinitionStore = new AgentDefinitionStore();
export { AgentDefinitionStore };
