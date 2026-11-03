import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { databaseFile } from '../storage/database-path';

/**
 * Work receipts that Tower minted for this bot's own strict-inbox creations (`work_receipt` on a create or receipted
 * update response). Autopilot never mints or advances a receipt itself: a row exists only because Tower returned it for
 * the exact entity and origin Autopilot sent, and it only ever NARROWS what a session may do (Tower stays the authority;
 * for unclassified bots it is the gate that keeps follow-ups to the bot's own unchanged output).
 */
export type WorkReceiptEntityType = 'doc' | 'task' | 'file' | 'audio_note';
export interface WorkReceipt {
  entityType: WorkReceiptEntityType;
  entityId: string;
  originNotificationId: string;
  rowVersion: number;
  bodySha256Hex: string | null;
  versionId: string | null;
}

const ENTITY_TYPES = new Set<WorkReceiptEntityType>(['doc', 'task', 'file', 'audio_note']);
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Validates a Tower `work_receipt` for exactly the expected entity and origin; anything else is ignored. */
export function parseWorkReceipt(value: unknown, expected: { entityType: WorkReceiptEntityType; entityId?: string | null; originNotificationId: string }): WorkReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const entityType = raw.entity_type as WorkReceiptEntityType;
  const entityId = text(raw.entity_id);
  const origin = text(raw.origin_notification_id);
  const rowVersion = Number(raw.receipt_row_version);
  if (!ENTITY_TYPES.has(entityType) || entityType !== expected.entityType || !entityId || (expected.entityId && entityId !== expected.entityId)) return null;
  if (!origin || origin !== expected.originNotificationId || !Number.isSafeInteger(rowVersion) || rowVersion < 1) return null;
  const sha = text(raw.body_sha256_hex);
  if (sha !== null && !/^[0-9a-f]{64}$/.test(sha)) return null;
  return { entityType, entityId, originNotificationId: origin, rowVersion, bodySha256Hex: sha, versionId: text(raw.version_id) };
}

export class AgentInboxReceiptStore {
  private readonly db: Database;
  private schemaReady = false;

  /** Opening never writes; the table is created on the first recorded receipt. */
  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  private hasSchema(): boolean {
    if (this.schemaReady) return true;
    return Boolean(this.db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'agent_inbox_work_receipts'").get());
  }

  private ensureSchema() {
    if (this.schemaReady) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inbox_work_receipts (
        subscription_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        origin_notification_id TEXT NOT NULL,
        receipt_row_version INTEGER NOT NULL,
        body_sha256_hex TEXT,
        version_id TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (subscription_id, entity_type, entity_id)
      );
    `);
    this.schemaReady = true;
  }

  get(subscriptionId: string, entityType: WorkReceiptEntityType, entityId: string): WorkReceipt | null {
    if (!this.hasSchema()) return null;
    const row = this.db.query('SELECT * FROM agent_inbox_work_receipts WHERE subscription_id = ?1 AND entity_type = ?2 AND entity_id = ?3')
      .get(subscriptionId, entityType, entityId) as Record<string, any> | null;
    return row ? { entityType: row.entity_type, entityId: row.entity_id, originNotificationId: row.origin_notification_id,
      rowVersion: Number(row.receipt_row_version), bodySha256Hex: row.body_sha256_hex ?? null, versionId: row.version_id ?? null } : null;
  }

  /** The receipt Tower minted on create (write-once). */
  recordCreated(subscriptionId: string, receipt: WorkReceipt) {
    this.ensureSchema();
    this.db.query(`INSERT OR IGNORE INTO agent_inbox_work_receipts
      (subscription_id, entity_type, entity_id, origin_notification_id, receipt_row_version, body_sha256_hex, version_id, recorded_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).run(subscriptionId, receipt.entityType, receipt.entityId, receipt.originNotificationId,
      receipt.rowVersion, receipt.bodySha256Hex, receipt.versionId, new Date().toISOString());
  }

  /**
   * After the bot's own receipted update: follow Tower's advanced receipt (compare-and-set on the version it replaced),
   * or drop the receipt when Tower returned none (it no longer matched, so later follow-ups fail closed).
   */
  followUpdate(subscriptionId: string, previous: WorkReceipt, next: WorkReceipt | null) {
    if (!this.hasSchema()) return;
    if (!next) {
      this.db.query('DELETE FROM agent_inbox_work_receipts WHERE subscription_id = ?1 AND entity_type = ?2 AND entity_id = ?3 AND receipt_row_version = ?4')
        .run(subscriptionId, previous.entityType, previous.entityId, previous.rowVersion);
      return;
    }
    this.db.query(`UPDATE agent_inbox_work_receipts SET receipt_row_version = ?5, body_sha256_hex = ?6, version_id = ?7, recorded_at = ?8
      WHERE subscription_id = ?1 AND entity_type = ?2 AND entity_id = ?3 AND receipt_row_version = ?4 AND origin_notification_id = ?9`)
      .run(subscriptionId, previous.entityType, previous.entityId, previous.rowVersion, next.rowVersion, next.bodySha256Hex, next.versionId,
        new Date().toISOString(), previous.originNotificationId);
  }
}

let shared: AgentInboxReceiptStore | null = null;
let testStore: AgentInboxReceiptStore | null = null;
export function agentInboxReceiptStore(): AgentInboxReceiptStore {
  return testStore ?? (shared ??= new AgentInboxReceiptStore());
}
/** Tests only: point the shared receipt store at a disposable database. */
export function setAgentInboxReceiptStoreForTests(store: AgentInboxReceiptStore | null) {
  testStore = store;
}
