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
    this.initialise();
    
    this.insertPrompt = this.db.prepare(`
      INSERT OR IGNORE INTO prompt_queue
        (id, session_id, content, timestamp, queue_order, type, dedupe_key, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    this.getQueue = this.db.prepare(`
      SELECT * FROM prompt_queue
      WHERE session_id = ?
      ORDER BY queue_order ASC
    `);
    
    this.updatePrompt = this.db.prepare(`
      UPDATE prompt_queue
      SET content = ?
      WHERE id = ? AND session_id = ?
    `);
    
    this.deletePrompt = this.db.prepare(`
      DELETE FROM prompt_queue
      WHERE id = ? AND session_id = ?
    `);
    
    this.getNextPrompt = this.db.prepare(`
      SELECT * FROM prompt_queue
      WHERE session_id = ?
      ORDER BY queue_order ASC
      LIMIT 1
    `);

    this.hasPromptByContentStmt = this.db.prepare(`
      SELECT 1
      FROM prompt_queue
      WHERE session_id = ? AND content = ?
      LIMIT 1
    `);

    this.hasTaskDispatchPromptStmt = this.db.prepare(`
      SELECT 1
      FROM prompt_queue
      WHERE session_id = ?
        AND instr(content, 'Agent work dispatch.') > 0
        AND instr(content, ?) > 0
      LIMIT 1
    `);
    
    this.countPrompts = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM prompt_queue
      WHERE session_id = ?
    `);
    
    this.clearQueue = this.db.prepare(`
      DELETE FROM prompt_queue
      WHERE session_id = ?
    `);
  }

  addPrompt(sessionId: string, input: QueuedPromptInput): QueuedPrompt | null {
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
    };
  }

  getSessionQueue(sessionId: string): QueuedPrompt[] {
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
    const nextPrompt = this.getNextQueuedPrompt(sessionId);
    if (nextPrompt) {
      this.deletePromptById(sessionId, nextPrompt.id);
      return nextPrompt;
    }
    return null;
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

  deletePromptsByType(type: string): number {
    const normalizedType = type.trim();
    if (!normalizedType) return 0;
    const sessionRows = this.db.query(`SELECT DISTINCT session_id FROM prompt_queue WHERE type = ?`)
      .all(normalizedType) as Array<{ session_id: string }>;
    const result = this.db.query(`DELETE FROM prompt_queue WHERE type = ?`).run(normalizedType);
    for (const row of sessionRows) this.reorderQueue(row.session_id);
    return result.changes;
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
    if (!names.has("type")) this.db.exec("ALTER TABLE prompt_queue ADD COLUMN type TEXT");
    if (!names.has("dedupe_key")) this.db.exec("ALTER TABLE prompt_queue ADD COLUMN dedupe_key TEXT");
    if (!names.has("payload_json")) this.db.exec("ALTER TABLE prompt_queue ADD COLUMN payload_json TEXT");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_queue_dedupe
      ON prompt_queue(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL`);
  }

  private mapPrompt = (row: Record<string, unknown>): QueuedPrompt => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    content: String(row.content),
    timestamp: String(row.timestamp),
    order: Number(row.queue_order),
    type: typeof row.type === "string" ? row.type : null,
    dedupeKey: typeof row.dedupe_key === "string" ? row.dedupe_key : null,
    payload: typeof row.payload_json === "string"
      ? JSON.parse(row.payload_json) as Record<string, unknown>
      : null,
  });
}
