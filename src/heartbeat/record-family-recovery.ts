import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runHeartbeatWake, type HeartbeatWakeOptions } from "./heartbeat-wake.ts";
import { runHeartbeatCatchUp, type HeartbeatWakeResult } from "./heartbeat-catch-up.ts";
import { RecordSyncCache } from "./record-sync-cache.ts";
import { unfinishedFamilies } from "./record-family-compatibility.ts";

function openCache(path: string): RecordSyncCache {
  const db = new Database(path, { readonly: true });
  let partition: string[];
  try {
    partition = JSON.parse((db.query("SELECT partition FROM meta WHERE id=1").get() as { partition: string }).partition);
  } finally { db.close(); }
  return new RecordSyncCache(path, partition);
}

/** Import only an independently bootstrapped family, never another client's checkpoint. */
export function mergeFamilyBootstrap(primary: RecordSyncCache, supplement: RecordSyncCache, generation: string): void {
  primary.db.transaction(() => {
    const p = primary.assertWriter();
    const s = supplement.assertWriter();
    if (p.generation !== generation || JSON.stringify(primary.partition) !== JSON.stringify(supplement.partition))
      throw new Error("Family bootstrap cache identity changed");
    if (!p.available || !s.available || !p.certified || !s.certified || !p.handoverDone || !s.handoverDone
      || primary.pending() || supplement.pending() || primary.authority().unavailable || supplement.authority().unavailable) throw new Error("Family bootstrap requires acknowledged terminal checkpoints");
    if (p.epoch !== s.epoch || p.accessRevision !== s.accessRevision)
      throw new Error("Family bootstrap authority changed; fresh aligned proof required");
    if (p.through === null || s.through === null || BigInt(p.through) < BigInt(s.through))
      throw new Error("Primary checkpoint precedes family bootstrap");
    const missing = unfinishedFamilies(p);
    if (missing.some(f => !s.families.includes(f) || !s.partitions.includes(f)))
      throw new Error("Supplementary snapshot lacks required family coverage");
    if (p.families.some(f => !s.families.includes(f)) || s.families.some(f => !p.families.includes(f)))
      throw new Error("Family bootstrap advertisement changed");
    // SQL selects bounded batches; never materialize a whole downloaded history.
    for (const family of missing) {
      let after = "";
      while (true) {
        const rows = supplement.db.query("SELECT * FROM rows WHERE generation=? AND family=? AND id>? ORDER BY id LIMIT 200")
          .all(s.generation, family, after) as { id: string; version: string; operation: string; scope: string | null; channel: string | null;
            resource_kind: string | null; updated: string; payload: string | null; active: number }[];
        if (!rows.length) break;
        for (const r of rows) {
          const old = primary.db.query("SELECT version,operation,payload FROM rows WHERE generation=? AND family=? AND id=?")
            .get(p.generation, family, r.id) as { version: string; operation: string; payload: string | null } | null;
          if (old && (BigInt(old.version) > BigInt(r.version) || (old.version === r.version && old.operation === "delete"))) continue;
          if (old && old.version === r.version && old.operation === r.operation && old.payload !== r.payload)
            throw new Error("Inconsistent family bootstrap row at same version");
          primary.db.query("INSERT OR REPLACE INTO rows VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .run(p.generation, family, r.id, r.version, r.operation, r.scope, r.channel, r.resource_kind, r.updated, r.payload, r.active);
        }
        after = rows.at(-1)!.id;
      }
    }
    // Actor sidecars are profiles, not authority. Preserve primary observations.
    for (const actor of supplement.db.query("SELECT id,payload FROM actors WHERE generation=?").iterate(s.generation)) {
      const a = actor as { id: string; payload: string };
      primary.db.query("INSERT OR IGNORE INTO actors VALUES(?,?,?)").run(p.generation, a.id, a.payload);
    }
    primary.assertWriter();
    supplement.assertWriter();
    p.partitions = [...new Set([...p.partitions, ...missing])];
    primary.db.query("UPDATE meta SET state=? WHERE id=1").run(JSON.stringify(p));
    // Record provenance durably with the rows and completeness transition.
    primary.db.exec("CREATE TABLE IF NOT EXISTS family_bootstraps (family TEXT PRIMARY KEY, proof TEXT NOT NULL)");
    for (const family of missing)
      primary.db.query("INSERT OR REPLACE INTO family_bootstraps VALUES(?,?)")
        .run(family, JSON.stringify({ primaryGeneration: generation, primaryCursor: p.cursor, primaryThrough: p.through, clientId: s.clientId, generation: s.generation,
          through: s.through, epoch: s.epoch, accessRevision: s.accessRevision, cursor: s.cursor }));
  }).immediate();
}

function onlyFamilyGap(r: HeartbeatWakeResult): boolean {
  return r.coverage.deltaHandoverObserved && !r.cache.pendingAck && !r.coverage.unavailablePartitions
    && r.errors.every(e => e.startsWith("Snapshot coverage unavailable for advertised families:"));
}

/** Explicit, resumable recovery. A deterministic supplementary cache never replaces primary identity. */
export async function recoverHeartbeatFamilies(
  options: HeartbeatWakeOptions,
  maxWakes = 100,
  onWake: (result: HeartbeatWakeResult, phase: string, n: number) => void | Promise<void> = () => {},
) {
  options = { ...options, preserveCacheOnRepair: true };
  if (options.reviewOnly || options.reviewCursor) throw new Error("Family recovery cannot consume indexed review");
  const initial = await runHeartbeatCatchUp(options, maxWakes, (r, n) => onWake(r, "primary", n));
  if (initial.result.syncComplete || !onlyFamilyGap(initial.result)) return { outcome: initial.outcome, result: initial.result };
  const primaryPath = initial.result.cache.path;
  const generation = initial.result.cache.generation;
  const supplementRoot = join(`${primaryPath}.family-bootstrap`, generation);
  // Hold the primary writer lease during each supplementary wake. Release only
  // between bounded wakes; every reacquisition checks the retained generation.
  const supplementary = await runHeartbeatCatchUp({ ...options, cacheRoot: supplementRoot }, maxWakes,
    (r, n) => onWake(r, "supplement", n), async (supplementOptions) => {
      const primary = openCache(primaryPath);
      try {
        if (primary.state().generation !== generation) throw new Error("Primary generation changed during family recovery");
        return await runHeartbeatWake(supplementOptions);
      } finally { primary.close(); }
    });
  if (!supplementary.result.syncComplete) return { outcome: supplementary.outcome, result: supplementary.result };
  // Replay the primary journal past the supplementary snapshot/delta boundary
  // before importing rows: intervening updates and tombstones must win.
  const aligned = await runHeartbeatCatchUp(options, maxWakes, (r, n) => onWake(r, "align-primary", n));
  if (!onlyFamilyGap(aligned.result)) return { outcome: aligned.outcome, result: aligned.result };
  const primary = openCache(primaryPath);
  try {
    const supplement = openCache(supplementary.result.cache.path);
    try { mergeFamilyBootstrap(primary, supplement, generation); }
    finally { supplement.close(); }
    const state = primary.state();
    const result: HeartbeatWakeResult = {
      ...aligned.result,
      generatedAt: new Date().toISOString(),
      syncComplete: true,
      syncOutcome: "certified",
      errors: [],
      review: { ...aligned.result.review, syncCertified: true },
      coverage: { ...aligned.result.coverage, certifiedBoundary: true,
        completedFamilies: state.partitions, unfinishedFamilies: unfinishedFamilies(state),
        downloadedCounts: primary.counts() },
    };
    await onWake(result, "merged", 1);
    return { outcome: "certified" as const, result };
  } finally { primary.close(); }
}
