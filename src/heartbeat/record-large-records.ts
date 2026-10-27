import { createHash } from "node:crypto";
import type { RecordSyncCache, Fence, AckIntent } from "./record-sync-cache.ts";
import type { RecordSyncClient } from "./record-sync-client.ts";
import { page, record, decimal, text, type Page, type JsonRecord } from "./record-sync-protocol.ts";

export const CHUNK_BYTES = 262_144;
// Explicit client resource ceiling, independent of Tower's wire page ceiling.
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;
export class LargeRecordIntegrityError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface Manifest {
  manifest_id: string; family: string; id: string; version: string;
  sha256: string; total_bytes: number; chunk_bytes: number; chunk_count: number;
}
export function manifests(p: Page): Manifest[] {
  if (!Array.isArray(p.large_records)) throw new Error("Missing negotiated large-record metadata");
  if (p.large_records.length > 1 || (p.large_records.length && (p.changes.length || p.actors.length)))
    throw new Error("Large-record manifest must occupy a standalone page");
  return p.large_records.map(value => {
    const m = record(value);
    if (!uuid.test(String(m.manifest_id)) || !/^[0-9a-f]{64}$/.test(String(m.sha256)) ||
      !p.families.includes(String(m.family)) || !Number.isSafeInteger(m.total_bytes) ||
      Number(m.total_bytes) < 1 || Number(m.total_bytes) > MAX_RECORD_BYTES ||
      m.chunk_bytes !== CHUNK_BYTES || !Number.isSafeInteger(m.chunk_count) ||
      m.chunk_count !== Math.ceil(Number(m.total_bytes) / CHUNK_BYTES))
      throw new Error("Invalid large-record manifest or record exceeds 64 MiB client limit");
    text(m.id, "large-record id"); decimal(m.version, "large-record version");
    return m as unknown as Manifest;
  });
}
export function stagedPage(cache: RecordSyncCache, fence: Fence): JsonRecord | null {
  const s = cache.assertWriter();
  if (s.clientId !== fence.clientId || s.generation !== fence.generation || s.cursor !== fence.cursor)
    throw new Error("Stale large-record stage fence");
  const saved = cache.db.query("SELECT cursor,page FROM large_record_stage WHERE generation=?")
    .get(s.generation) as { cursor: string; page: string } | null;
  if (saved && saved.cursor !== s.cursor) throw new Error("Large-record stage cursor mismatch");
  return saved ? JSON.parse(saved.page) : null;
}
export function discardStage(cache: RecordSyncCache): void {
  const s = cache.assertWriter();
  cache.db.transaction(() => {
    const staged = cache.db.query("SELECT cursor,page FROM large_record_stage WHERE generation=?").get(s.generation) as { cursor: string; page: string } | null;
    if (staged) {
      cache.db.query("INSERT INTO rejected_record_downloads(generation,cursor,kind,payload) VALUES(?,?,?,?)")
        .run(s.generation, staged.cursor, "manifest-page", Buffer.from(staged.page));
      for (const value of cache.db.query("SELECT manifest,idx,bytes FROM large_record_chunks WHERE generation=?").iterate(s.generation)) {
        const c = value as { manifest: string; idx: number; bytes: Uint8Array };
        cache.db.query("INSERT INTO rejected_record_downloads(generation,cursor,kind,payload) VALUES(?,?,?,?)")
          .run(s.generation, staged.cursor, `chunk:${c.manifest}:${c.idx}`, c.bytes);
      }
    }
    cache.db.query("DELETE FROM large_record_stage WHERE generation=?").run(s.generation);
    cache.db.query("DELETE FROM large_record_chunks WHERE generation=?").run(s.generation);
  }).immediate();
}

/** Durable chunks never advance the committed cursor. Only a verified canonical
 * envelope is handed to the cache's atomic rows/cursor/ack-intent transaction.
 */
export async function materializeLargeRecords(
  cache: RecordSyncCache, client: RecordSyncClient, p: Page, fence: Fence,
  base: string, workspaceId: string,
): Promise<{ payload: Page; receipts?: AckIntent["large_record_receipts"] }> {
  const entries = manifests(p);
  if (!entries.length) return { payload: p };
  const existing = stagedPage(cache, fence);
  if (existing && JSON.stringify(existing) !== JSON.stringify(p)) throw new Error("Large-record stage changed");
  cache.db.query("INSERT OR IGNORE INTO large_record_stage VALUES(?,?,?)")
    .run(fence.generation, fence.cursor, JSON.stringify(p));
  const receipts: NonNullable<AckIntent["large_record_receipts"]> = [];
  const changes = [...p.changes];
  const actors = [...p.actors];
  for (const m of entries) {
    for (let i = 0; i < m.chunk_count; i++) {
      cache.assertWriter();
      if (cache.db.query("SELECT 1 FROM large_record_chunks WHERE generation=? AND manifest=? AND idx=?")
        .get(fence.generation, m.manifest_id, i)) continue;
      const url = `${base}/clients/${encodeURIComponent(fence.clientId)}/pages/${encodeURIComponent(p.next_cursor)}/large-records/${m.manifest_id}/chunks/${i}?protocol_version=2`;
      const bytes = await client.chunk(url);
      const expected = Math.min(CHUNK_BYTES, m.total_bytes - i * CHUNK_BYTES);
      if (bytes.byteLength !== expected) throw new LargeRecordIntegrityError("Large-record chunk length mismatch");
      cache.assertWriter();
      cache.db.query("INSERT INTO large_record_chunks VALUES(?,?,?,?)")
        .run(fence.generation, m.manifest_id, i, bytes);
    }
    const hash = createHash("sha256");
    let length = 0;
    for (const row of cache.db.query("SELECT bytes FROM large_record_chunks WHERE generation=? AND manifest=? ORDER BY idx")
      .iterate(fence.generation, m.manifest_id)) {
      const bytes = (row as { bytes: Uint8Array }).bytes;
      hash.update(bytes); length += bytes.byteLength;
    }
    if (length !== m.total_bytes || hash.digest("hex") !== m.sha256)
      throw new LargeRecordIntegrityError("Large-record digest/length mismatch");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const row of cache.db.query("SELECT bytes FROM large_record_chunks WHERE generation=? AND manifest=? ORDER BY idx")
      .iterate(fence.generation, m.manifest_id)) {
      const chunk = (row as { bytes: Uint8Array }).bytes;
      bytes.set(chunk, offset); offset += chunk.byteLength;
    }
    let envelope: JsonRecord;
    try { envelope = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { throw new LargeRecordIntegrityError("Invalid large-record UTF-8/JSON envelope"); }
    const change = record(envelope.change);
    if (change.family !== m.family || change.id !== m.id || change.version !== m.version || !Array.isArray(envelope.actors))
      throw new LargeRecordIntegrityError("Large-record envelope identity mismatch");
    let verified: Page;
    try { verified = page({ ...p, changes: [change], actors: envelope.actors, large_records: [] }, fence.clientId, workspaceId, true); }
    catch (error) { throw new LargeRecordIntegrityError(`Invalid large-record canonical envelope: ${error instanceof Error ? error.message : String(error)}`); }
    changes.push(...verified.changes); actors.push(...verified.actors);
    receipts.push({ manifest_id: m.manifest_id, sha256: m.sha256 });
  }
  return { payload: page({ ...p, changes, actors, large_records: [] }, fence.clientId, workspaceId, true), receipts };
}
