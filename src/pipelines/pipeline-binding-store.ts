import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Database } from "bun:sqlite";

export type PipelineAvailabilityMode = "implicit_all" | "explicit";
export type PipelineDefaultMode = "implicit_library" | "explicit";
export type PipelineOverrideKind = "workspace" | "scope" | "channel";

export interface AgentPipelineOverride {
  agentId: string;
  kind: PipelineOverrideKind;
  contextId: string;
  pipelineDefinitionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedAgentPipelineBinding {
  pipelineDefinitionId: string | null;
  source: "channel" | "scope" | "workspace" | "default" | "none";
  contextId: string | null;
}

const DEFAULT_DB_PATH = "data/pipeline-bindings.sqlite";

function now(): string {
  return new Date().toISOString();
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export class PipelineBindingStore {
  readonly path: string;
  private readonly db: Database;

  constructor(path = process.env.WINGMEN_PIPELINE_BINDINGS_DB || DEFAULT_DB_PATH) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  getAvailabilityMode(agentId: string): PipelineAvailabilityMode {
    const row = this.db.query<{ mode: PipelineAvailabilityMode }, [string]>(
      "SELECT mode FROM agent_pipeline_binding_modes WHERE agent_id = ?1",
    ).get(requireText(agentId, "agentId"));
    return row?.mode ?? "implicit_all";
  }

  setAvailable(agentId: string, pipelineDefinitionIds: string[]): void {
    const normalizedAgentId = requireText(agentId, "agentId");
    const definitionIds = Array.from(new Set(pipelineDefinitionIds.map((id) => requireText(id, "pipelineDefinitionId"))));
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO agent_pipeline_binding_modes (agent_id, mode, updated_at)
         VALUES (?1, 'explicit', ?2)
         ON CONFLICT(agent_id) DO UPDATE SET mode = 'explicit', updated_at = excluded.updated_at`,
        [normalizedAgentId, timestamp],
      );
      this.db.run("DELETE FROM agent_pipeline_availability WHERE agent_id = ?1", [normalizedAgentId]);
      for (const definitionId of definitionIds) {
        this.db.run(
          `INSERT INTO agent_pipeline_availability (agent_id, pipeline_definition_id, created_at)
           VALUES (?1, ?2, ?3)`,
          [normalizedAgentId, definitionId, timestamp],
        );
      }
    })();
  }

  useImplicitAvailability(agentId: string): void {
    const normalizedAgentId = requireText(agentId, "agentId");
    this.db.transaction(() => {
      this.db.run("DELETE FROM agent_pipeline_availability WHERE agent_id = ?1", [normalizedAgentId]);
      this.db.run("DELETE FROM agent_pipeline_binding_modes WHERE agent_id = ?1", [normalizedAgentId]);
    })();
  }

  listAvailableIds(agentId: string): string[] {
    return this.db.query<{ pipelineDefinitionId: string }, [string]>(
      `SELECT pipeline_definition_id AS pipelineDefinitionId
       FROM agent_pipeline_availability WHERE agent_id = ?1 ORDER BY pipeline_definition_id`,
    ).all(requireText(agentId, "agentId")).map((row) => row.pipelineDefinitionId);
  }

  setDefaults(agentId: string, pipelineDefinitionIds: string[]): void {
    const normalizedAgentId = requireText(agentId, "agentId");
    const definitionIds = Array.from(new Set(pipelineDefinitionIds.map((id) => requireText(id, "pipelineDefinitionId"))));
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO agent_pipeline_default_modes (agent_id, mode, updated_at)
         VALUES (?1, 'explicit', ?2)
         ON CONFLICT(agent_id) DO UPDATE SET updated_at = excluded.updated_at`,
        [normalizedAgentId, timestamp],
      );
      this.db.run("DELETE FROM agent_pipeline_defaults WHERE agent_id = ?1", [normalizedAgentId]);
      for (const definitionId of definitionIds) {
        this.db.run(
          `INSERT INTO agent_pipeline_defaults (agent_id, pipeline_definition_id, created_at)
           VALUES (?1, ?2, ?3)`,
          [normalizedAgentId, definitionId, timestamp],
        );
      }
    })();
  }

  listDefaultIds(agentId: string): string[] {
    return this.db.query<{ pipelineDefinitionId: string }, [string]>(
      `SELECT pipeline_definition_id AS pipelineDefinitionId
       FROM agent_pipeline_defaults WHERE agent_id = ?1 ORDER BY pipeline_definition_id`,
    ).all(requireText(agentId, "agentId")).map((row) => row.pipelineDefinitionId);
  }

  getDefaultMode(agentId: string): PipelineDefaultMode {
    const row = this.db.query<{ mode: "explicit" }, [string]>(
      "SELECT mode FROM agent_pipeline_default_modes WHERE agent_id = ?1",
    ).get(requireText(agentId, "agentId"));
    return row ? "explicit" : "implicit_library";
  }

  setOverride(input: {
    agentId: string;
    kind: PipelineOverrideKind;
    contextId: string;
    pipelineDefinitionId: string;
  }): AgentPipelineOverride {
    const agentId = requireText(input.agentId, "agentId");
    const contextId = requireText(input.contextId, "contextId");
    const definitionId = requireText(input.pipelineDefinitionId, "pipelineDefinitionId");
    const timestamp = now();
    this.db.run(
      `INSERT INTO agent_pipeline_overrides (
         agent_id, context_kind, context_id, pipeline_definition_id, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(agent_id, context_kind, context_id) DO UPDATE SET
         pipeline_definition_id = excluded.pipeline_definition_id,
         updated_at = excluded.updated_at`,
      [agentId, input.kind, contextId, definitionId, timestamp],
    );
    return this.getOverride(agentId, input.kind, contextId)!;
  }

  removeOverride(agentId: string, kind: PipelineOverrideKind, contextId: string): boolean {
    const result = this.db.run(
      `DELETE FROM agent_pipeline_overrides
       WHERE agent_id = ?1 AND context_kind = ?2 AND context_id = ?3`,
      [requireText(agentId, "agentId"), kind, requireText(contextId, "contextId")],
    );
    return result.changes > 0;
  }

  listOverrides(agentId: string): AgentPipelineOverride[] {
    return this.db.query<AgentPipelineOverride, [string]>(
      `SELECT agent_id AS agentId, context_kind AS kind, context_id AS contextId,
              pipeline_definition_id AS pipelineDefinitionId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM agent_pipeline_overrides WHERE agent_id = ?1
       ORDER BY CASE context_kind WHEN 'workspace' THEN 1 WHEN 'scope' THEN 2 ELSE 3 END, context_id`,
    ).all(requireText(agentId, "agentId"));
  }

  resolve(input: { agentId: string; workspaceId?: string | null; scopeId?: string | null; channelId?: string | null }): ResolvedAgentPipelineBinding {
    const candidates: Array<[PipelineOverrideKind, string | null | undefined]> = [
      ["channel", input.channelId],
      ["scope", input.scopeId],
      ["workspace", input.workspaceId],
    ];
    for (const [kind, contextId] of candidates) {
      if (!contextId) continue;
      const override = this.getOverride(input.agentId, kind, contextId);
      if (override) return { pipelineDefinitionId: override.pipelineDefinitionId, source: kind, contextId };
    }
    const defaultId = this.listDefaultIds(input.agentId)[0] ?? null;
    return defaultId
      ? { pipelineDefinitionId: defaultId, source: "default", contextId: null }
      : { pipelineDefinitionId: null, source: "none", contextId: null };
  }

  private getOverride(agentId: string, kind: PipelineOverrideKind, contextId: string): AgentPipelineOverride | null {
    return this.db.query<AgentPipelineOverride, [string, PipelineOverrideKind, string]>(
      `SELECT agent_id AS agentId, context_kind AS kind, context_id AS contextId,
              pipeline_definition_id AS pipelineDefinitionId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM agent_pipeline_overrides
       WHERE agent_id = ?1 AND context_kind = ?2 AND context_id = ?3`,
    ).get(requireText(agentId, "agentId"), kind, requireText(contextId, "contextId")) ?? null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_pipeline_binding_modes (
        agent_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('explicit')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_pipeline_availability (
        agent_id TEXT NOT NULL,
        pipeline_definition_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, pipeline_definition_id)
      );
      CREATE TABLE IF NOT EXISTS agent_pipeline_defaults (
        agent_id TEXT NOT NULL,
        pipeline_definition_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, pipeline_definition_id)
      );
      CREATE TABLE IF NOT EXISTS agent_pipeline_default_modes (
        agent_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('explicit')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_pipeline_overrides (
        agent_id TEXT NOT NULL,
        context_kind TEXT NOT NULL CHECK (context_kind IN ('workspace', 'scope', 'channel')),
        context_id TEXT NOT NULL,
        pipeline_definition_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, context_kind, context_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_pipeline_availability_agent
        ON agent_pipeline_availability(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_pipeline_defaults_agent
        ON agent_pipeline_defaults(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_pipeline_overrides_agent
        ON agent_pipeline_overrides(agent_id);
    `);
  }
}
