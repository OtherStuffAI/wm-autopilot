import { Database } from "bun:sqlite";

interface OperationRow {
  id: number;
  operation: string;
  state: string;
  startedAt: string;
  completedAt: string | null;
}

/** Safe operation metadata only. Bodies, upstream output and errors are never recorded. */
export class ProxyOperationLog {
  private readonly db: Database;
  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS caprover_proxy_operations (
      id INTEGER PRIMARY KEY, app_name TEXT NOT NULL, operation TEXT NOT NULL,
      state TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT
    )`);
  }
  start(appName: string, operation: string): number {
    return Number(this.db.query("INSERT INTO caprover_proxy_operations (app_name, operation, state, started_at) VALUES (?, ?, 'started', ?)").run(appName, operation, new Date().toISOString()).lastInsertRowid);
  }
  finish(id: number, state: "completed" | "outcome-unknown"): void {
    this.db.query("UPDATE caprover_proxy_operations SET state = ?, completed_at = ? WHERE id = ?").run(state, new Date().toISOString(), id);
  }
  list(appName: string): OperationRow[] {
    return this.db.query<OperationRow, [string]>("SELECT id, operation, state, started_at AS startedAt, completed_at AS completedAt FROM caprover_proxy_operations WHERE app_name = ? ORDER BY id DESC LIMIT 100").all(appName);
  }
  close(): void { this.db.close(); }
}
