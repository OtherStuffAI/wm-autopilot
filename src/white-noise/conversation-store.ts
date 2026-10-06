import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface ConversationBinding { account: string; group: string; sender: string; session: string; }
export interface ConversationInput { id: string; text: string; state: "queued" | "accepted" | "completed" | "delivered"; reply: string | null; }

/** One immutable operator-authorized binding, inbound dedup and durable outbox. */
export class ConversationStore {
  private readonly db: Database;
  constructor(path: string, readonly binding: ConversationBinding) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, reply TEXT)");
    const existing = this.db.query<{ value: string }, []>("SELECT value FROM binding WHERE id=1").get();
    if (existing && existing.value !== JSON.stringify(binding)) { this.db.close(); throw new Error("conversation_binding_mismatch"); }
    if (!existing) this.db.query("INSERT INTO binding (id,value) VALUES (1,?)").run(JSON.stringify(binding));
  }
  close(): void { this.db.close(); }
  receive(input: { account: string; group: string; sender: string; id: string; text: string }): boolean {
    const b = this.binding;
    if (input.account !== b.account || input.group !== b.group || input.sender !== b.sender) return false;
    if (!/^[0-9a-f]{64}$/.test(input.id) || !input.text.trim() || Buffer.byteLength(input.text) > 65536) throw new Error("invalid_inbound");
    const fingerprint = createHash("sha256").update(input.text).digest("hex");
    const existing = this.db.query<{ fingerprint: string }, [string]>("SELECT fingerprint FROM inputs WHERE id=?").get(input.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("inbound_id_conflict");
      return false;
    }
    const count = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM inputs").get()!.count;
    // Keep durable dedup within the connector's durable 1024-entry final-send window.
    if (count >= 1024) throw new Error("conversation_capacity_reached");
    this.db.query("INSERT INTO inputs (id,fingerprint,text,state) VALUES (?,?,?,'queued')").run(input.id, fingerprint, input.text);
    return true;
  }
  pending(): ConversationInput[] {
    return this.db.query<ConversationInput, []>("SELECT id,text,state,reply FROM inputs WHERE state!='delivered' ORDER BY rowid").all();
  }
  accept(id: string): void {
    this.db.query("UPDATE inputs SET state='accepted' WHERE id=? AND state='queued'").run(id);
  }
  complete(id: string, text: string): void {
    if (!text.trim() || Buffer.byteLength(text) > 65536) throw new Error("invalid_completed_output");
    const result = this.db.query("UPDATE inputs SET state='completed',reply=? WHERE id=? AND state='accepted'").run(text, id);
    if (result.changes !== 1) throw new Error("completion_state_mismatch");
  }
  delivered(id: string): void {
    const result = this.db.query("UPDATE inputs SET state='delivered' WHERE id=? AND state='completed'").run(id);
    if (result.changes !== 1) throw new Error("delivery_state_mismatch");
  }
}
