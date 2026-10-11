import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { privateDatabaseFile } from "../secrets/secret-custody";
import { captureHostedSiteCredential } from "../signing/hosted-site-credential";

export interface WappPipelineGrant {
  id: string; installationId: string; appId: string; appRoot: string; ownerNpub: string;
  appNpub: string; origin: string; definitionId: string; definitionOwnerAlias: string;
  definitionHash: string; functionHashes: Record<string, string>; callbackUrl: string; expiresAt: number;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class WappPipelineGrantStore {
  private readonly db: Database;
  constructor(readonly path: string) {
    privateDatabaseFile(path);
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pipeline_app_grants(id TEXT PRIMARY KEY, credential_hash TEXT UNIQUE NOT NULL, metadata TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pipeline_app_runs(grant_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(grant_id,run_id));
      CREATE TABLE IF NOT EXISTS pipeline_app_audit(id INTEGER PRIMARY KEY, grant_id TEXT NOT NULL, at INTEGER NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL);`);
  }
  register(input: Omit<WappPipelineGrant,"id">) {
    const grant = { ...input, id: randomUUID() };
    const credential = randomBytes(32).toString("base64url");
    this.db.query("INSERT INTO pipeline_app_grants VALUES(?,?,?,0)").run(grant.id,digest(credential),JSON.stringify(grant));
    try {
      const credentialFile = captureHostedSiteCredential(join(dirname(this.path),"pipeline-app-credentials"),grant.id,credential);
      this.audit(grant.id,"register","allowed");
      return { grant, credentialFile };
    } catch (error) { this.revoke(grant.id); throw error; }
  }
  authorize(credential: string): WappPipelineGrant {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("pipeline_capability_denied");
    const row = this.db.query<{metadata:string},[string]>("SELECT metadata FROM pipeline_app_grants WHERE credential_hash=? AND revoked=0").get(digest(credential));
    if (!row) throw new Error("pipeline_capability_denied");
    return JSON.parse(row.metadata);
  }
  active(id:string) { return !!this.db.query("SELECT id FROM pipeline_app_grants WHERE id=? AND revoked=0").get(id); }
  ownsRun(grantId:string,runId:string) { return !!this.db.query("SELECT run_id FROM pipeline_app_runs WHERE grant_id=? AND run_id=?").get(grantId,runId); }
  bindRun(grantId:string,runId:string) { this.db.query("INSERT OR IGNORE INTO pipeline_app_runs VALUES(?,?)").run(grantId,runId); }
  revoke(id:string) { this.db.query("UPDATE pipeline_app_grants SET revoked=1 WHERE id=?").run(id); this.audit(id,"revoke","allowed"); }
  audit(id:string,operation:string,outcome:string) { this.db.query("INSERT INTO pipeline_app_audit(grant_id,at,operation,outcome) VALUES(?,?,?,?)").run(id,Date.now(),operation,outcome); }
  close() { this.db.close(); }
}
