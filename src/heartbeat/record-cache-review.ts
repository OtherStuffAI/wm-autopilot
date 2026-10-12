import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { CacheState } from "./record-sync-cache.ts";
import type { JsonRecord } from "./record-sync-protocol.ts";

interface ReviewPosition {
  id: string;
  phase: number;
  updated: string;
  family: string;
  rowId: string;
  delivered: number;
}
interface ReviewSession {
  id: string;
  fence: string;
  since: string;
  total: number;
}
export interface CacheReview {
  rows: JsonRecord[];
  truncated: boolean;
  unavailable: number;
  nextCursor: string | null;
  since: string;
  total: number;
  delivered: number;
}
const AUTHORITY = `NOT EXISTS(SELECT 1 FROM access a WHERE a.generation=r.generation AND a.family=r.family AND a.status='lost'
  AND (a.resource_kind='' OR a.resource_kind=r.resource_kind)
  AND (a.kind='workspace' OR (a.kind='channel' AND a.resource=r.channel) OR (a.kind='scope' AND a.resource=r.scope)))`;
function reviewFence(s: CacheState): string {
  return JSON.stringify([
    s.generation,
    s.cursor,
    s.accessRevision,
    s.epoch,
    s.available,
    s.certified,
    s.handoverDone,
  ]);
}
function position(db: Database, cursor: string): ReviewPosition {
  if (!/^[a-f0-9]{64}$/.test(cursor))
    throw new Error("Invalid review continuation");
  const saved = db
    .query("SELECT position FROM review_continuations WHERE cursor=?")
    .get(cursor) as { position: string } | null;
  if (!saved)
    throw new Error(
      "Review continuation missing; start a new review and report interrupted coverage",
    );
  return JSON.parse(saved.position) as ReviewPosition;
}
function continuation(db: Database, p: ReviewPosition): string {
  const serialized = JSON.stringify(p);
  const token = createHash("sha256").update(serialized).digest("hex");
  db.query("INSERT OR IGNORE INTO review_continuations VALUES(?,?)").run(
    token,
    serialized,
  );
  return token;
}

/** Keyset reads over a pinned cache checkpoint, never offsets or whole histories. */
export function readCacheReview(
  db: Database,
  s: CacheState,
  since: string,
  maxBytes = 262_144,
  maxRows = 200,
  cursor?: string,
): CacheReview {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 2 ||
    maxBytes > 262_144 ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 200
  )
    throw new Error("Review bounds must be <=200 rows and <=262144 bytes");
  const empty = {
    rows: [],
    truncated: false,
    unavailable: 1,
    nextCursor: null,
    since,
    total: 0,
    delivered: 0,
  };
  if (!s.available) {
    if (cursor)
      throw new Error(
        "Review authority unavailable; continuation cannot be consumed",
      );
    return empty;
  }
  let p: ReviewPosition;
  let session: ReviewSession;
  if (cursor) {
    p = position(db, cursor);
    const saved = db
      .query("SELECT session FROM review_session WHERE id=1")
      .get() as { session: string } | null;
    if (!saved) throw new Error("Review session missing; start a new review");
    session = JSON.parse(saved.session);
    if (session.id !== p.id || session.fence !== reviewFence(s))
      throw new Error(
        "Review checkpoint changed; start a new review and report interrupted coverage",
      );
  } else {
    const total = (
      db
        .query(`SELECT count(*) AS n FROM rows r WHERE r.generation=? AND r.operation='upsert'
      AND (r.active=1 OR r.updated>=?) AND ${AUTHORITY}`)
        .get(s.generation, since) as { n: number }
    ).n;
    db.exec("DELETE FROM review_continuations");
    session = { id: randomUUID(), fence: reviewFence(s), since, total };
    db.query("INSERT OR REPLACE INTO review_session VALUES(1,?)").run(
      JSON.stringify(session),
    );
    p = {
      id: session.id,
      phase: 0,
      updated: "",
      family: "",
      rowId: "",
      delivered: 0,
    };
  }
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
  for (; p.phase < 2; p.phase++) {
    const query = db.prepare(`SELECT r.family,r.id,r.version,r.channel,
      substr(json_extract(r.payload,'$.title'),1,500) AS title,
      substr(json_extract(r.payload,'$.state'),1,100) AS state,
      substr(json_extract(r.payload,'$.body'),1,1000) AS excerpt,
      json_extract(r.payload,'$.task_id') AS taskId,json_extract(r.payload,'$.thread_id') AS threadId,r.updated
      FROM rows r WHERE r.generation=? AND r.operation='upsert'
      AND ${p.phase === 0 ? "r.active=1 AND r.updated<?" : "r.updated>=?"}
      AND (r.updated,r.family,r.id)>(?,?,?) AND ${AUTHORITY}
      ORDER BY r.updated,r.family,r.id LIMIT ?`);
    try {
      for (const row of query.iterate(
        s.generation,
        session.since,
        p.updated,
        p.family,
        p.rowId,
        maxRows + 1,
      )) {
        const r = row as JsonRecord;
        const size = Buffer.byteLength(JSON.stringify(r)) + 1;
        if (rows.length === maxRows || bytes + size > maxBytes) {
          if (!rows.length)
            throw new Error(
              "One review summary exceeds byte budget; continuation cannot advance",
            );
          truncated = true;
          break;
        }
        rows.push(r);
        bytes += size;
        p.updated = String(r.updated);
        p.family = String(r.family);
        p.rowId = String(r.id);
        p.delivered++;
      }
    } finally {
      query.finalize();
    }
    if (truncated) break;
    p.updated = "";
    p.family = "";
    p.rowId = "";
  }
  return {
    rows,
    truncated,
    unavailable: lost,
    since: session.since,
    total: session.total,
    delivered: p.delivered,
    nextCursor: truncated ? continuation(db, p) : null,
  };
}

export function readCacheCounts(
  db: Database,
  generation: string,
): Record<string, number> {
  const counts = db
    .query(
      "SELECT family,count(*) AS n FROM rows WHERE generation=? AND operation='upsert' GROUP BY family",
    )
    .all(generation) as { family: string; n: number }[];
  return Object.fromEntries(counts.map((r) => [r.family, r.n]));
}
