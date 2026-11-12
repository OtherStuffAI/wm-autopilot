import type { Database } from "bun:sqlite";
import { configureRecordCacheCapacity } from "./record-cache-capacity.ts";

export function initializeRecordCache(db: Database): void {
  configureRecordCacheCapacity(db);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS review_continuations (cursor TEXT PRIMARY KEY, position TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_session (id INTEGER PRIMARY KEY CHECK(id=1), session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), partition TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rows (generation TEXT NOT NULL, family TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL,
        operation TEXT NOT NULL, scope TEXT, channel TEXT, resource_kind TEXT, updated TEXT NOT NULL, payload TEXT, active INTEGER NOT NULL,
        PRIMARY KEY(generation,family,id));
      CREATE INDEX IF NOT EXISTS review_rows ON rows(generation,operation,updated,family,id);
      CREATE INDEX IF NOT EXISTS active_rows ON rows(generation,operation,active,updated,family,id);
      CREATE TABLE IF NOT EXISTS actors (generation TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(generation,id));
      CREATE TABLE IF NOT EXISTS access (generation TEXT NOT NULL,family TEXT NOT NULL,kind TEXT NOT NULL,resource TEXT NOT NULL,
        resource_kind TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(generation,family,kind,resource,resource_kind));
      CREATE TABLE IF NOT EXISTS ack_intents (generation TEXT NOT NULL,client TEXT NOT NULL,cursor TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(generation,cursor));
      CREATE TABLE IF NOT EXISTS large_record_receipts (generation TEXT NOT NULL,cursor TEXT NOT NULL,receipts TEXT NOT NULL,PRIMARY KEY(generation,cursor));
      CREATE TABLE IF NOT EXISTS large_record_undo (generation TEXT NOT NULL,cursor TEXT NOT NULL,backup TEXT NOT NULL,PRIMARY KEY(generation,cursor));
      CREATE TABLE IF NOT EXISTS rejected_record_downloads (id INTEGER PRIMARY KEY,generation TEXT NOT NULL,cursor TEXT NOT NULL,kind TEXT NOT NULL,payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS large_record_stage (generation TEXT PRIMARY KEY,cursor TEXT NOT NULL,page TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS large_record_chunks (generation TEXT NOT NULL,manifest TEXT NOT NULL,idx INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(generation,manifest,idx));
    `);
}
