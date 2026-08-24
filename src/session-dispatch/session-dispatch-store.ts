import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type DispatchState = "creating" | "running" | "callback_pending" | "callback_delivered" | "acknowledged" | "closed" | "failed";
export type TerminalStatus = "completed" | "failed" | "cancelled" | "stopped";
export type CallbackWakeState = "pending" | "claimed" | "submitted" | "blocked" | "resolved";

export interface SessionDispatch {
  dispatchId: string;
  workerSessionId: string;
  callbackSessionId: string | null;
  ownerNpub: string | null;
  state: DispatchState;
  prompt: string;
  promptQueuedAt: string;
  reportingContext: Record<string, unknown>;
  terminalStatus: TerminalStatus | null;
  terminalMessage: string | null;
  terminalMessageCreatedAt: string | null;
  terminalFingerprint: string | null;
  callbackPrompt: string | null;
  nativeDiscoveryStartedAt: string | null;
  nativeDiscoveryNextAttemptAt: string | null;
  nativeDiscoveryAttemptCount: number;
  nativeDiscoveryLastError: string | null;
  callbackAttemptCount: number;
  callbackNextAttemptAt: string | null;
  callbackExpiresAt: string | null;
  callbackQueuedAt: string | null;
  callbackAcknowledgedAt: string | null;
  closedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallbackWakeRecord {
  callbackSessionId: string;
  inboxFingerprint: string;
  state: CallbackWakeState;
  attemptCount: number;
  claimedAt: string | null;
  submittedAt: string | null;
  busyObservedAt: string | null;
  leaseExpiresAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

export class SessionDispatchStore {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_dispatches (
      dispatch_id TEXT PRIMARY KEY, worker_session_id TEXT NOT NULL,
      callback_session_id TEXT, owner_npub TEXT, state TEXT NOT NULL,
      prompt TEXT NOT NULL, prompt_queued_at TEXT NOT NULL,
      reporting_context_json TEXT NOT NULL DEFAULT '{}', terminal_status TEXT,
      terminal_message TEXT, terminal_message_created_at TEXT,
      terminal_fingerprint TEXT, callback_prompt TEXT,
      native_discovery_started_at TEXT, native_discovery_next_attempt_at TEXT,
      native_discovery_attempt_count INTEGER NOT NULL DEFAULT 0,
      native_discovery_last_error TEXT,
      callback_attempt_count INTEGER NOT NULL DEFAULT 0,
      callback_next_attempt_at TEXT, callback_expires_at TEXT, callback_queued_at TEXT,
      callback_acknowledged_at TEXT, closed_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_callback ON session_dispatches(callback_session_id, state);
    CREATE INDEX IF NOT EXISTS idx_dispatch_worker ON session_dispatches(worker_session_id, state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_terminal ON session_dispatches(dispatch_id, terminal_fingerprint)
      WHERE terminal_fingerprint IS NOT NULL;
    CREATE TABLE IF NOT EXISTS session_dispatch_callback_wakes (
      callback_session_id TEXT PRIMARY KEY,
      inbox_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      submitted_at TEXT,
      busy_observed_at TEXT,
      lease_expires_at TEXT,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    const columns = new Set((this.db.query("PRAGMA table_info(session_dispatches)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!columns.has("callback_next_attempt_at")) {
      this.db.exec("ALTER TABLE session_dispatches ADD COLUMN callback_next_attempt_at TEXT");
    }
    if (!columns.has("callback_expires_at")) {
      this.db.exec("ALTER TABLE session_dispatches ADD COLUMN callback_expires_at TEXT");
    }
    if (!columns.has("native_discovery_started_at")) {
      this.db.exec("ALTER TABLE session_dispatches ADD COLUMN native_discovery_started_at TEXT");
    }
    if (!columns.has("native_discovery_next_attempt_at")) {
      this.db.exec("ALTER TABLE session_dispatches ADD COLUMN native_discovery_next_attempt_at TEXT");
    }
    if (!columns.has("native_discovery_attempt_count")) {
      this.db.exec("ALTER TABLE session_dispatches ADD COLUMN native_discovery_attempt_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("native_discovery_last_error")) {
      this.db.exec("ALTER TABLE session_dispatches ADD COLUMN native_discovery_last_error TEXT");
    }
  }

  create(input: Omit<SessionDispatch, "dispatchId" | "createdAt" | "updatedAt">): SessionDispatch {
    const now = new Date().toISOString();
    const record = { ...input, dispatchId: `dispatch_${randomUUID()}`, createdAt: now, updatedAt: now };
    this.db.query(`INSERT INTO session_dispatches (
      dispatch_id, worker_session_id, callback_session_id, owner_npub, state, prompt,
      prompt_queued_at, reporting_context_json, terminal_status, terminal_message,
      terminal_message_created_at, terminal_fingerprint, callback_prompt, callback_attempt_count,
      native_discovery_started_at, native_discovery_next_attempt_at, native_discovery_attempt_count,
      native_discovery_last_error,
      callback_next_attempt_at, callback_expires_at, callback_queued_at, callback_acknowledged_at,
      closed_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.dispatchId, record.workerSessionId, record.callbackSessionId, record.ownerNpub,
        record.state, record.prompt, record.promptQueuedAt, JSON.stringify(record.reportingContext),
        record.terminalStatus, record.terminalMessage, record.terminalMessageCreatedAt,
        record.terminalFingerprint, record.callbackPrompt, record.callbackAttemptCount,
        record.nativeDiscoveryStartedAt, record.nativeDiscoveryNextAttemptAt,
        record.nativeDiscoveryAttemptCount, record.nativeDiscoveryLastError,
        record.callbackNextAttemptAt, record.callbackExpiresAt, record.callbackQueuedAt,
        record.callbackAcknowledgedAt, record.closedAt, record.lastError, record.createdAt, record.updatedAt);
    return record;
  }

  get(id: string): SessionDispatch | null {
    const row = this.db.query("SELECT * FROM session_dispatches WHERE dispatch_id = ?").get(id) as Row | null;
    return row ? this.map(row) : null;
  }

  list(filters: { callbackSessionId?: string; state?: DispatchState; ownerNpub?: string | null } = {}): SessionDispatch[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filters.callbackSessionId) { clauses.push("callback_session_id = ?"); values.push(filters.callbackSessionId); }
    if (filters.state) { clauses.push("state = ?"); values.push(filters.state); }
    if (filters.ownerNpub !== undefined) { clauses.push("owner_npub IS ?"); values.push(filters.ownerNpub); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.query(`SELECT * FROM session_dispatches${where} ORDER BY created_at DESC`).all(...values as any[]) as Row[]).map((row) => this.map(row));
  }

  listUnresolvedCallbacks(callbackSessionId: string): SessionDispatch[] {
    return (this.db.query(`SELECT * FROM session_dispatches
      WHERE callback_session_id = ?
        AND terminal_fingerprint IS NOT NULL
        AND state IN ('callback_pending', 'callback_delivered')
      ORDER BY terminal_message_created_at ASC, created_at ASC, dispatch_id ASC`).all(callbackSessionId) as Row[])
      .map((row) => this.map(row));
  }

  getInboxFingerprint(callbackSessionId: string): string | null {
    const callbacks = this.listUnresolvedCallbacks(callbackSessionId);
    if (callbacks.length === 0) return null;
    const material = callbacks
      .map((record) => `${record.dispatchId}:${record.terminalFingerprint}`)
      .sort()
      .join("\n");
    return createHash("sha256").update(material).digest("hex");
  }

  getWake(callbackSessionId: string): CallbackWakeRecord | null {
    const row = this.db.query(`SELECT * FROM session_dispatch_callback_wakes
      WHERE callback_session_id = ?`).get(callbackSessionId) as Row | null;
    return row ? this.mapWake(row) : null;
  }

  saveWake(input: Omit<CallbackWakeRecord, "createdAt" | "updatedAt"> & {
    createdAt?: string;
    updatedAt?: string;
  }): CallbackWakeRecord {
    const existing = this.getWake(input.callbackSessionId);
    const now = input.updatedAt ?? new Date().toISOString();
    const record: CallbackWakeRecord = {
      ...input,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.query(`INSERT INTO session_dispatch_callback_wakes (
      callback_session_id, inbox_fingerprint, state, attempt_count, claimed_at,
      submitted_at, busy_observed_at, lease_expires_at, next_retry_at, last_error,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(callback_session_id) DO UPDATE SET
      inbox_fingerprint=excluded.inbox_fingerprint, state=excluded.state,
      attempt_count=excluded.attempt_count, claimed_at=excluded.claimed_at,
      submitted_at=excluded.submitted_at, busy_observed_at=excluded.busy_observed_at,
      lease_expires_at=excluded.lease_expires_at, next_retry_at=excluded.next_retry_at,
      last_error=excluded.last_error, updated_at=excluded.updated_at`)
      .run(record.callbackSessionId, record.inboxFingerprint, record.state, record.attemptCount,
        record.claimedAt, record.submittedAt, record.busyObservedAt, record.leaseExpiresAt,
        record.nextRetryAt, record.lastError, record.createdAt, record.updatedAt);
    return record;
  }

  claimWake(callbackSessionId: string, fingerprint: string, now: string, leaseExpiresAt: string): CallbackWakeRecord | null {
    return this.db.transaction(() => {
      const current = this.getWake(callbackSessionId);
      if (!current || current.inboxFingerprint !== fingerprint) {
        this.saveWake({ callbackSessionId, inboxFingerprint: fingerprint, state: "pending",
          attemptCount: 0, claimedAt: null, submittedAt: null, busyObservedAt: null,
          leaseExpiresAt: null, nextRetryAt: null, lastError: null, updatedAt: now });
      }
      const ready = this.getWake(callbackSessionId)!;
      if (ready.state !== "pending" || (ready.nextRetryAt && ready.nextRetryAt > now)) return null;
      const result = this.db.query(`UPDATE session_dispatch_callback_wakes SET
        state='claimed', attempt_count=attempt_count + 1, claimed_at=?, submitted_at=NULL,
        busy_observed_at=NULL, lease_expires_at=?, next_retry_at=NULL, last_error=NULL,
        updated_at=? WHERE callback_session_id=? AND inbox_fingerprint=? AND state='pending'`)
        .run(now, leaseExpiresAt, now, callbackSessionId, fingerprint);
      return result.changes > 0 ? this.getWake(callbackSessionId) : null;
    })();
  }

  migrateLegacyDeliveredCallbacks(): number {
    const now = new Date().toISOString();
    const result = this.db.query(`UPDATE session_dispatches SET state='callback_pending',
      callback_next_attempt_at=NULL, callback_expires_at=NULL, last_error=NULL, updated_at=?
      WHERE state='callback_delivered' AND terminal_fingerprint IS NOT NULL
        AND callback_acknowledged_at IS NULL`).run(now);
    return result.changes;
  }

  update(id: string, patch: Partial<SessionDispatch>): SessionDispatch {
    const current = this.get(id);
    if (!current) throw new Error(`Dispatch not found: ${id}`);
    const next = { ...current, ...patch, dispatchId: id, updatedAt: new Date().toISOString() };
    this.db.query(`UPDATE session_dispatches SET state=?, terminal_status=?, terminal_message=?,
      terminal_message_created_at=?, terminal_fingerprint=?, callback_prompt=?, callback_attempt_count=?,
      native_discovery_started_at=?, native_discovery_next_attempt_at=?,
      native_discovery_attempt_count=?, native_discovery_last_error=?,
      callback_next_attempt_at=?, callback_expires_at=?, callback_queued_at=?,
      callback_acknowledged_at=?, closed_at=?, last_error=?, updated_at=? WHERE dispatch_id=?`)
      .run(next.state, next.terminalStatus, next.terminalMessage, next.terminalMessageCreatedAt,
        next.terminalFingerprint, next.callbackPrompt, next.callbackAttemptCount,
        next.nativeDiscoveryStartedAt, next.nativeDiscoveryNextAttemptAt,
        next.nativeDiscoveryAttemptCount, next.nativeDiscoveryLastError,
        next.callbackNextAttemptAt, next.callbackExpiresAt, next.callbackQueuedAt,
        next.callbackAcknowledgedAt, next.closedAt,
        next.lastError, next.updatedAt, id);
    return next;
  }

  private map(row: Row): SessionDispatch {
    return {
      dispatchId: String(row.dispatch_id), workerSessionId: String(row.worker_session_id),
      callbackSessionId: row.callback_session_id as string | null, ownerNpub: row.owner_npub as string | null,
      state: row.state as DispatchState, prompt: String(row.prompt), promptQueuedAt: String(row.prompt_queued_at),
      reportingContext: JSON.parse(String(row.reporting_context_json || "{}")),
      terminalStatus: row.terminal_status as TerminalStatus | null, terminalMessage: row.terminal_message as string | null,
      terminalMessageCreatedAt: row.terminal_message_created_at as string | null,
      terminalFingerprint: row.terminal_fingerprint as string | null, callbackPrompt: row.callback_prompt as string | null,
      nativeDiscoveryStartedAt: row.native_discovery_started_at as string | null,
      nativeDiscoveryNextAttemptAt: row.native_discovery_next_attempt_at as string | null,
      nativeDiscoveryAttemptCount: Number(row.native_discovery_attempt_count ?? 0),
      nativeDiscoveryLastError: row.native_discovery_last_error as string | null,
      callbackAttemptCount: Number(row.callback_attempt_count),
      callbackNextAttemptAt: row.callback_next_attempt_at as string | null,
      callbackExpiresAt: row.callback_expires_at as string | null, callbackQueuedAt: row.callback_queued_at as string | null,
      callbackAcknowledgedAt: row.callback_acknowledged_at as string | null, closedAt: row.closed_at as string | null,
      lastError: row.last_error as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private mapWake(row: Row): CallbackWakeRecord {
    return {
      callbackSessionId: String(row.callback_session_id),
      inboxFingerprint: String(row.inbox_fingerprint),
      state: row.state as CallbackWakeState,
      attemptCount: Number(row.attempt_count ?? 0),
      claimedAt: row.claimed_at as string | null,
      submittedAt: row.submitted_at as string | null,
      busyObservedAt: row.busy_observed_at as string | null,
      leaseExpiresAt: row.lease_expires_at as string | null,
      nextRetryAt: row.next_retry_at as string | null,
      lastError: row.last_error as string | null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
