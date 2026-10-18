import type { Database } from "bun:sqlite";
import type { PipelineRunRecord } from "./pipeline-store";

export interface ResultDelivery {
  id: string;
  runId: string;
  url: string;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  attemptLimit: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastHttpStatus: number | null;
  deliveredAt: string | null;
  payload: string | null;
  retryCount: number;
  retryRequestedAt: string | null;
}

export interface ResultDeliveryRequeue {
  id: string;
  deliveryId: string;
  retryNumber: number;
  priorAttempts: number;
  priorAttemptLimit: number;
  priorLastError: string | null;
  priorLastHttpStatus: number | null;
  requestedAt: string;
  requestedByNpub: string;
}

export type ResultDeliveryRetry =
  | { outcome: "requeued" | "already_pending" | "delivered"; delivery: ResultDelivery; requeues: ResultDeliveryRequeue[] }
  | { outcome: "invalid"; code: "not_public_call" | "delivery_absent" | "run_not_terminal" | "delivery_payload_absent" }
  | { outcome: "denied"; code: "delivery_not_found" };

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
      deliveredAt TEXT, payload TEXT, attemptLimit INTEGER NOT NULL DEFAULT 5,
      retryCount INTEGER NOT NULL DEFAULT 0, retryRequestedAt TEXT
    )`);
    const columns = new Set((db.query("PRAGMA table_info(pipeline_result_deliveries)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("attemptLimit")) db.run("ALTER TABLE pipeline_result_deliveries ADD COLUMN attemptLimit INTEGER NOT NULL DEFAULT 5");
    if (!columns.has("retryCount")) db.run("ALTER TABLE pipeline_result_deliveries ADD COLUMN retryCount INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("retryRequestedAt")) db.run("ALTER TABLE pipeline_result_deliveries ADD COLUMN retryRequestedAt TEXT");
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_result_delivery_requeues (
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES pipeline_result_deliveries(id),
      retry_number INTEGER NOT NULL, prior_attempts INTEGER NOT NULL, prior_attempt_limit INTEGER NOT NULL,
      prior_last_error TEXT, prior_last_http_status INTEGER, requested_at TEXT NOT NULL,
      requested_by_npub TEXT NOT NULL, UNIQUE(delivery_id, retry_number)
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

  getRequeueHistory(deliveryId: string): ResultDeliveryRequeue[] {
    return this.db.query(`SELECT id, delivery_id AS deliveryId, retry_number AS retryNumber,
      prior_attempts AS priorAttempts, prior_attempt_limit AS priorAttemptLimit,
      prior_last_error AS priorLastError, prior_last_http_status AS priorLastHttpStatus,
      requested_at AS requestedAt, requested_by_npub AS requestedByNpub
      FROM pipeline_result_delivery_requeues WHERE delivery_id = ? ORDER BY retry_number`).all(deliveryId) as ResultDeliveryRequeue[];
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
    const retry = !success && delivery.attempts < delivery.attemptLimit;
    this.db.query(`UPDATE pipeline_result_deliveries SET status = ?, nextAttemptAt = ?, lastError = ?,
      lastHttpStatus = ?, deliveredAt = ? WHERE id = ? AND attempts = ? AND status = 'delivering'`)
      .run(success ? "delivered" : retry ? "pending" : "failed", at + Math.min(60_000, 1000 * 2 ** (delivery.attempts - 1)),
        outcome.error, outcome.status, success ? new Date(at).toISOString() : null, delivery.id, delivery.attempts);
  }

  exhaust(id: string): void {
    this.db.query(`UPDATE pipeline_result_deliveries SET status = 'failed', lastError = 'Delivery attempt limit reached'
      WHERE id = ? AND status IN ('pending', 'delivering')`).run(id);
  }

  /** Owner-authorized recovery opens one new bounded attempt window while
   * preserving the original delivery identity, destination and payload. */
  retryExhausted(runId: string, authorizedOwnerNpub: string, requestedByNpub: string, at: number): ResultDeliveryRetry {
    return this.db.transaction((): ResultDeliveryRetry => {
      const run = this.db.query(`SELECT r.owner_npub AS ownerNpub, r.completed_at AS completedAt,
        c.owner_npub AS publicOwnerNpub FROM pipeline_runs r
        LEFT JOIN pipeline_public_calls c ON c.run_id = r.id WHERE r.id = ?`).get(runId) as {
          ownerNpub: string | null; completedAt: string | null; publicOwnerNpub: string | null;
        } | null;
      if (!run || run.ownerNpub !== authorizedOwnerNpub) return { outcome: "denied", code: "delivery_not_found" };
      if (!run.publicOwnerNpub || run.publicOwnerNpub !== authorizedOwnerNpub) return { outcome: "invalid", code: "not_public_call" };
      const current = this.getDelivery(runId);
      if (!current) return { outcome: "invalid", code: "delivery_absent" };
      if (!run.completedAt) return { outcome: "invalid", code: "run_not_terminal" };
      const existing = () => ({ delivery: this.getDelivery(runId)!, requeues: this.getRequeueHistory(current.id) });
      if (current.status === "delivered") return { outcome: "delivered", ...existing() };
      if (current.status !== "failed") return { outcome: "already_pending", ...existing() };
      if (!current.payload) return { outcome: "invalid", code: "delivery_payload_absent" };
      const requestedAt = new Date(at).toISOString();
      const changed = this.db.query(`UPDATE pipeline_result_deliveries
        SET status = 'pending', nextAttemptAt = ?, attemptLimit = attempts + 5,
          retryCount = retryCount + 1, retryRequestedAt = ?
        WHERE runId = ? AND status = 'failed' AND payload IS NOT NULL AND retryCount = ?`)
        .run(at, requestedAt, runId, current.retryCount);
      const delivery = this.getDelivery(runId)!;
      if (changed.changes !== 1) {
        return { outcome: delivery.status === "delivered" ? "delivered" : "already_pending",
          delivery, requeues: this.getRequeueHistory(delivery.id) };
      }
      const retryNumber = current.retryCount + 1;
      this.db.query(`INSERT INTO pipeline_result_delivery_requeues
        (id, delivery_id, retry_number, prior_attempts, prior_attempt_limit, prior_last_error,
          prior_last_http_status, requested_at, requested_by_npub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), current.id, retryNumber, current.attempts, current.attemptLimit,
          current.lastError, current.lastHttpStatus, requestedAt, requestedByNpub);
      return { outcome: "requeued", delivery, requeues: this.getRequeueHistory(delivery.id) };
    }).immediate();
  }
}
