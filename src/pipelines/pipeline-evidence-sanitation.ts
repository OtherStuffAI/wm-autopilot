import type { Database } from "bun:sqlite";
import { evidenceDigest } from "./pipeline-evidence-payloads";
import { evidenceFamily } from "./pipeline-evidence-scope";

interface Proof { version: 1; contextHash: string; references: number; }
interface Context { viewerEvidenceSanitation?: Proof; viewerEvidenceUnsafe?: boolean; }

/** A root attests immutable references, never stores credentials or duplicate bodies. */
export class PipelineEvidenceSanitation {
  private readonly contexts = new Map<string, string[]>();
  constructor(private readonly db: Database) {}

  prepare(root: string, base: string[], boundary: string[]) {
    const row = this.row(root);
    const context: Context = row ? JSON.parse(row.context_json) : {};
    const proof = context.viewerEvidenceSanitation;
    const count = this.count(root);
    const baseCredentials = Array.from(new Set(base.filter(Boolean)));
    const remembered = proof && proof.references === count
      ? this.contexts.get(`${root}:${proof.contextHash}`) : undefined;
    const reproducible = proof && proof.references === count && digest(baseCredentials) === proof.contextHash;
    const prior = remembered ?? (reproducible ? baseCredentials : undefined);
    const credentials = Array.from(new Set([...(prior ?? []), ...baseCredentials, ...boundary].filter(Boolean)));
    const priorSet = new Set(prior ?? []);
    const scan = credentials.filter(value => !priorSet.has(value));
    const uncertain = Boolean(proof && count && !prior);
    return { credentials, scan, uncertain, attest: () => {
      const current = this.row(root);
      if (!current) return;
      const next: Context = JSON.parse(current.context_json);
      if (next.viewerEvidenceUnsafe) return;
      const contextHash = digest(credentials);
      next.viewerEvidenceSanitation = { version: 1, contextHash, references: this.count(root) };
      this.db.query("UPDATE pipeline_run_snapshots SET context_json = ? WHERE run_id = ?").run(JSON.stringify(next), root);
      // A transaction rollback invalidates the new count/hash. Old checkpoints remain
      // usable; eviction simply falls back to bounded verification, never a safe skip.
      this.contexts.set(`${root}:${contextHash}`, credentials);
      if (this.contexts.size > 64) this.contexts.delete(this.contexts.keys().next().value!);
    } };
  }

  private row(root: string): { context_json: string } | null {
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_run_snapshots'").get()) return null;
    return this.db.query("SELECT context_json FROM pipeline_run_snapshots WHERE run_id = ?").get(root) as { context_json: string } | null;
  }

  private count(root: string): number {
    return (this.db.query(`${evidenceFamily(this.db)} SELECT count(*) AS count FROM pipeline_evidence evidence
      JOIN evidence_runs tree ON tree.id = evidence.run_id`).get(root) as { count: number }).count;
  }
}

function digest(credentials: string[]): string {
  return evidenceDigest(JSON.stringify(credentials.map(value => evidenceDigest(value)).sort()));
}
