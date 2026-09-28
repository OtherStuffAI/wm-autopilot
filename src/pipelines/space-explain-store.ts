import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ExplainRun {
  id: string;
  owner: string;
  request_id: string;
  input_hash: string;
  status: "running" | "completed" | "error";
  created_at: number;
  output_json: string | null;
  error: string | null;
}

/** Private storage contains hashes and validated output, never raw question, hints or answers. */
export class SpaceExplainStore {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS space_explain_runs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, output_json TEXT, error TEXT,
        UNIQUE(owner, request_id)
      );`);
  }

  close(): void { this.db.close(); }

  get(owner: string, id: string): ExplainRun | null {
    const run = this.db.query<ExplainRun, [string, string]>("SELECT * FROM space_explain_runs WHERE owner=? AND id=?").get(owner, id);
    if (run?.status === "running" && Date.now() - run.created_at > 180_000) {
      this.fail(id, "timeout");
      return this.get(owner, id);
    }
    return run;
  }

  reserve(owner: string, requestId: string, hash: string): { run: ExplainRun; replayed: boolean } {
    return this.db.transaction(() => {
      const prior = this.db.query<ExplainRun, [string, string]>("SELECT * FROM space_explain_runs WHERE owner=? AND request_id=?").get(owner, requestId);
      if (prior) {
        if (prior.input_hash !== hash) throw new Error("idempotency_conflict");
        return { run: this.get(owner, prior.id)!, replayed: true };
      }
      const active = this.db.query<{ count: number }, [string, number]>("SELECT count(*) AS count FROM space_explain_runs WHERE owner=? AND created_at>? AND status='running'").get(owner, Date.now() - 180_000)!;
      const recent = this.db.query<{ count: number }, [string, number]>("SELECT count(*) AS count FROM space_explain_runs WHERE owner=? AND created_at>?").get(owner, Date.now() - 3600_000)!;
      const global = this.db.query<{ count: number }, [number]>("SELECT count(*) AS count FROM space_explain_runs WHERE created_at>? AND status='running'").get(Date.now() - 180_000)!;
      if (active.count >= 1 || recent.count >= 20 || global.count >= 4) throw new Error("rate_limited");
      const id = randomUUID();
      this.db.query("INSERT INTO space_explain_runs (id,owner,request_id,input_hash,status,created_at) VALUES (?,?,?,?,'running',?)")
        .run(id, owner, requestId, hash, Date.now());
      return { run: this.get(owner, id)!, replayed: false };
    })();
  }

  complete(id: string, output: unknown): void {
    this.db.query("UPDATE space_explain_runs SET status='completed',output_json=? WHERE id=? AND status='running'").run(JSON.stringify(output), id);
  }

  fail(id: string, code: string): void {
    this.db.query("UPDATE space_explain_runs SET status='error',error=? WHERE id=? AND status='running'").run(code, id);
  }
}
