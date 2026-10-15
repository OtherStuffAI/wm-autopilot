import type { Database } from "bun:sqlite";
import type { CompletedTurnReceipt, CompletedTurnRequest } from "./completed-turn-contract.ts";

export interface TurnRecord extends CompletedTurnReceipt {
  owner: string;
  prompt: string;
  checkpoint: number | null;
  requestJson: string;
  claimToken: string | null;
  leaseUntil: number;
  senderToken: string | null;
  senderLeaseUntil: number;
}
export interface TurnBinding {
  owner: string;
  conversationKey: string;
  config: string;
  sessionId: string | null;
  executionId: string | null;
}

/** Generic execution bindings and receipts, never workshop policy or revision state. */
export class CompletedTurnStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS completed_turn_bindings (
      owner TEXT NOT NULL, conversationKey TEXT NOT NULL, config TEXT NOT NULL, sessionId TEXT, executionId TEXT,
      PRIMARY KEY(owner, conversationKey));
      CREATE TABLE IF NOT EXISTS completed_turn_receipts (
      receiptId TEXT PRIMARY KEY, owner TEXT NOT NULL, conversationKey TEXT NOT NULL,
      requestId TEXT NOT NULL, projectId TEXT NOT NULL, runId TEXT NOT NULL, stepId TEXT NOT NULL,
      fingerprint TEXT NOT NULL, requestJson TEXT NOT NULL, prompt TEXT NOT NULL, sequence INTEGER NOT NULL,
      sessionId TEXT, executionId TEXT, nativeSessionId TEXT, checkpoint INTEGER, outputJson TEXT,
      status TEXT NOT NULL, reply TEXT, error TEXT, claimToken TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0,
      senderToken TEXT, senderLeaseUntil INTEGER NOT NULL DEFAULT 0,
      UNIQUE(owner, requestId), UNIQUE(owner, conversationKey, sequence),
      FOREIGN KEY(owner, conversationKey) REFERENCES completed_turn_bindings(owner, conversationKey));`);
    const receiptColumns = db.query("PRAGMA table_info(completed_turn_receipts)").all() as { name: string }[];
    if (!receiptColumns.some((column) => column.name === "senderToken")) {
      db.exec("ALTER TABLE completed_turn_receipts ADD COLUMN senderToken TEXT");
    }
    if (!receiptColumns.some((column) => column.name === "senderLeaseUntil")) {
      db.exec("ALTER TABLE completed_turn_receipts ADD COLUMN senderLeaseUntil INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS completed_turn_retirements(owner TEXT NOT NULL,conversationKey TEXT NOT NULL,receiptId TEXT NOT NULL,PRIMARY KEY(owner,conversationKey));`);
    db.exec(`CREATE TABLE IF NOT EXISTS completed_turn_deletions(owner TEXT NOT NULL,conversationKey TEXT NOT NULL,requestJson TEXT NOT NULL,receiptId TEXT NOT NULL UNIQUE,sessionId TEXT NOT NULL,receiptJson TEXT,PRIMARY KEY(owner,conversationKey));`);
  }

  beginDeletion(owner:string,request:{conversationKey:string;projectId:string;directory:string;requestId:string}) : {receiptId:string;sessionId:string;receiptJson:string|null} {
    return this.db.transaction(()=>{
      const previous=this.db.query('SELECT * FROM completed_turn_deletions WHERE owner=? AND conversationKey=?').get(owner,request.conversationKey) as any;
      if(previous){if(previous.requestJson!==JSON.stringify(request))throw Error('Conversation deletion idempotency conflict');return previous;}
      const binding=this.binding(owner,request.conversationKey),config=binding?JSON.parse(binding.config):null;
      if(!binding?.sessionId || config.projectId!==request.projectId || config.directory!==request.directory || config.executionProfile)throw Error('Conversation deletion binding denied');
      if(this.head(owner,request.conversationKey))throw Error('Active or uncertain conversation turn prevents deletion');
      const result={receiptId:crypto.randomUUID(),sessionId:binding.sessionId,receiptJson:null};
      this.db.query('INSERT INTO completed_turn_deletions(owner,conversationKey,requestJson,receiptId,sessionId) VALUES(?,?,?,?,?)').run(owner,request.conversationKey,JSON.stringify(request),result.receiptId,result.sessionId);
      return result;
    }).immediate();
  }
  finishDeletion(owner:string,key:string,receipt:unknown):void {
    this.db.query('UPDATE completed_turn_deletions SET receiptJson=? WHERE owner=? AND conversationKey=? AND receiptJson IS NULL').run(JSON.stringify(receipt),owner,key);
  }
  enqueue(owner: string, request: CompletedTurnRequest, runId: string, stepId: string): TurnRecord {
    if (!owner) throw new Error("Completed turns require an authenticated pipeline owner");
    if(this.db.query('SELECT 1 FROM completed_turn_deletions WHERE owner=? AND conversationKey=?').get(owner,request.conversationKey))throw Error('Deleted conversation requires a new generation');
    const config = JSON.stringify({ ...(request.agent === "goose" ? {agent:"goose"} : {}), directory: request.directory, model: request.model, projectId: request.projectId, executionProfile: request.executionProfile });
    const fingerprint = JSON.stringify(request);
    return this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO completed_turn_bindings (owner,conversationKey,config,sessionId) VALUES (?, ?, ?, ?)")
        .run(owner, request.conversationKey, config, request.sessionId);
      if(this.db.query('SELECT 1 FROM completed_turn_deletions WHERE owner=? AND conversationKey=?').get(owner,request.conversationKey))throw Error('Deleted conversation requires a new generation');
      const binding = this.binding(owner, request.conversationKey)!;
      if (binding.config !== config) throw new Error("Completed-turn conversation binding conflict");
      if (request.sessionId && binding.sessionId !== request.sessionId) throw new Error("Completed-turn stale session binding");
      const existing = this.db.query("SELECT * FROM completed_turn_receipts WHERE owner=? AND requestId=?").get(owner, request.requestId) as (TurnRecord & { fingerprint: string }) | null;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("Completed-turn request idempotency conflict");
        return this.get(existing.receiptId)!;
      }
      if(this.db.query('SELECT 1 FROM completed_turn_retirements WHERE owner=? AND conversationKey=?').get(owner,request.conversationKey))throw Error('Abandoned conversation requires a fresh generation');
      const sequence = (this.db.query("SELECT MAX(sequence) AS maximum FROM completed_turn_receipts WHERE owner=? AND conversationKey=?")
        .get(owner, request.conversationKey) as { maximum: number | null }).maximum ?? 0;
      const receiptId = crypto.randomUUID();
      this.db.query(`INSERT INTO completed_turn_receipts
        (receiptId,owner,conversationKey,requestId,projectId,runId,stepId,fingerprint,requestJson,prompt,sequence,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued')`)
        .run(receiptId, owner, request.conversationKey, request.requestId, request.projectId, runId, stepId, fingerprint, fingerprint, request.prompt, sequence + 1);
      return this.get(receiptId)!;
    }).immediate();
  }

  request(owner: string, requestId: string): TurnRecord | null {
    const row = this.db.query("SELECT receiptId FROM completed_turn_receipts WHERE owner=? AND requestId=?").get(owner, requestId) as { receiptId: string } | null;
    return row ? this.get(row.receiptId) : null;
  }

  activeForSession(sessionId: string): TurnRecord | null {
    const rows = this.db.query("SELECT receiptId FROM completed_turn_receipts WHERE sessionId=? AND status='sending' AND claimToken IS NOT NULL AND leaseUntil>?")
      .all(sessionId, Date.now()) as { receiptId: string }[];
    if (rows.length !== 1) return null;
    return this.get(rows[0]!.receiptId);
  }

  /**
   * Refresh the execution lease only while the durable sender fence still
   * matches the exact sending claim. Recovery replaces the claim and clears
   * this fence in the same database write, so another process cannot revive a
   * stale writer.
   */
  refreshActiveSenderForSession(sessionId: string, at = Date.now()): TurnRecord | null {
    return this.db.transaction(() => {
      const rows = this.db.query(`SELECT receiptId,senderToken FROM completed_turn_receipts
        WHERE sessionId=? AND status='sending' AND claimToken=senderToken
          AND senderToken IS NOT NULL AND senderLeaseUntil>?`).all(sessionId, at) as {
            receiptId: string;
            senderToken: string;
          }[];
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      const refreshed = this.db.query(`UPDATE completed_turn_receipts SET leaseUntil=?
        WHERE receiptId=? AND sessionId=? AND status='sending' AND claimToken=?
          AND senderToken=? AND senderLeaseUntil>?`)
        .run(at + 30_000, row.receiptId, sessionId, row.senderToken, row.senderToken, at);
      return refreshed.changes === 1 ? this.get(row.receiptId) : null;
    }).immediate();
  }

  /** Explicit recovery only for the known source lookup failure BEFORE any launch/send. */
  recoverMissingPreparation(owner: string, request: CompletedTurnRequest): void {
    this.db.transaction(() => {
      const row = this.request(owner, request.requestId);
      if (!row || row.requestJson !== JSON.stringify(request)) throw new Error("Preparation recovery request binding denied");
      if (row.status === "completed" || row.status === "queued") return;
      if (row.status !== "preparing" || row.error !== "Completed-turn bound session unavailable" ||
          row.sessionId || row.executionId || row.nativeSessionId || row.checkpoint !== null || row.claimToken || row.leaseUntil !== 0 ||
          row.senderToken || row.senderLeaseUntil !== 0) {
        throw new Error("Preparation recovery denied: launch or send outcome is not proven absent");
      }
      this.db.query("UPDATE completed_turn_receipts SET status='queued',error=NULL WHERE receiptId=?").run(row.receiptId);
    }).immediate();
  }

  binding(owner: string, key: string): TurnBinding | null {
    return this.db.query("SELECT * FROM completed_turn_bindings WHERE owner=? AND conversationKey=?").get(owner, key) as TurnBinding | null;
  }
  get(id: string): TurnRecord | null {
    const row = this.db.query("SELECT * FROM completed_turn_receipts WHERE receiptId=?").get(id) as (TurnRecord & { outputJson: string | null }) | null;
    return row ? { ...row, output: row.outputJson ? JSON.parse(row.outputJson) : null } : null;
  }
  head(owner: string, key: string): TurnRecord | null {
    return this.db.query("SELECT * FROM completed_turn_receipts WHERE owner=? AND conversationKey=? AND status NOT IN ('completed','abandoned') ORDER BY sequence LIMIT 1")
      .get(owner, key) as TurnRecord | null;
  }
  claim(id: string, token: string, at = Date.now()): boolean {
    return this.db.query(`UPDATE completed_turn_receipts SET
      status=CASE WHEN status='queued' THEN 'preparing' ELSE status END, claimToken=?,leaseUntil=?,error=NULL,
      senderToken=NULL,senderLeaseUntil=0
      WHERE receiptId=? AND status NOT IN ('completed','abandoned','abandoning') AND leaseUntil<=?`)
      .run(token, at + 30_000, id, at).changes === 1;
  }
  renew(id: string, token: string): void {
    const now = Date.now();
    const result = this.db.query(`UPDATE completed_turn_receipts SET leaseUntil=?,
      senderLeaseUntil=CASE WHEN status='sending' AND senderToken=? THEN ? ELSE senderLeaseUntil END
      WHERE receiptId=? AND claimToken=? AND status!='completed'`)
      .run(now + 30_000, token, now + 120_000, id, token);
    if (result.changes !== 1) throw new Error("Completed-turn lease changed");
  }
  bind(id: string, token: string, executionId: string, sessionId: string | null = executionId): void {
    this.db.transaction(() => {
      const row = this.get(id)!;
      if (row.claimToken !== token || row.status !== "preparing") throw new Error("Completed-turn claim changed");
      this.db.query("UPDATE completed_turn_bindings SET sessionId=?,executionId=? WHERE owner=? AND conversationKey=?")
        .run(sessionId, executionId, row.owner, row.conversationKey);
      this.db.query("UPDATE completed_turn_receipts SET sessionId=?,executionId=? WHERE receiptId=? AND status='preparing'").run(sessionId, executionId, id);
    }).immediate();
  }
  sending(id: string, token: string, nativeId: string | null, checkpoint: number): void {
    const result = this.db.query(`UPDATE completed_turn_receipts SET status='sending',nativeSessionId=?,checkpoint=?,
      senderToken=?,senderLeaseUntil=? WHERE receiptId=? AND claimToken=? AND status='preparing'`)
      .run(nativeId, checkpoint, token, Date.now() + 120_000, id, token);
    if (result.changes !== 1) throw new Error("Completed-turn claim changed");
  }
  uncertain(id: string, token: string, error: string): void {
    this.db.query("UPDATE completed_turn_receipts SET error=?,leaseUntil=0,claimToken=NULL,senderToken=NULL,senderLeaseUntil=0,status=CASE WHEN status='sending' THEN 'uncertain' ELSE status END WHERE receiptId=? AND claimToken=? AND status!='completed'")
      .run(error, id, token);
  }
  claimAbandonment(id:string,token:string):boolean {
    return this.db.transaction(()=>{
      const row=this.get(id)!;
      if(row.status==='abandoning' && row.leaseUntil>Date.now())return false;
      if(!['preparing','sending','uncertain','abandoning'].includes(row.status))return false;
      // Explicit scoped cancellation revokes the old execution's claim before
      // stopping it. A late completion can no longer commit this receipt.
      this.db.query("INSERT OR IGNORE INTO completed_turn_retirements VALUES(?,?,?)").run(row.owner,row.conversationKey,id);
      return this.db.query("UPDATE completed_turn_receipts SET status='abandoning',claimToken=?,leaseUntil=?,senderToken=NULL,senderLeaseUntil=0 WHERE receiptId=? AND status NOT IN ('completed','abandoned')").run(token,Date.now()+30_000,id).changes===1;
    }).immediate();
  }
  abandon(id:string,token:string,evidence:Record<string,unknown>):void {
    this.db.transaction(()=>{
      const row=this.get(id)!;
      if(row.claimToken!==token || row.status!=='abandoning')throw Error('Abandonment claim changed');
      this.db.query("INSERT OR IGNORE INTO completed_turn_retirements VALUES(?,?,?)").run(row.owner,row.conversationKey,id);
      this.db.query("UPDATE completed_turn_receipts SET status='abandoned',outputJson=?,error=NULL,leaseUntil=0,claimToken=NULL,senderToken=NULL,senderLeaseUntil=0 WHERE owner=? AND conversationKey=? AND status!='completed'").run(JSON.stringify(evidence),row.owner,row.conversationKey);
    }).immediate();
  }
  complete(id: string, token: string, reply: string, nativeId: string, output: Record<string, unknown> | null = null): void {
    if (!reply.trim() || !nativeId) throw new Error("Native completed-turn evidence missing");
    const result = this.db.query("UPDATE completed_turn_receipts SET status='completed',reply=?,nativeSessionId=?,outputJson=?,error=NULL,leaseUntil=0,claimToken=NULL,senderToken=NULL,senderLeaseUntil=0 WHERE receiptId=? AND claimToken=? AND status IN ('sending','uncertain')")
      .run(reply, nativeId, output ? JSON.stringify(output) : null, id, token);
    if (result.changes !== 1) throw new Error("Completed-turn completion claim changed");
  }
}

export function publicTurnReceipt(row: TurnRecord): CompletedTurnReceipt {
  const { receiptId, conversationKey, requestId, projectId, runId, stepId, sessionId, executionId, nativeSessionId, status, sequence, reply, error, output } = row;
  return { receiptId, conversationKey, requestId, projectId, runId, stepId, sessionId, executionId, nativeSessionId, status, sequence, reply, error, output };
}
