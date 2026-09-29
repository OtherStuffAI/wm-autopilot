import type { Database } from "bun:sqlite";
import type { PipelineRunRecord } from "./pipeline-store";

export interface ResultDelivery {
  id: string;
  runId: string;
  url: string;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastHttpStatus: number | null;
  deliveredAt: string | null;
  payload: string | null;
}

export class PublicCallReplay extends Error {
  constructor(readonly runId: string, readonly fingerprint: string) { super("Public call already exists"); }
}

/** Public invocation metadata shares the run database and transaction boundary. */
export class PublicCallStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_public_calls (
      run_id TEXT PRIMARY KEY REFERENCES pipeline_runs(id), owner_npub TEXT NOT NULL,
      definition_id TEXT NOT NULL, idempotency_key TEXT, fingerprint TEXT NOT NULL,
      UNIQUE(owner_npub, definition_id, idempotency_key)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_result_deliveries (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL UNIQUE REFERENCES pipeline_runs(id),
      url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt INTEGER NOT NULL DEFAULT 0, lastError TEXT, lastHttpStatus INTEGER,
      deliveredAt TEXT, payload TEXT
    )`);
  }

  isPublic(runId: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM pipeline_public_calls WHERE run_id = ?").get(runId));
  }

  find(owner: string, definitionId: string, key: string): { runId: string; fingerprint: string } | null {
    return this.db.query(`SELECT run_id AS runId, fingerprint FROM pipeline_public_calls
      WHERE owner_npub = ? AND definition_id = ? AND idempotency_key = ?`).get(owner, definitionId, key) as { runId: string; fingerprint: string } | null;
  }

  create(input: { owner: string; definitionId: string; key: string | null; fingerprint: string; webhookUrl: string | null },
    createRun: () => PipelineRunRecord): PipelineRunRecord {
    return this.db.transaction(() => {
      const existing = input.key ? this.find(input.owner, input.definitionId, input.key) : null;
      if (existing) throw new PublicCallReplay(existing.runId, existing.fingerprint);
      const run = createRun();
      this.db.query(`INSERT INTO pipeline_public_calls VALUES (?, ?, ?, ?, ?)`)
        .run(run.id, input.owner, input.definitionId, input.key, input.fingerprint);
      if (input.webhookUrl) {
        this.db.query(`INSERT INTO pipeline_result_deliveries (id, runId, url) VALUES (?, ?, ?)`)
          .run(crypto.randomUUID(), run.id, input.webhookUrl);
      }
      return run;
    }).immediate();
  }

  getDelivery(runId: string): ResultDelivery | null {
    return this.db.query("SELECT * FROM pipeline_result_deliveries WHERE runId = ?").get(runId) as ResultDelivery | null;
  }

  due(at: number): ResultDelivery[] {
    return this.db.query(`SELECT d.* FROM pipeline_result_deliveries d JOIN pipeline_runs r ON r.id = d.runId
      WHERE d.status IN ('pending', 'delivering') AND d.nextAttemptAt <= ? AND r.completed_at IS NOT NULL
      ORDER BY d.nextAttemptAt LIMIT 20`).all(at) as ResultDelivery[];
  }

  claim(id: string, at: number, payload: string): ResultDelivery | null {
    const changed = this.db.query(`UPDATE pipeline_result_deliveries SET status = 'delivering',
      nextAttemptAt = ?, attempts = attempts + 1, payload = COALESCE(payload, ?)
      WHERE id = ? AND status IN ('pending', 'delivering') AND nextAttemptAt <= ?`)
      .run(at + 30_000, payload, id, at);
    if (!changed.changes) return null;
    return this.db.query("SELECT * FROM pipeline_result_deliveries WHERE id = ?").get(id) as ResultDelivery;
  }

  finish(delivery: ResultDelivery, outcome: { status: number | null; error: string | null }, at: number): void {
    const success = outcome.status !== null && outcome.status >= 200 && outcome.status < 300 && !outcome.error;
    const retry = !success && delivery.attempts < 5;
    this.db.query(`UPDATE pipeline_result_deliveries SET status = ?, nextAttemptAt = ?, lastError = ?,
      lastHttpStatus = ?, deliveredAt = ? WHERE id = ? AND attempts = ? AND status = 'delivering'`)
      .run(success ? "delivered" : retry ? "pending" : "failed", at + Math.min(60_000, 1000 * 2 ** (delivery.attempts - 1)),
        outcome.error, outcome.status, success ? new Date(at).toISOString() : null, delivery.id, delivery.attempts);
  }

  exhaust(id: string): void {
    this.db.query(`UPDATE pipeline_result_deliveries SET status = 'failed', lastError = 'Delivery attempt limit reached'
      WHERE id = ? AND status IN ('pending', 'delivering')`).run(id);
  }
}
