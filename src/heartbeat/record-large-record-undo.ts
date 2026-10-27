import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { CacheState, RecordSyncCache } from "./record-sync-cache.ts";
import type { Page } from "./record-sync-protocol.ts";

type Cell = string | number | null;
interface BeforeRow { table: string; keys: Record<string, Cell>; row: Record<string, Cell> | null }
interface BeforeImage { state: CacheState; rows: BeforeRow[] }
/** Called inside the same transaction as canonical page commit. Large-record
 * authority/source can change before first ack; retain exact rollback evidence.
 */
export function saveLargeRecordUndo(db: Database, s: CacheState, p: Page): void {
  const rows: BeforeRow[] = [];
  function capture(table: string, keys: Record<string, Cell>): void {
    const where = Object.keys(keys).map(key => `${key}=?`).join(" AND ");
    const row = db.query(`SELECT * FROM ${table} WHERE ${where}`).get(...Object.values(keys)) as Record<string, Cell> | null;
    rows.push({ table, keys, row });
  }
  for (const c of p.changes) capture("rows", { generation: s.generation, family: c.family, id: c.id });
  for (const a of p.actors) capture("actors", { generation: s.generation, id: String(a.actor_id) });
  for (const a of p.access_changes) capture("access", { generation: s.generation, family: a.family,
    kind: a.resource_type, resource: a.resource_id, resource_kind: a.resource_kind ?? "" });
  db.query("INSERT INTO large_record_undo VALUES(?,?,?)").run(s.generation, p.next_cursor, JSON.stringify({ state: s, rows }));
}
export function rollbackLargeRecord(cache: RecordSyncCache): void {
  cache.db.transaction(() => {
    const state = cache.assertWriter();
    const intent = cache.pending();
    if (!intent?.large_record_receipts?.length) return;
    const saved = cache.db.query("SELECT backup FROM large_record_undo WHERE generation=? AND cursor=?")
      .get(state.generation, intent.cursor) as { backup: string } | null;
    if (!saved) throw new Error("Large-record rollback evidence missing");
    const backup = JSON.parse(saved.backup) as BeforeImage;
    if (state.cursor !== intent.cursor || backup.state.generation !== state.generation || backup.state.clientId !== state.clientId)
      throw new Error("Large-record rollback fence mismatch");
    for (const entry of backup.rows) {
      const where = Object.keys(entry.keys).map(key => `${key}=?`).join(" AND ");
      const rejected = cache.db.query(`SELECT * FROM ${entry.table} WHERE ${where}`).get(...Object.values(entry.keys));
      if (rejected) cache.db.query("INSERT INTO rejected_record_downloads(generation,cursor,kind,payload) VALUES(?,?,?,?)")
        .run(state.generation, intent.cursor, entry.table, Buffer.from(JSON.stringify(rejected)));
      cache.db.query(`DELETE FROM ${entry.table} WHERE ${where}`).run(...Object.values(entry.keys));
      if (entry.row) cache.db.query(`INSERT INTO ${entry.table} (${Object.keys(entry.row).join(",")}) VALUES(${Object.keys(entry.row).map(() => "?").join(",")})`)
        .run(...Object.values(entry.row) as SQLQueryBindings[]);
    }
    backup.state.available = false;
    backup.state.handoverDone = false;
    cache.db.query("UPDATE meta SET state=? WHERE id=1").run(JSON.stringify(backup.state));
    cache.db.query("DELETE FROM ack_intents WHERE generation=? AND cursor=?").run(state.generation, intent.cursor);
    cache.db.query("DELETE FROM large_record_receipts WHERE generation=? AND cursor=?").run(state.generation, intent.cursor);
    cache.db.query("DELETE FROM large_record_undo WHERE generation=? AND cursor=?").run(state.generation, intent.cursor);
  }).immediate();
}
