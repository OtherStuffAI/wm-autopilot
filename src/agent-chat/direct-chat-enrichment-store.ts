import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { databaseFile } from "../storage/message-store.ts";
import type { DirectChatEnrichmentConfig, DirectChatHandlerMode } from "./direct-chat-enrichment-config.ts";
import type { JsonObject } from "../pipelines/pipeline-store.ts";

export interface EnrichmentAttempt {
  turnId: string; mode: DirectChatHandlerMode; config: DirectChatEnrichmentConfig | null;
  sessionId: string; token: string; status: string; runId: string | null; result: JsonObject | null;
}

export class DirectChatEnrichmentStore {
  private db: Database;
  constructor(path = databaseFile) {
    this.db = new Database(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS direct_chat_enrichment (
        turn_id TEXT PRIMARY KEY, mode TEXT NOT NULL, config TEXT, session_id TEXT NOT NULL,
        token TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, run_id TEXT, result TEXT, delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS direct_chat_submission_leases (
        routing_key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS direct_chat_context_manifest (
        session_id TEXT NOT NULL, context_key TEXT NOT NULL, context TEXT NOT NULL,
        turn_id TEXT NOT NULL, delivered_at TEXT NOT NULL, PRIMARY KEY(session_id, context_key)
      );`);
  }
  claimSubmission(routingKey: string, owner: string, leaseMs: number): boolean {
    return this.db.query(`INSERT INTO direct_chat_submission_leases VALUES (?,?,?) ON CONFLICT(routing_key)
      DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
      WHERE direct_chat_submission_leases.expires_at<=? OR direct_chat_submission_leases.owner=excluded.owner`)
      .run(routingKey, owner, Date.now() + leaseMs, Date.now()).changes > 0;
  }
  ownsSubmission(routingKey: string, owner: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM direct_chat_submission_leases WHERE routing_key=? AND owner=? AND expires_at>?").get(routingKey, owner, Date.now()));
  }
  releaseSubmission(routingKey: string, owner: string) {
    this.db.query("DELETE FROM direct_chat_submission_leases WHERE routing_key=? AND owner=?").run(routingKey, owner);
  }
  close() { this.db.close(); }
  get(turnId: string): EnrichmentAttempt | null {
    const row = this.db.query("SELECT * FROM direct_chat_enrichment WHERE turn_id=?").get(turnId) as any;
    return row ? { turnId, mode: row.mode, config: row.config ? JSON.parse(row.config) : null,
      sessionId: row.session_id, token: row.token, status: row.status, runId: row.run_id,
      result: row.result ? JSON.parse(row.result) : null } : null;
  }
  capture(turnId: string, mode: DirectChatHandlerMode, config: DirectChatEnrichmentConfig | null) {
    this.db.query("INSERT OR IGNORE INTO direct_chat_enrichment VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL)")
      .run(turnId, mode, config ? JSON.stringify(config) : null, "", randomUUID(), 0, "captured");
    return this.get(turnId)!;
  }
  claim(turnId: string, sessionId: string, timeoutMs: number): EnrichmentAttempt | null {
    const saved = this.get(turnId)!;
    if (saved.sessionId === sessionId && saved.result) return saved;
    const token = randomUUID();
    const claimed = this.db.query(`UPDATE direct_chat_enrichment SET session_id=?, token=?, expires_at=?, status='running',
      run_id=NULL,result=NULL,delivered_at=NULL WHERE turn_id=? AND (status!='running' OR expires_at<=?)`)
      .run(sessionId, token, Date.now() + timeoutMs, turnId, Date.now());
    return claimed.changes ? this.get(turnId) : null;
  }
  runStarted(turnId: string, token: string, runId: string) {
    this.db.query("UPDATE direct_chat_enrichment SET run_id=? WHERE turn_id=? AND token=? AND status='running'").run(runId, turnId, token);
  }
  finish(turnId: string, token: string, result: JsonObject): boolean {
    return this.db.query("UPDATE direct_chat_enrichment SET result=?,status=? WHERE turn_id=? AND token=? AND status='running'")
      .run(JSON.stringify(result), String(result.status), turnId, token).changes > 0;
  }
  manifest(sessionId: string): JsonObject[] {
    return (this.db.query("SELECT context, delivered_at FROM direct_chat_context_manifest WHERE session_id=? ORDER BY delivered_at DESC LIMIT 100")
      .all(sessionId) as any[]).map(row => ({ ...JSON.parse(row.context), deliveredAt: row.delivered_at }));
  }
  accepted(turnId: string, sessionId: string) {
    this.db.transaction(() => {
      const saved = this.get(turnId);
      if (!saved || saved.sessionId !== sessionId || !saved.result) return;
      const now = new Date().toISOString();
      for (const context of (saved.result.context ?? []) as JsonObject[]) {
        this.db.query("INSERT OR REPLACE INTO direct_chat_context_manifest VALUES (?,?,?,?,?)")
          .run(sessionId, String(context.key), JSON.stringify(context), turnId, now);
      }
      this.db.query("UPDATE direct_chat_enrichment SET delivered_at=? WHERE turn_id=?").run(now, turnId);
    })();
  }
}
