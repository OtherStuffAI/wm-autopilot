import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { compositionEvidenceFamily } from "./pipeline-evidence-scope";

export function evidenceDigest(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

type EvidenceRow = Record<string, unknown>;
type RunAuthority = { id: string; owner_npub: string | null; owner_alias: string | null };

const rootEvidenceRows = `${compositionEvidenceFamily} SELECT evidence.* FROM pipeline_evidence evidence JOIN evidence_runs tree ON tree.id = evidence.run_id WHERE `;

/** Internal content storage; public reads still resolve run-bound evidence IDs. */
export class PipelineEvidencePayloads {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_evidence_payloads (
      id TEXT PRIMARY KEY, root_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
      content_hash TEXT NOT NULL, bytes INTEGER NOT NULL, value_json TEXT NOT NULL,
      UNIQUE(root_run_id, content_hash)
    )`);
    db.run(`CREATE TRIGGER IF NOT EXISTS pipeline_evidence_payloads_immutable_update BEFORE UPDATE ON pipeline_evidence_payloads BEGIN SELECT RAISE(ABORT, 'Pipeline evidence payload is immutable'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS pipeline_evidence_payloads_immutable_delete BEFORE DELETE ON pipeline_evidence_payloads BEGIN SELECT RAISE(ABORT, 'Pipeline evidence payload retention forbids deletion'); END`);
  }

  root(runId: string, stepId?: string): string {
    if (stepId && !this.db.query("SELECT 1 FROM pipeline_steps WHERE id = ? AND run_id = ?").get(stepId, runId)) {
      throw new Error("Pipeline evidence step/run mismatch");
    }
    const seen = new Set<string>();
    let run = this.run(runId);
    // Evidence can also be used on pre-composition schemas; each run is its own scope.
    const composition = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_child_runs'").get();
    while (composition) {
      if (seen.has(run.id)) throw new Error("Pipeline evidence composition cycle");
      seen.add(run.id);
      const link = this.db.query("SELECT parent_run_id, parent_step_id FROM pipeline_child_runs WHERE child_run_id = ?").get(run.id) as
        { parent_run_id: string; parent_step_id: string } | null;
      if (!link) break;
      const parent = this.run(link.parent_run_id);
      if (parent.owner_npub !== run.owner_npub || parent.owner_alias !== run.owner_alias ||
        !this.db.query("SELECT 1 FROM pipeline_steps WHERE id = ? AND run_id = ?").get(link.parent_step_id, parent.id)) {
        throw new Error("Pipeline evidence composition authority mismatch");
      }
      run = parent;
    }
    return run.id;
  }

  private run(id: string): RunAuthority {
    const run = this.db.query("SELECT id, owner_npub, owner_alias FROM pipeline_runs WHERE id = ?").get(id) as RunAuthority | null;
    if (!run) throw new Error("Missing pipeline evidence run authority");
    return run;
  }

  /** Source hashes preserve sanitization after retirement, including new wrapper aliases. */
  retainedSource(root: string, sourceHash: string): { value: unknown; redacted: boolean } | null {
    const rows = this.rootRows(root, `(source_hash = ? OR (redacted = 1 AND source_hash IS NULL))
      AND availability IN ('complete', 'redacted', 'preview_only') ORDER BY evidence.rowid`, sourceHash);
    let retained: { value: unknown; redacted: boolean } | null = null;
    let contentHash: unknown;
    for (const row of rows) {
      if (row.source_hash === null) throw new Error("Redacted historical evidence lacks exact source provenance; retain inline values for operator review");
      const value = this.read(row);
      if (!row.redacted) continue;
      if (retained && contentHash !== row.content_hash) throw new Error("Inconsistent pipeline evidence source/content digests");
      retained = { value, redacted: true };
      contentHash = row.content_hash;
    }
    return retained;
  }

  private rootRows(root: string, condition: string, hash: string): EvidenceRow[] {
    const composition = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_child_runs'").get();
    const query = composition ? rootEvidenceRows : "SELECT evidence.* FROM pipeline_evidence evidence WHERE run_id = ? AND ";
    return this.db.query(query + condition).all(root, hash) as EvidenceRow[];
  }

  refuseMissingProvenance(runId: string, stepId: string, kind: string): void {
    if (this.db.query(`SELECT 1 FROM pipeline_evidence WHERE run_id = ? AND step_id = ? AND kind = ?
      AND redacted = 1 AND source_hash IS NULL LIMIT 1`).get(runId, stepId, kind)) {
      throw new Error("Redacted historical evidence lacks exact source provenance; retain inline values for operator review");
    }
  }

  usedBytes(runId: string, hash: string): { used: number; repeated: boolean } {
    const sizes = new Map<string, number>();
    const rows = this.db.query(`SELECT content_hash, max(bytes) AS bytes, min(bytes) AS minimum FROM pipeline_evidence
      WHERE run_id = ? AND availability IN ('complete', 'redacted', 'preview_only') AND content_hash IS NOT NULL
      GROUP BY content_hash`).all(runId) as Array<{ content_hash: string; bytes: number; minimum: number }>;
    for (const row of rows) {
      if (row.bytes !== row.minimum) throw new Error("Inconsistent pipeline evidence budget digest/size");
      sizes.set(row.content_hash, row.bytes);
    }
    const legacy = this.db.query(`SELECT * FROM pipeline_evidence WHERE run_id = ? AND content_hash IS NULL
      AND availability IN ('complete', 'redacted', 'preview_only')`).all(runId) as EvidenceRow[];
    for (const row of legacy) {
      this.read(row);
      const digest = evidenceDigest(String(row.value_json));
      if (sizes.has(digest) && sizes.get(digest) !== row.bytes) throw new Error("Inconsistent pipeline evidence budget digest/size");
      sizes.set(digest, Number(row.bytes));
    }
    return { used: [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0), repeated: sizes.has(hash) };
  }

  intern(root: string, json: string, hash: string, bytes: number): string {
    const existing = this.db.query("SELECT * FROM pipeline_evidence_payloads WHERE root_run_id = ? AND content_hash = ?").get(root, hash) as EvidenceRow | null;
    if (existing) {
      if (existing.value_json !== json || existing.bytes !== bytes || evidenceDigest(String(existing.value_json)) !== hash) {
        throw new Error("Pipeline evidence payload digest collision or inconsistent body");
      }
      return String(existing.id);
    }
    const references = this.rootRows(root, "content_hash = ? AND payload_id IS NOT NULL", hash);
    for (const row of references) this.read(row);
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO pipeline_evidence_payloads (id, root_run_id, content_hash, bytes, value_json) VALUES (?, ?, ?, ?, ?)")
      .run(id, root, hash, bytes, json);
    return id;
  }

  read(row: EvidenceRow): unknown {
    let json = row.value_json;
    if (row.payload_id !== null && row.payload_id !== undefined) {
      const payload = this.db.query("SELECT * FROM pipeline_evidence_payloads WHERE id = ?").get(String(row.payload_id)) as EvidenceRow | null;
      if (!payload) throw new Error("Missing shared pipeline evidence payload");
      if (json !== null || payload.root_run_id !== this.root(String(row.run_id)) || payload.content_hash !== row.content_hash || payload.bytes !== row.bytes) {
        throw new Error("Inconsistent shared pipeline evidence payload reference");
      }
      json = payload.value_json;
    }
    if (json === null || json === undefined) {
      if (["complete", "redacted", "preview_only"].includes(String(row.availability))) throw new Error("Missing retained pipeline evidence body");
      return null;
    }
    if (!["complete", "redacted", "preview_only"].includes(String(row.availability)) || typeof json !== "string" ||
      Buffer.byteLength(json) !== row.bytes || (row.content_hash !== null && evidenceDigest(json) !== row.content_hash) ||
      (!row.redacted && row.source_hash && row.source_hash !== evidenceDigest(json))) {
      throw new Error("Pipeline evidence body digest or size mismatch");
    }
    try { return JSON.parse(json); } catch { throw new Error("Corrupt pipeline evidence JSON body"); }
  }
}
