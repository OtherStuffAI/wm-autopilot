import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { nip19 } from 'nostr-tools';
import { databaseFile } from '../storage/database-path';

/**
 * Operator-set learning grant for a managed agent on one Tower: the existing Space learning delegation (granted by the
 * learner to the agent) that the agent's learning requests name explicitly with `x-learning-grant-id` and a signed
 * `learning_grant_id` NIP-98 tag. It is set only through the manager API, never from chat, pipeline input or a model.
 * One grant per agent bot per Tower, matching Tower's implicit single-delegation learner selection it replaces.
 * Autopilot grants nothing here: Tower validates the delegation (grantee = signer, unrevoked, read/write) on every call.
 */
export interface LearningGrantMapping {
  agentId: string;
  botNpub: string;
  towerOrigin: string;
  workspaceId: string;
  grantId: string;
  learnerNpub: string | null;
  managedByNpub: string;
  updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validLearningGrantId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value.trim());
}

export function validLearnerNpub(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return nip19.decode(value.trim()).type === 'npub';
  } catch {
    return false;
  }
}

/** Tower origin (scheme://host[:port]) of a backend URL; null when it is not an absolute http(s) URL. */
export function towerOriginOf(url: string | null | undefined): string | null {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export class LearningGrantMappingStore {
  private readonly db: Database;
  private schemaReady = false;

  /** Opening never writes; the table is created on the first saved mapping. */
  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  private hasSchema(): boolean {
    if (this.schemaReady) return true;
    return Boolean(this.db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'learning_grant_mappings'").get());
  }

  private ensureSchema() {
    if (this.schemaReady) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS learning_grant_mappings (
      bot_npub TEXT NOT NULL, tower_origin TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      grant_id TEXT NOT NULL, learner_npub TEXT, managed_by_npub TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (bot_npub, tower_origin)
    )`);
    this.schemaReady = true;
  }

  private map(row: Record<string, any> | null): LearningGrantMapping | null {
    return row ? { agentId: row.agent_id, botNpub: row.bot_npub, towerOrigin: row.tower_origin, workspaceId: row.workspace_id,
      grantId: row.grant_id, learnerNpub: row.learner_npub ?? null, managedByNpub: row.managed_by_npub, updatedAt: row.updated_at } : null;
  }

  /** The grant a bot names on one Tower (the only lookup request paths use). */
  forBot(botNpub: string, towerOrigin: string | null): LearningGrantMapping | null {
    if (!towerOrigin || !this.hasSchema()) return null;
    return this.map(this.db.query('SELECT * FROM learning_grant_mappings WHERE bot_npub = ?1 AND tower_origin = ?2').get(botNpub, towerOrigin) as Record<string, any> | null);
  }

  listForAgent(agentId: string): LearningGrantMapping[] {
    if (!this.hasSchema()) return [];
    return (this.db.query('SELECT * FROM learning_grant_mappings WHERE agent_id = ?1 ORDER BY tower_origin').all(agentId) as Array<Record<string, any>>)
      .map((row) => this.map(row)!);
  }

  save(mapping: Omit<LearningGrantMapping, 'updatedAt'>): LearningGrantMapping {
    this.ensureSchema();
    this.db.query(`INSERT INTO learning_grant_mappings (bot_npub, tower_origin, agent_id, workspace_id, grant_id, learner_npub, managed_by_npub, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT (bot_npub, tower_origin) DO UPDATE SET agent_id = excluded.agent_id, workspace_id = excluded.workspace_id, grant_id = excluded.grant_id,
        learner_npub = excluded.learner_npub, managed_by_npub = excluded.managed_by_npub, updated_at = excluded.updated_at`)
      .run(mapping.botNpub, mapping.towerOrigin, mapping.agentId, mapping.workspaceId, mapping.grantId.toLowerCase(), mapping.learnerNpub,
        mapping.managedByNpub, new Date().toISOString());
    return this.forBot(mapping.botNpub, mapping.towerOrigin)!;
  }

  remove(agentId: string, towerOrigin: string): boolean {
    if (!this.hasSchema()) return false;
    return this.db.query('DELETE FROM learning_grant_mappings WHERE agent_id = ?1 AND tower_origin = ?2').run(agentId, towerOrigin).changes > 0;
  }
}

let shared: LearningGrantMappingStore | null = null;
let testStore: LearningGrantMappingStore | null = null;
export function learningGrantMappingStore(): LearningGrantMappingStore {
  return testStore ?? (shared ??= new LearningGrantMappingStore());
}
/** Tests only: point the shared mapping store at a disposable database. */
export function setLearningGrantMappingStoreForTests(store: LearningGrantMappingStore | null) {
  testStore = store;
}
