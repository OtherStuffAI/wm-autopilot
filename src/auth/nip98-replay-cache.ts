import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";

export const NIP98_REPLAY_CACHE_LIMIT = 10_000;

interface ReplayCountRow {
  count: number;
}

/**
 * Durable replay protection shared by every worker using the same SQLite file.
 * Independent hosts must not serve one public origin with separate databases.
 */
export class Nip98ReplayCache {
  private readonly db: Database;

  constructor(
    private readonly limit = NIP98_REPLAY_CACHE_LIMIT,
    filePath = databaseFile,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("NIP-98 replay cache limit must be a positive integer");
    }

    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nip98_replay_events (
        event_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nip98_replay_events_expiry
        ON nip98_replay_events (expires_at, event_id);
    `);
  }

  accept(eventId: string, expiresAt: number, now: number): boolean {
    if (!eventId || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now) || expiresAt <= now) {
      return false;
    }

    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.deleteExpired(now);

      const existing = this.db
        .query<{ event_id: string }, [string]>("SELECT event_id FROM nip98_replay_events WHERE event_id = ?1")
        .get(eventId);
      if (existing) {
        this.db.exec("ROLLBACK");
        return false;
      }

      if (this.countEntries() >= this.limit) {
        this.db.exec("ROLLBACK");
        return false;
      }

      const inserted = this.db
        .query("INSERT OR IGNORE INTO nip98_replay_events (event_id, expires_at) VALUES (?1, ?2)")
        .run(eventId, expiresAt);
      if (inserted.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }

      this.db.exec("COMMIT");
      return true;
    } catch {
      this.rollbackAfterFailure();
      return false;
    }
  }

  cleanup(now: number): void {
    if (!Number.isSafeInteger(now)) return;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.deleteExpired(now);
      this.db.exec("COMMIT");
    } catch {
      this.rollbackAfterFailure();
    }
  }

  get size(): number {
    return this.countEntries();
  }

  close(): void {
    this.db.close();
  }

  private countEntries(): number {
    return this.db.query<ReplayCountRow, []>("SELECT COUNT(*) AS count FROM nip98_replay_events").get()?.count ?? 0;
  }

  private deleteExpired(now: number): void {
    this.db.query("DELETE FROM nip98_replay_events WHERE expires_at <= ?1").run(now);
  }

  private rollbackAfterFailure(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // No transaction was opened, or SQLite already rolled it back.
    }
  }
}
