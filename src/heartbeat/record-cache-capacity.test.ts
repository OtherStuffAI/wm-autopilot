import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordSyncCache } from "./record-sync-cache.ts";
import { change, pagePayload } from "./record-sync-fixture.test-helper.ts";
import type { Page } from "./record-sync-protocol.ts";
import {
  configureRecordCacheCapacity, DEFAULT_RECORD_CACHE_BYTES,
  recordCacheError, recordCacheMaxBytes, recordCacheStorage,
} from "./record-cache-capacity.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cache-capacity-"));
  const path = join(root, "cache.sqlite");
  const partition = ["tower", "workspace", "app", "viewer"];
  const cache = new RecordSyncCache(path, partition);
  const s = cache.state();
  cache.register({ protocol_version: 2, client_id: s.clientId, authority_epoch: "epoch",
    initial_cursor: "bootstrap", checkpoint_cursor: null, checkpoint_revision: "0" },
  { clientId: s.clientId, generation: s.generation, cursor: null });
  return { root, path, partition, cache };
}

test("byte policy validates explicit bounds and accounts for non-default SQLite pages", () => {
  expect(recordCacheMaxBytes(undefined)).toBe(DEFAULT_RECORD_CACHE_BYTES);
  for (const value of ["", "0", "-1", "1.5", "1048576x", "1e9", "17179869185"])
    expect(() => recordCacheMaxBytes(value)).toThrow("integer byte count");
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA page_size=8192; CREATE TABLE data(payload BLOB)");
    configureRecordCacheCapacity(db, 1024 * 1024 + 1);
    expect(recordCacheStorage(db).limitBytes).toBe(1024 * 1024);
    expect(() => db.query("INSERT INTO data VALUES(zeroblob(?))").run(1200000)).toThrow("database or disk is full");
  } finally { db.close(); }
});

test("reopening a saturated legacy 256 MiB cache preserves identity, rows and pinned review", () => {
  const f = fixture();
  let cache = f.cache;
  try {
    const state = cache.state();
    cache.commit({ ...pagePayload([change("one"), change("two")], false),
      client_id: state.clientId, next_cursor: "snapshot" } as Page,
    { clientId: state.clientId, generation: state.generation, cursor: state.cursor }, true);
    const pending = cache.pending();
    const cursor = cache.review("2000", 262144, 1).nextCursor!;
    const saved = cache.state();
    cache.db.exec("CREATE TABLE retained_diagnostic(payload BLOB); PRAGMA max_page_count=65536");
    let error: unknown;
    for (let i = 0; i < 300; i++) {
      try { cache.db.query("INSERT INTO retained_diagnostic VALUES(zeroblob(1048576))").run(); }
      catch (caught) { error = caught; break; }
    }
    expect((error as Error).message).toBe("database or disk is full");
    const count = cache.db.query("SELECT count(*) AS n FROM retained_diagnostic").get();
    expect(recordCacheStorage(cache.db).allocatedBytes).toBeGreaterThan(250 * 1024 * 1024);
    cache.close();
    cache = new RecordSyncCache(f.path, f.partition);
    expect(cache.state()).toEqual(saved);
    expect(cache.pending()).toEqual(pending);
    expect(cache.counts()).toEqual({ task: 2 });
    expect(cache.review("ignored", 262144, 1, cursor).rows[0]?.id).toBe("two");
    expect(cache.db.query("SELECT count(*) AS n FROM retained_diagnostic").get()).toEqual(count);
    expect(recordCacheStorage(cache.db).limitBytes).toBe(DEFAULT_RECORD_CACHE_BYTES);
    cache.db.query("INSERT INTO retained_diagnostic VALUES(zeroblob(1048576))").run();
  } finally { cache.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("full page commit is atomic, reports bounds, and resumes after capacity is raised", () => {
  const f = fixture();
  const cache = f.cache;
  try {
    const before = cache.state();
    const fence = { clientId: before.clientId, generation: before.generation, cursor: before.cursor };
    const payload = { ...pagePayload([change("large", "task", "1", { body: "x".repeat(2 * 1024 * 1024) })]),
      client_id: before.clientId, next_cursor: "committed" } as Page;
    configureRecordCacheCapacity(cache.db, 1024 * 1024);
    let reported: unknown;
    try { cache.commit(payload, fence, true); }
    catch (error) { reported = recordCacheError(cache.db, error); }
    expect((reported as Error).message).toContain("configured ceiling 1048576 bytes");
    expect((reported as Error).message).toContain("Saved sync progress is retained");
    expect(cache.state()).toEqual(before);
    expect(cache.counts()).toEqual({});
    expect(cache.pending()).toBeNull();
    configureRecordCacheCapacity(cache.db);
    cache.commit(payload, fence, true);
    expect(cache.state().cursor).toBe("committed");
    expect(cache.pending()?.cursor).toBe("committed");
    expect(cache.counts()).toEqual({ task: 1 });
    expect(() => configureRecordCacheCapacity(cache.db, 1024 * 1024)).toThrow("already allocates");
    expect(recordCacheStorage(cache.db).limitBytes).toBe(DEFAULT_RECORD_CACHE_BYTES);
    const other = new Error("unrelated");
    expect(recordCacheError(cache.db, other)).toBe(other);
  } finally { cache.close(); rmSync(f.root, { recursive: true, force: true }); }
});
