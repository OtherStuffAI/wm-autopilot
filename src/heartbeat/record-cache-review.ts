import type { Database } from "bun:sqlite";
import type { CacheState } from "./record-sync-cache.ts";
import type { JsonRecord } from "./record-sync-protocol.ts";

export function readCacheReview(
  db: Database,
  s: CacheState,
  since: string,
  maxBytes = 262_144,
  maxRows = 200,
): { rows: JsonRecord[]; truncated: boolean; unavailable: number } {
  if (!s.available) return { rows: [], truncated: false, unavailable: 1 };
  const lost = (
    db
      .query(
        "SELECT count(*) AS n FROM access WHERE generation=? AND status='lost'",
      )
      .get(s.generation) as { n: number }
  ).n;
  const rows: JsonRecord[] = [];
  let bytes = 2;
  let truncated = false;
  // The indexed timestamp slice reads summaries only; no duplicate whole raw history.
  const query = (olderActive: boolean) =>
    db.query(`SELECT r.family,r.id,r.version,r.channel,substr(json_extract(r.payload,'$.title'),1,500) AS title,
      substr(json_extract(r.payload,'$.state'),1,100) AS state,substr(json_extract(r.payload,'$.body'),1,1000) AS excerpt,
      json_extract(r.payload,'$.task_id') AS taskId,json_extract(r.payload,'$.thread_id') AS threadId,r.updated
      FROM rows r WHERE r.generation=? AND r.operation='upsert' AND ${olderActive ? "r.active=1 AND r.updated<?" : "r.updated>=?"}
      AND NOT EXISTS(SELECT 1 FROM access a WHERE a.generation=r.generation AND a.family=r.family AND a.status='lost'
        AND (a.resource_kind='' OR a.resource_kind=r.resource_kind)
        AND (a.kind='workspace' OR (a.kind='channel' AND a.resource=r.channel) OR (a.kind='scope' AND a.resource=r.scope)))
      ORDER BY r.updated,r.family,r.id LIMIT ?`);
  for (const olderActive of [true, false]) {
    for (const row of query(olderActive).iterate(
      s.generation,
      since,
      maxRows + 1,
    )) {
      const r = row as JsonRecord;
      const size = Buffer.byteLength(JSON.stringify(r)) + 1;
      if (rows.length === maxRows || bytes + size > maxBytes) {
        truncated = true;
        break;
      }
      rows.push(r);
      bytes += size;
    }
    if (truncated) break;
  }
  return { rows, truncated, unavailable: lost };
}
