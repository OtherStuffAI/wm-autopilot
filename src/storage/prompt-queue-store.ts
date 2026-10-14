import { supersedeDedicatedPending } from "./dedicated-queue-recovery.ts";
import { mapQueuedPrompt } from "./prompt-queue-row";
import { prunePromptQueueHistory } from "./prompt-queue-retention";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  content: string;
  timestamp: string;
  order: number;
  type: string | null;
  dedupeKey: string | null;
  payload: Record<string, unknown> | null;
  revision: string;
  state: "pending" | "claimed" | "dispatched" | "handled" | "superseded";
  handledAt: string | null;
  handledBy: string | null;
  handledReason: string | null;
  claimToken: string | null;
  deliveryState?: string | null;
  deliveryId?: string | null;
  deliveryUpdatedAt?: string | null;
}

export interface QueuedPromptInput {
  content: string;
  type?: string;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
}

export class PromptQueueStore {
  private db: Database;
  private insertPrompt: any;
  private getQueue: any;
  private updatePrompt: any;
  private deletePrompt: any;
  private getNextPrompt: any;
  private hasPromptByContentStmt: any;
  private hasTaskDispatchPromptStmt: any;
  private countPrompts: any;
  private clearQueue: any;

  constructor(databasePath: string) {
    const directory = dirname(databasePath);
    mkdirSync(directory, { recursive: true });
    
    this.db = new Database(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.transaction(() => this.initialise()).immediate();
    for (const row of this.db.query("SELECT DISTINCT session_id FROM prompt_queue").all() as Array<{ session_id: string }>) {
      this.pruneHistory(row.session_id);
    }
    
    this.insertPrompt = this.db.prepare(`
      INSERT OR IGNORE INTO prompt_queue
        (id, session_id, content, timestamp, queue_order, type, dedupe_key, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    this.getQueue = this.db.prepare(`
      SELECT * FROM prompt_queue
      WHERE session_id = ? AND state IN ('pending', 'claimed')
      ORDER BY queue_order ASC
    `);
    
    this.updatePrompt = this.db.prepare(`
      UPDATE prompt_queue
      SET content = ?, revision = revision + 1
      WHERE id = ? AND session_id = ? AND state = 'pending'
    `);
    
    this.deletePrompt = this.db.prepare(`
      DELETE FROM prompt_queue
      WHERE id = ? AND session_id = ? AND state = 'pending'
    `);
    
    this.getNextPrompt = this.db.prepare(`
      SELECT * FROM prompt_queue
      WHERE session_id = ? AND state IN ('pending', 'claimed')
      ORDER BY queue_order ASC
      LIMIT 1
    `);

    this.hasPromptByContentStmt = this.db.prepare(`
      SELECT 1
      FROM prompt_queue
      WHERE session_id = ? AND state IN ('pending', 'claimed') AND content = ?
      LIMIT 1
    `);

    this.hasTaskDispatchPromptStmt = this.db.prepare(`
      SELECT 1
      FROM prompt_queue
      WHERE session_id = ? AND state IN ('pending', 'claimed')
        AND instr(content, 'Agent work dispatch.') > 0
        AND instr(content, ?) > 0
      LIMIT 1
    `);
    
    this.countPrompts = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM prompt_queue
      WHERE session_id = ? AND state IN ('pending', 'claimed')
    `);
    
    this.clearQueue = this.db.prepare(`
      DELETE FROM prompt_queue
      WHERE session_id = ? AND state = 'pending'
    `);
  }

  addPrompt(sessionId: string, input: QueuedPromptInput): QueuedPrompt | null {
    this.pruneHistory(sessionId);
    const content = input.content?.trim() ?? "";
    if (!content) {
      return null;
    }
    
    // Check current count to enforce 21 limit
    const countResult = this.countPrompts.get(sessionId) as { count: number } | undefined;
    const currentCount = countResult?.count || 0;
    
    if (currentCount >= 21) {
      throw new Error("Queue limit reached (21 prompts maximum)");
    }
    
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const order = currentCount + 1;
    
    const result = this.insertPrompt.run(
      id,
      sessionId,
      content,
      timestamp,
      order,
      input.type?.trim() || null,
      input.dedupeKey?.trim() || null,
      input.payload ? JSON.stringify(input.payload) : null,
    );
    if (result.changes === 0) {
      return null;
    }
    
    return {
      id,
      sessionId,
      content,
      timestamp,
      order,
      type: input.type?.trim() || null,
      dedupeKey: input.dedupeKey?.trim() || null,
      payload: input.payload ?? null,
      revision: "1", state: "pending", handledAt: null, handledBy: null,
      handledReason: null, claimToken: null,
    };
  }

  getSessionQueue(sessionId: string): QueuedPrompt[] {
    this.pruneHistory(sessionId);
    return (this.getQueue.all(sessionId) as Array<Record<string, unknown>>).map(this.mapPrompt);
  }

  updatePromptContent(sessionId: string, promptId: string, content: string): boolean {
    const trimmedContent = content?.trim() ?? "";
    if (!trimmedContent) {
      return false;
    }
    
    const result = this.updatePrompt.run(trimmedContent, promptId, sessionId);
    return result.changes > 0;
  }

  deletePromptById(sessionId: string, promptId: string): boolean {
    const result = this.deletePrompt.run(promptId, sessionId);
    if (result.changes > 0) {
      // Reorder remaining prompts to maintain sequential order
      this.reorderQueue(sessionId);
      return true;
    }
    return false;
  }

  getNextQueuedPrompt(sessionId: string): QueuedPrompt | null {
    const result = this.getNextPrompt.get(sessionId) as Record<string, unknown> | undefined;
    return result ? this.mapPrompt(result) : null;
  }

  removeNextPrompt(sessionId: string): QueuedPrompt | null {
    return this.db.transaction(() => {
      const next = this.getNextQueuedPrompt(sessionId);
      return next?.state === "pending" && this.deletePromptById(sessionId, next.id) ? next : null;
    }).immediate();
  }

  getQueueCount(sessionId: string): number {
    const result = this.countPrompts.get(sessionId) as { count: number } | undefined;
    return result?.count || 0;
  }

  hasQueuedPrompt(sessionId: string, content: string): boolean {
    const trimmedContent = content?.trim() ?? "";
    if (!trimmedContent) {
      return false;
    }
    return Boolean(this.hasPromptByContentStmt.get(sessionId, trimmedContent));
  }

  hasQueuedTaskDispatchPrompt(sessionId: string, taskId: string): boolean {
    const trimmedTaskId = taskId?.trim() ?? "";
    if (!trimmedTaskId) {
      return false;
    }
    return Boolean(this.hasTaskDispatchPromptStmt.get(sessionId, `Task id: ${trimmedTaskId}`));
  }

  clearSessionQueue(sessionId: string): void {
    this.clearQueue.run(sessionId);
  }

  /** Internal dedicated-builder operation. Preserve unsent content as superseded,
   * never call it handled and never alter a claimed delivery. */
  supersedeDedicatedPending(sessionId: string, bindingId: string): number {
    return supersedeDedicatedPending(this.db, sessionId, bindingId);
  }

  rebindSession(sourceSessionId: string, targetSessionId: string): number {
    if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return 0;
    const result = this.db.query("UPDATE prompt_queue SET session_id = ?1 WHERE session_id = ?2")
      .run(targetSessionId, sourceSessionId);
    return result.changes;
  }

  deletePromptsByType(type: string): number {
    const normalizedType = type.trim();
    if (!normalizedType) return 0;
    const sessionRows = this.db.query(`SELECT DISTINCT session_id FROM prompt_queue WHERE type = ? AND state = 'pending'`)
      .all(normalizedType) as Array<{ session_id: string }>;
    const result = this.db.query(`DELETE FROM prompt_queue WHERE type = ? AND state = 'pending'`).run(normalizedType);
    for (const row of sessionRows) this.reorderQueue(row.session_id);
    return result.changes;
  }

  getHandledPrompts(sessionId: string): QueuedPrompt[] {
    this.pruneHistory(sessionId);
    return (this.db.query("SELECT * FROM prompt_queue WHERE session_id = ? AND state = 'handled' AND content != '' ORDER BY handled_at DESC, id LIMIT 100")
      .all(sessionId) as Array<Record<string, unknown>>).map(this.mapPrompt);
  }

  acknowledgePrompt(sessionId: string, id: string, revision: string, actor: string, reason: string): QueuedPrompt {
    this.pruneHistory(sessionId);
    if (!/^[1-9][0-9]*$/.test(revision) || !actor.trim() || !reason.trim()) {
      throw new PromptQueueConflict("Revision, actor and reason are required", 400);
    }
    return this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM prompt_queue WHERE session_id = ? AND id = ?").get(sessionId, id);
      if (!row) throw new PromptQueueConflict("Prompt not found", 404);
      const prompt = this.mapPrompt(row as Record<string, unknown>);
      if (prompt.revision !== revision) throw new PromptQueueConflict("Prompt revision changed");
      if (prompt.state === "handled" && prompt.handledBy === actor && prompt.handledReason === reason.trim()) return prompt;
      if (prompt.state !== "pending") throw new PromptQueueConflict(`Prompt is already ${prompt.state}`);
      this.db.query(`UPDATE prompt_queue SET state = 'handled', handled_at = ?, handled_by = ?, handled_reason = ?
        WHERE session_id = ? AND id = ? AND revision = ? AND state = 'pending'`)
        .run(new Date().toISOString(), actor, reason.trim(), sessionId, id, revision);
      this.reorderQueue(sessionId);
      return this.mapPrompt(this.db.query("SELECT * FROM prompt_queue WHERE id = ?").get(id) as Record<string, unknown>);
    }).immediate();
  }

  claimNextPrompt(sessionId: string): QueuedPrompt | null {
    return this.db.transaction(() => {
      const prompt = this.getNextQueuedPrompt(sessionId);
      if (!prompt || prompt.state !== "pending") return null;
      const claimToken = randomUUID();
      this.db.query("UPDATE prompt_queue SET state = 'claimed', delivery_state = 'unsent', delivery_id = ?, delivery_updated_at = ?, claim_token = ? WHERE id = ? AND state = 'pending'")
        .run(claimToken, new Date().toISOString(), claimToken, prompt.id);
      return { ...prompt, state: "claimed" as const, claimToken, deliveryState: "unsent", deliveryId: claimToken };
    }).immediate();
  }

  recordClaimAcceptance(sessionId: string, id: string, token: string): void {
    const result = this.db.query(`UPDATE prompt_queue SET delivery_state = 'accepted', delivery_updated_at = ?
      WHERE session_id = ? AND id = ? AND claim_token = ? AND state = 'claimed'`)
      .run(new Date().toISOString(), sessionId, id, token);
    if (!result.changes) throw new PromptQueueConflict("Dispatch claim changed");
  }

  completeClaim(sessionId: string, id: string, claimToken: string): void {
    const result = this.db.query(`UPDATE prompt_queue SET state = 'dispatched', delivery_state = 'accepted', delivery_updated_at = ? WHERE session_id = ?
      AND id = ? AND claim_token = ? AND state = 'claimed'`).run(new Date().toISOString(), sessionId, id, claimToken);
    if (!result.changes) throw new PromptQueueConflict("Dispatch claim changed");
    this.reorderQueue(sessionId);
  }

  releaseRejectedClaim(sessionId: string, id: string, claimToken: string, certainty: "unsent" | "rejected" = "rejected"): void {
    this.db.query(`UPDATE prompt_queue SET state = 'pending', delivery_state = ?, claim_token = NULL WHERE session_id = ?
      AND id = ? AND claim_token = ? AND state = 'claimed'`).run(certainty, sessionId, id, claimToken);
  }

  markClaimSending(sessionId: string, id: string, token: string): void {
    const result = this.db.query(`UPDATE prompt_queue SET delivery_state = 'uncertain', delivery_updated_at = ?
      WHERE session_id = ? AND id = ? AND claim_token = ? AND state = 'claimed' AND delivery_state = 'unsent'`)
      .run(new Date().toISOString(), sessionId, id, token);
    if (!result.changes) throw new PromptQueueConflict("Dispatch claim changed");
  }

  reconcileClaim(sessionId: string, id: string, revision: string, token: string, resolution: string, actor: string, reason: string): QueuedPrompt {
    if (!["accepted", "retry"].includes(resolution) || !reason.trim() || !actor || !token || !/^[1-9][0-9]*$/.test(revision))
      throw new PromptQueueConflict("Resolution, claim token, revision, actor and reason required", 400);
    return this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM prompt_queue WHERE session_id = ? AND id = ?").get(sessionId, id) as Record<string, unknown> | null;
      if (!row) throw new PromptQueueConflict("Prompt not found", 404);
      const prompt = this.mapPrompt(row);
      if (prompt.state !== "claimed" || prompt.revision !== revision || prompt.claimToken !== token)
        throw new PromptQueueConflict("Dispatch claim or revision changed");
      this.db.query(`INSERT INTO prompt_queue_recovery (session_id, item_id, revision, delivery_id, actor, reason, resolution, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sessionId, id, revision, prompt.deliveryId ?? null, actor, reason.trim(), resolution, new Date().toISOString());
      this.db.query(`UPDATE prompt_queue SET state = ?, revision = revision + 1, handled_at = ?, handled_by = ?, handled_reason = ?,
        delivery_state = ?, claim_token = NULL WHERE id = ?`)
        .run(resolution === "accepted" ? "handled" : "pending", new Date().toISOString(), actor,
          `${resolution}: ${reason.trim()}`, resolution === "accepted" ? "accepted" : "unsent", id);
      this.reorderQueue(sessionId);
      return this.mapPrompt(this.db.query("SELECT * FROM prompt_queue WHERE id = ?").get(id) as Record<string, unknown>);
    }).immediate();
  }

  private pruneHistory(sessionId: string): void {
    prunePromptQueueHistory(this.db, sessionId);
  }

  private reorderQueue(sessionId: string): void {
    const prompts = this.getSessionQueue(sessionId);
    const tx = this.db.transaction(() => {
      prompts.forEach((prompt, index) => {
        const newOrder = index + 1;
        if (prompt.order !== newOrder) {
          this.db.prepare(`
            UPDATE prompt_queue
            SET queue_order = ?
            WHERE id = ?
          `).run(newOrder, prompt.id);
        }
      });
    });
    tx();
  }

  private initialise() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS prompt_queue_recovery (
      session_id TEXT, item_id TEXT, revision TEXT, delivery_id TEXT, actor TEXT, reason TEXT, resolution TEXT, created_at TEXT
    )`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        queue_order INTEGER NOT NULL,
        type TEXT,
        dedupe_key TEXT,
        payload_json TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_queue_session_order 
      ON prompt_queue(session_id, queue_order);
    `);
    const columns = this.db.query("PRAGMA table_info(prompt_queue)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const [name, definition] of Object.entries({
      revision: "INTEGER NOT NULL DEFAULT 1", state: "TEXT NOT NULL DEFAULT 'pending'",
      handled_at: "TEXT", handled_by: "TEXT", handled_reason: "TEXT", claim_token: "TEXT", delivery_state: "TEXT", delivery_id: "TEXT", delivery_updated_at: "TEXT",
    })) {
      if (!names.has(name)) this.db.exec(`ALTER TABLE prompt_queue ADD COLUMN ${name} ${definition}`);
    }
    if (!names.has("type")) this.db.exec("ALTER TABLE prompt_queue ADD COLUMN type TEXT");
    if (!names.has("dedupe_key")) this.db.exec("ALTER TABLE prompt_queue ADD COLUMN dedupe_key TEXT");
    if (!names.has("payload_json")) this.db.exec("ALTER TABLE prompt_queue ADD COLUMN payload_json TEXT");
    this.db.exec("DROP INDEX IF EXISTS idx_prompt_queue_dedupe");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_queue_dedupe
      ON prompt_queue(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'claimed')`);
  }

  private mapPrompt = mapQueuedPrompt;
}

export class PromptQueueConflict extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
