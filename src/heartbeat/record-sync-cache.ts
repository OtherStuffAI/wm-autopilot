import { initializeRecordCache } from "./record-cache-schema.ts";
import { readCacheReview, readCacheCounts } from "./record-cache-review.ts";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Access,
  type Page,
  type Registration,
  record,
  handover,
} from "./record-sync-protocol.ts";

export interface CacheState {
  clientId: string;
  generation: string;
  cursor: string | null;
  epoch: string | null;
  target: string | null;
  through: string | null;
  certified: boolean;
  revision: string;
  snapshotId: string | null;
  snapshotDone: boolean;
  handoverDone: boolean;
  families: string[];
  partitions: string[];
  accessRevision: string | null;
  available: boolean;
}
export interface AckIntent {
  cursor: string;
  expected_revision: string;
  clientId: string;
  generation: string;
}
export interface Fence {
  cursor: string | null;
  clientId: string;
  generation: string;
}
function fresh(): CacheState {
  return {
    clientId: randomUUID(),
    generation: randomUUID(),
    cursor: null,
    epoch: null,
    target: null,
    through: null,
    certified: false,
    revision: "0",
    snapshotId: null,
    snapshotDone: false,
    handoverDone: false,
    families: [],
    partitions: [],
    accessRevision: null,
    available: false,
  };
}
export function cachePath(root: string, partition: string[]): string {
  return join(
    root,
    `${createHash("sha256").update(JSON.stringify(partition)).digest("hex")}.sqlite`,
  );
}
/** One file per Tower/workspace/app/viewer; random cache identity lives WITH rows. */
export class RecordSyncCache {
  readonly db: Database;
  readonly lease = randomUUID();
  constructor(
    readonly path: string,
    readonly partition: string[],
    readonly leaseMs = 150_000,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    initializeRecordCache(this.db);
    try {
      this.db
        .transaction(() => {
          const existing = this.db
            .query("SELECT token,expires FROM lease WHERE id=1")
            .get() as { token: string; expires: number } | null;
          if (existing && existing.expires > Date.now())
            throw new Error(
              "Heartbeat cache writer lease is held by another process",
            );
          this.db
            .query("INSERT OR REPLACE INTO lease VALUES(1,?,?)")
            .run(this.lease, Date.now() + leaseMs);
          const meta = this.db
            .query("SELECT partition FROM meta WHERE id=1")
            .get() as { partition: string } | null;
          if (meta && meta.partition !== JSON.stringify(partition))
            throw new Error("Cache partition mismatch");
          if (!meta)
            this.db
              .query("INSERT INTO meta VALUES(1,?,?)")
              .run(JSON.stringify(partition), JSON.stringify(fresh()));
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  state(): CacheState {
    return JSON.parse(
      (
        this.db.query("SELECT state FROM meta WHERE id=1").get() as {
          state: string;
        }
      ).state,
    );
  }
  private assertFence(fence?: Fence): CacheState {
    const lease = this.db
      .query("SELECT token,expires FROM lease WHERE id=1")
      .get() as { token: string; expires: number } | null;
    if (lease?.token !== this.lease || lease.expires <= Date.now())
      throw new Error("Stale cache writer lease");
    const state = this.state();
    if (
      fence &&
      (state.clientId !== fence.clientId ||
        state.generation !== fence.generation ||
        state.cursor !== fence.cursor)
    )
      throw new Error("Stale page response fenced");
    return state;
  }
  private save(state: CacheState): void {
    this.db
      .query("UPDATE meta SET state=? WHERE id=1")
      .run(JSON.stringify(state));
  }
  unavailable(): void {
    this.db
      .transaction(() => {
        const state = this.assertFence();
        state.available = false;
        state.handoverDone = false;
        this.save(state);
      })
      .immediate();
  }
  repair(): void {
    this.db
      .transaction(() => {
        this.assertFence();
        // Preserve every downloaded generation and pending intent for diagnosis/resolution.
        this.db
          .query(
            "UPDATE ack_intents SET status='repair' WHERE status='pending'",
          )
          .run();
        this.save(fresh());
      })
      .immediate();
  }
  register(r: Registration, fence: Fence): void {
    this.db
      .transaction(() => {
        const s = this.assertFence(fence);
        if (s.epoch && s.epoch !== r.authority_epoch)
          throw new Error(
            "Authority epoch changed; continuation repair required",
          );
        if (BigInt(r.checkpoint_revision) < BigInt(s.revision)) throw new Error("Checkpoint revision regressed");
        s.epoch = r.authority_epoch;
        if (!s.cursor) {
          if (r.checkpoint_cursor !== null)
            throw new Error(
              "Cache rows absent; cannot adopt server checkpoint",
            );
          s.cursor = r.initial_cursor;
        }
        s.revision = r.checkpoint_revision;
        this.save(s);
      })
      .immediate();
  }
  commit(p: Page, fence: Fence, bounded = false): void {
    this.db
      .transaction(() => {
        const s = this.assertFence(fence);
        if (this.pending())
          throw new Error(
            "Pending acknowledgement must reconcile before paging",
          );
        if (p.client_id !== s.clientId || p.next_cursor === s.cursor)
          throw new Error("Duplicate/stale page cursor");
        if (
          s.families.length &&
          JSON.stringify([...s.families].sort()) !==
            JSON.stringify([...p.families].sort())
        )
          throw new Error("Advertised families changed; repair required");
        if (
          p.mode === "snapshot" &&
          (s.snapshotDone || (s.snapshotId && p.snapshot_id !== s.snapshotId))
        )
          throw new Error("Stale snapshot generation");
        if (p.mode === "delta" && !s.snapshotDone)
          throw new Error("Delta before complete snapshot");
        if (
          s.accessRevision !== null &&
          BigInt(p.access_revision) < BigInt(s.accessRevision)
        )
          throw new Error("Stale authority response");
        if (bounded) {
          const h = handover(p);
          if (h.authority_epoch !== s.epoch)
            throw new Error("Handover authority epoch mismatch");
          if (
            !s.certified &&
            s.target !== null &&
            h.target_position !== s.target
          )
            throw new Error("Fixed handover target changed during traversal");
          if (
            s.through !== null &&
            BigInt(h.through_position) < BigInt(s.through)
          )
            throw new Error("Handover position regressed");
          s.target = h.target_position;
          s.through = h.through_position;
          s.certified = h.complete;
        } else s.certified = false;
        for (const c of p.changes) {
          const old = this.db
            .query(
              "SELECT version,operation,payload FROM rows WHERE generation=? AND family=? AND id=?",
            )
            .get(s.generation, c.family, c.id) as {
            version: string;
            operation: string;
            payload: string | null;
          } | null;
          const payload = c.row === null ? null : JSON.stringify(c.row);
          if (old && BigInt(c.version) < BigInt(old.version)) continue;
          if (old && c.version === old.version) {
            if (old.operation === "delete") continue;
            if (c.operation === "upsert" && old.payload !== payload)
              throw new Error("Inconsistent canonical row at same version");
          }
          const r = record(c.row);
          const stamp =
            typeof r.updated_at === "string"
              ? r.updated_at
              : typeof r.created_at === "string"
                ? r.created_at
                : "";
          const parsed = Date.parse(stamp);
          const updated = Number.isFinite(parsed)
            ? new Date(parsed).toISOString()
            : "";
          this.db
            .query("INSERT OR REPLACE INTO rows VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              s.generation,
              c.family,
              c.id,
              c.version,
              c.operation,
              c.scope_id,
              c.channel_id,
              typeof r.resource_type === "string" ? r.resource_type : null,
              updated,
              payload,
              c.family === "task" &&
                ["new", "ready", "in_progress", "review", "blocked"].includes(
                  String(r.state),
                )
                ? 1
                : 0,
            );
        }
        for (const a of p.actors)
          this.db
            .query("INSERT OR REPLACE INTO actors VALUES(?,?,?)")
            .run(s.generation, String(a.actor_id), JSON.stringify(a));
        for (const a of p.access_changes) this.writeAccess(s.generation, a);
        s.families = p.families;
        if (p.mode === "snapshot") {
          s.snapshotId = p.snapshot_id;
          s.snapshotDone = p.snapshot_complete;
          s.partitions = p.partitions_complete;
        }
        s.handoverDone =
          p.mode === "delta" && !p.has_more && p.catchup === null;
        s.available = true;
        s.accessRevision = p.access_revision;
        s.cursor = p.next_cursor;
        s.revision = p.checkpoint_revision;
        this.save(s);
        this.db
          .query("INSERT INTO ack_intents VALUES(?,?,?,?, 'pending')")
          .run(s.generation, s.clientId, p.next_cursor, p.checkpoint_revision);
      })
      .immediate();
  }
  private writeAccess(generation: string, a: Access): void {
    this.db
      .query("INSERT OR REPLACE INTO access VALUES(?,?,?,?,?,?)")
      .run(
        generation,
        a.family,
        a.resource_type,
        a.resource_id,
        a.resource_kind ?? "",
        a.status,
      );
  }
  pending(): AckIntent | null {
    const s = this.state();
    const r = this.db
      .query(
        "SELECT cursor,revision,client FROM ack_intents WHERE generation=? AND status='pending'",
      )
      .get(s.generation) as {
      cursor: string;
      revision: string;
      client: string;
    } | null;
    return r
      ? {
          cursor: r.cursor,
          expected_revision: r.revision,
          clientId: r.client,
          generation: s.generation,
        }
      : null;
  }
  ack(r: Registration, intent: AckIntent): void {
    this.db
      .transaction(() => {
        const s = this.assertFence({
          cursor: intent.cursor,
          clientId: intent.clientId,
          generation: intent.generation,
        });
        if (
          r.authority_epoch !== s.epoch ||
          r.checkpoint_cursor !== intent.cursor ||
          BigInt(r.checkpoint_revision) < BigInt(intent.expected_revision)
        )
          throw new Error("Acknowledgement does not match committed rows");
        s.revision = r.checkpoint_revision;
        this.save(s);
        this.db
          .query("DELETE FROM ack_intents WHERE generation=? AND cursor=?")
          .run(s.generation, intent.cursor);
      })
      .immediate();
  }
  replayConflict(r: Registration, intent: AckIntent): void {
    this.db
      .transaction(() => {
        const s = this.assertFence({
          cursor: intent.cursor,
          clientId: intent.clientId,
          generation: intent.generation,
        });
        if (r.authority_epoch !== s.epoch)
          throw new Error("Authority epoch changed during acknowledgement");
        // Keep the local cursor. Server metadata never materialises absent rows.
        s.revision = r.checkpoint_revision;
        s.handoverDone = false;
        this.save(s);
        this.db
          .query("UPDATE ack_intents SET status='conflict' WHERE generation=?")
          .run(s.generation);
      })
      .immediate();
  }
  counts(): Record<string, number> {
    return readCacheCounts(this.db, this.state().generation);
  }
  review(since: string, maxBytes = 262_144, maxRows = 200, cursor?: string) {
    return this.db.transaction(() => readCacheReview(
      this.db, this.assertFence(), since, maxBytes, maxRows, cursor,
    )).immediate();
  }
  close(): void {
    this.db.query("DELETE FROM lease WHERE id=1 AND token=?").run(this.lease);
    this.db.close();
  }
}
