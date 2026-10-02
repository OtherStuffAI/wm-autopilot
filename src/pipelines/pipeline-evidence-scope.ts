import type { Database } from "bun:sqlite";

/** The same durable owner/alias/parent-step boundary for every evidence projection. */
export const compositionEvidenceFamily = `WITH RECURSIVE evidence_runs(id) AS (
  SELECT ? UNION SELECT link.child_run_id FROM evidence_runs tree
  JOIN pipeline_child_runs link ON link.parent_run_id = tree.id
  JOIN pipeline_runs parent ON parent.id = link.parent_run_id
  JOIN pipeline_runs child ON child.id = link.child_run_id
  JOIN pipeline_steps step ON step.id = link.parent_step_id AND step.run_id = parent.id
  WHERE parent.owner_npub IS child.owner_npub AND parent.owner_alias IS child.owner_alias
)`;

export function evidenceFamily(db: Database): string {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_child_runs'").get()
    ? compositionEvidenceFamily : "WITH evidence_runs(id) AS (SELECT ?)";
}

/** Search decoded retained JSON in SQLite, never hydrate or duplicate full bodies. */
export function retainedCredentialExposure(db: Database, rootId: string, credentials: Iterable<string>, scanBytes: number): boolean {
  const unique = new Set(Array.from(credentials).filter(Boolean));
  if (!unique.size) return false;
  const family = evidenceFamily(db);
  const shared = db.query(`${family} SELECT coalesce(sum(payload.bytes), 0) AS bytes FROM pipeline_evidence_payloads payload
    WHERE payload.root_run_id = ? AND EXISTS (SELECT 1 FROM pipeline_evidence evidence JOIN evidence_runs tree ON tree.id = evidence.run_id
      WHERE evidence.payload_id = payload.id)`).get(rootId, rootId) as { bytes: number };
  const legacy = db.query(`${family} SELECT coalesce(sum(evidence.bytes), 0) AS bytes FROM pipeline_evidence evidence
    JOIN evidence_runs tree ON tree.id = evidence.run_id WHERE evidence.value_json IS NOT NULL`).get(rootId) as { bytes: number };
  // Refuse an unprovable projection explicitly rather than perform unbounded body scans.
  if ((shared.bytes + legacy.bytes) * unique.size > scanBytes) return true;
  for (const credential of unique) {
    if (db.query(`${family} SELECT 1 FROM pipeline_evidence_payloads payload
      WHERE payload.root_run_id = ?
      AND EXISTS (SELECT 1 FROM pipeline_evidence evidence JOIN evidence_runs tree ON tree.id = evidence.run_id
        WHERE evidence.payload_id = payload.id)
      AND EXISTS (SELECT 1 FROM json_tree(payload.value_json) entry
        WHERE (entry.type = 'text' AND instr(entry.value, ?) > 0) OR (typeof(entry.key) = 'text' AND instr(entry.key, ?) > 0))
      LIMIT 1`).get(rootId, rootId, credential, credential)) return true;
    if (db.query(`${family} SELECT 1 FROM pipeline_evidence evidence JOIN evidence_runs tree ON tree.id = evidence.run_id
      WHERE evidence.value_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_tree(evidence.value_json) entry
        WHERE (entry.type = 'text' AND instr(entry.value, ?) > 0) OR (typeof(entry.key) = 'text' AND instr(entry.key, ?) > 0))
      LIMIT 1`).get(rootId, credential, credential)) return true;
  }
  return false;
}
