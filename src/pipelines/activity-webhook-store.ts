import type { Database } from "bun:sqlite";
import { activityEventId, type ActivityWebhookDestination, type ActivityWebhookEvent } from "./activity-webhook-contract.ts";
import type { PublicTurnActivity } from "../agents/bound-turn-activity.ts";

export interface ActivityTurnBinding {
  turnId: string; runId: string; stepId: string; sessionId: string | null;
  receiptId: string | null; checkpoint: number; prompt: string;
  destination: ActivityWebhookDestination;
}
export interface ActivityDelivery {
  eventId: string; turnId: string; sequence: number; url: string; body: string;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number; nextAttemptAt: number; lastError: string | null;
}

/** Immutable bindings and bodies make transcript rescans and crash retries idempotent. */
export class ActivityWebhookStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_activity_turns (
      turnId TEXT PRIMARY KEY, binding TEXT NOT NULL, terminal INTEGER NOT NULL DEFAULT 0, nativeSessionId TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_activity_deliveries (
      eventId TEXT PRIMARY KEY, turnId TEXT NOT NULL REFERENCES pipeline_activity_turns(turnId),
      sequence INTEGER NOT NULL, url TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt INTEGER NOT NULL DEFAULT 0, lastError TEXT, UNIQUE(turnId, sequence)
    )`);
  }

  bind(binding: ActivityTurnBinding): void {
    const json = JSON.stringify(binding);
    this.db.query("INSERT OR IGNORE INTO pipeline_activity_turns (turnId, binding) VALUES (?, ?)").run(binding.turnId, json);
    const saved = this.db.query("SELECT binding FROM pipeline_activity_turns WHERE turnId=?").get(binding.turnId) as { binding: string };
    if (saved.binding !== json) throw new Error("Activity turn binding changed");
  }

  active(): ActivityTurnBinding[] {
    return (this.db.query("SELECT binding FROM pipeline_activity_turns WHERE terminal=0").all() as { binding: string }[])
      .map(row => JSON.parse(row.binding) as ActivityTurnBinding);
  }

  bindNative(turnId: string, nativeSessionId: string): void {
    this.db.query("UPDATE pipeline_activity_turns SET nativeSessionId=COALESCE(nativeSessionId,?) WHERE turnId=?").run(nativeSessionId, turnId);
    const row = this.db.query("SELECT nativeSessionId FROM pipeline_activity_turns WHERE turnId=?").get(turnId) as { nativeSessionId: string } | null;
    if (!row || row.nativeSessionId !== nativeSessionId) throw new Error("Activity native conversation binding changed");
  }

  append(binding: ActivityTurnBinding, activity: PublicTurnActivity): void {
    this.enqueue(binding, activity.sourceId, activity.type, activity.content, activity.timestamp, false);
  }

  finish(binding: ActivityTurnBinding, success: boolean): void {
    this.enqueue(binding, "terminal", success ? "completed" : "failed", success ? "Completed" : "Failed", new Date().toISOString(), true);
  }

  private enqueue(binding: ActivityTurnBinding, source: string, type: ActivityWebhookEvent["type"], content: string, timestamp: string, terminal: boolean): void {
    this.db.transaction(() => {
      const state = this.db.query("SELECT terminal FROM pipeline_activity_turns WHERE turnId=?").get(binding.turnId) as { terminal: number } | null;
      if (!state) throw new Error("Activity turn binding missing");
      const eventId = activityEventId(binding.turnId, source);
      if (state.terminal) return;
      const existing = this.db.query("SELECT body FROM pipeline_activity_deliveries WHERE eventId=?").get(eventId) as { body: string } | null;
      if (existing) {
        const event = JSON.parse(existing.body) as ActivityWebhookEvent;
        if (event.type !== type || event.content !== content || event.timestamp !== timestamp) throw new Error("Activity public source changed after publication");
        return;
      }
      const count = this.db.query("SELECT COUNT(*) AS count FROM pipeline_activity_deliveries WHERE turnId=?").get(binding.turnId) as { count: number };
      if (!terminal && count.count >= 256) return;
      const event: ActivityWebhookEvent = { version: 1, eventId, sequence: count.count + 1,
        runId: binding.runId, stepId: binding.stepId, sessionId: binding.sessionId, turnId: binding.turnId,
        correlation: binding.destination.correlation, timestamp, type, content };
      this.db.query("INSERT INTO pipeline_activity_deliveries (eventId,turnId,sequence,url,body) VALUES (?,?,?,?,?)")
        .run(eventId, binding.turnId, event.sequence, binding.destination.url, JSON.stringify(event));
      if (terminal) this.db.query("UPDATE pipeline_activity_turns SET terminal=1 WHERE turnId=?").run(binding.turnId);
    }).immediate();
  }

  due(at: number): ActivityDelivery[] {
    return this.db.query(`SELECT d.* FROM pipeline_activity_deliveries d
      WHERE d.status IN ('pending','delivering') AND d.nextAttemptAt<=?
      AND NOT EXISTS (SELECT 1 FROM pipeline_activity_deliveries p WHERE p.turnId=d.turnId
        AND p.sequence<d.sequence AND p.status IN ('pending','delivering'))
      ORDER BY d.nextAttemptAt,d.rowid LIMIT 8`).all(at) as ActivityDelivery[];
  }

  claim(id: string, at: number): ActivityDelivery | null {
    const result = this.db.query(`UPDATE pipeline_activity_deliveries SET status='delivering', attempts=attempts+1,nextAttemptAt=?
      WHERE eventId=? AND status IN ('pending','delivering') AND nextAttemptAt<=? AND attempts<3`)
      .run(at + 30_000, id, at);
    if (!result.changes) return null;
    return this.db.query("SELECT * FROM pipeline_activity_deliveries WHERE eventId=?").get(id) as ActivityDelivery;
  }

  settle(delivery: ActivityDelivery, status: number | null, at: number): void {
    const success = status !== null && status >= 200 && status < 300;
    this.db.query(`UPDATE pipeline_activity_deliveries SET status=?,nextAttemptAt=?,lastError=?
      WHERE eventId=? AND attempts=? AND status='delivering'`)
      .run(success ? "delivered" : delivery.attempts >= 3 ? "failed" : "pending", at + 1000 * 2 ** delivery.attempts,
        success ? null : status === null ? "Activity delivery failed" : `Receiver returned HTTP ${status}`, delivery.eventId, delivery.attempts);
  }

  exhaust(id: string): void {
    this.db.query("UPDATE pipeline_activity_deliveries SET status='failed',lastError='Activity attempt limit reached' WHERE eventId=? AND attempts>=3 AND status IN ('pending','delivering')").run(id);
  }

  list(turnId: string): ActivityDelivery[] {
    return this.db.query("SELECT * FROM pipeline_activity_deliveries WHERE turnId=? ORDER BY sequence").all(turnId) as ActivityDelivery[];
  }
}
