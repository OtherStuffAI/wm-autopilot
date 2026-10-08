import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getPublicKey, nip19 } from "nostr-tools";
import { assertPrivateFile, privateDatabaseFile, SecretCustody } from "./secret-custody";
import { assertSecretUse, boundedText, deniedPolicy, normalizeSecretPolicy, object, SecretError, validatedNpub, type SecretConsumer, type SecretPolicy } from "./secret-policy";
import { signSecretEvent } from "./secret-events";

export interface SecretRecord {
  id: string; ownerNpub: string; workspaceId: string; label: string; type: "secret" | "nostr";
  publicNpub: string | null; policy: SecretPolicy; revision: number;
  createdAt: string; updatedAt: string; revokedAt: string | null; lastUsedAt: string | null;
}
interface SecretRow { metadata: string; envelope: string }
function binding(record: SecretRecord): string {
  return `wm-imported-secret-v1\0${record.id}\0${record.ownerNpub}\0${record.workspaceId}\0${record.type}\0${record.publicNpub ?? ""}`;
}
function parseValue(type: SecretRecord["type"], value: unknown): { bytes: Uint8Array; publicNpub: string | null } {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 65_536) throw new SecretError("invalid_secret_value");
  if (type === "secret") return { bytes: new TextEncoder().encode(value), publicNpub: null };
  let bytes: Uint8Array | undefined;
  try {
    if (value.startsWith("nsec1")) {
      const decoded = nip19.decode(value);
      if (decoded.type !== "nsec") throw new Error();
      bytes = new Uint8Array(decoded.data);
    } else if (/^[0-9a-fA-F]{64}$/.test(value)) bytes = new Uint8Array(Buffer.from(value, "hex"));
    else throw new Error();
    return { bytes, publicNpub: nip19.npubEncode(getPublicKey(bytes)) };
  } catch { bytes?.fill(0); throw new SecretError("invalid_signing_key"); }
}
export class SecretStore {
  private readonly db: Database;
  private readonly custody: SecretCustody;
  constructor(path: string, masterKeyPath: string) {
    const existing = (statSync(path, { throwIfNoEntry: false })?.size ?? 0) > 0;
    privateDatabaseFile(path);
    for (const suffix of ["-journal", "-wal", "-shm"]) assertPrivateFile(`${path}${suffix}`);
    this.custody = new SecretCustody(masterKeyPath, existing);
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS imported_secrets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL, metadata TEXT NOT NULL, envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_secret_audit (id INTEGER PRIMARY KEY, secret_id TEXT NOT NULL, owner TEXT NOT NULL, workspace TEXT NOT NULL, at TEXT NOT NULL, operation TEXT NOT NULL, identity TEXT NOT NULL, context TEXT NOT NULL, context_id TEXT NOT NULL, outcome TEXT NOT NULL);`);
  }
  list(owner: string, workspace: string): SecretRecord[] {
    return (this.db.query("SELECT metadata FROM imported_secrets WHERE owner=? AND workspace=? ORDER BY rowid DESC").all(owner, workspace) as Array<{ metadata: string }>).map(row => JSON.parse(row.metadata));
  }
  get(owner: string, workspace: string, id: string): SecretRecord {
    return JSON.parse(this.row(owner, workspace, id).metadata);
  }
  create(owner: string, workspace: string, inputValue: unknown): SecretRecord {
    validatedNpub(owner); boundedText(workspace, 128);
    const input = object(inputValue);
    const type = input.type;
    if (type !== "secret" && type !== "nostr") throw new SecretError("invalid_secret_type");
    const policy = normalizeSecretPolicy(input.policy ?? deniedPolicy());
    const label = boundedText(input.label);
    const value = parseValue(type, input.value);
    const at = new Date().toISOString();
    const record: SecretRecord = { id: randomUUID(), ownerNpub: owner, workspaceId: workspace, label, type,
      publicNpub: value.publicNpub, policy, revision: 1, createdAt: at, updatedAt: at, revokedAt: null, lastUsedAt: null };
    try {
      const envelope = this.custody.encrypt(value.bytes, binding(record));
      this.db.transaction(() => {
        this.db.query("INSERT INTO imported_secrets VALUES (?,?,?,?,?)").run(record.id, owner, workspace, JSON.stringify(record), envelope);
        this.audit(record, "create", owner, "management", record.id, "allowed");
      })();
      return record;
    } finally { value.bytes.fill(0); }
  }
  update(owner: string, workspace: string, id: string, inputValue: unknown): SecretRecord {
    const input = object(inputValue);
    return this.db.transaction(() => {
      const row = this.row(owner, workspace, id);
      const previous: SecretRecord = JSON.parse(row.metadata);
      if (input.revision !== previous.revision) throw new SecretError("stale_secret_revision", 409);
      if (previous.revokedAt) throw new SecretError("secret_revoked", 409);
      const type = input.type ?? previous.type;
      if (type !== "secret" && type !== "nostr") throw new SecretError("invalid_secret_type");
      if (type !== previous.type && input.value === undefined) throw new SecretError("replacement_value_required");
      const policy = input.policy === undefined ? previous.policy : normalizeSecretPolicy(input.policy);
      const next: SecretRecord = { ...previous, label: input.label === undefined ? previous.label : boundedText(input.label),
        type, policy, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      let envelope = row.envelope;
      if (input.value !== undefined) {
        const value = parseValue(type, input.value);
        try {
          next.publicNpub = value.publicNpub;
          // Identity change resets consumer grants/export; reauthorize in a later edit.
          if (previous.publicNpub !== next.publicNpub || previous.type !== next.type) next.policy = deniedPolicy();
          envelope = this.custody.encrypt(value.bytes, binding(next));
        } finally { value.bytes.fill(0); }
      }
      this.db.query("UPDATE imported_secrets SET metadata=?, envelope=? WHERE id=?").run(JSON.stringify(next), envelope, id);
      this.audit(next, "update", owner, "management", id, "allowed");
      return next;
    })();
  }
  revoke(owner: string, workspace: string, id: string, revision: unknown): SecretRecord {
    return this.db.transaction(() => {
      const record = this.get(owner, workspace, id);
      if (revision !== record.revision) throw new SecretError("stale_secret_revision", 409);
      record.revokedAt = new Date().toISOString(); record.updatedAt = record.revokedAt; record.revision++;
      // Erase ciphertext as well as denying every subsequent operation.
      this.db.query("UPDATE imported_secrets SET metadata=?, envelope='' WHERE id=?").run(JSON.stringify(record), id);
      this.audit(record, "revoke", owner, "management", id, "allowed");
      return record;
    })();
  }
  consume(id: string, consumer: SecretConsumer, operation: "sign" | "return", event?: unknown,
    onReturned?: (value: string) => void): Record<string, unknown> {
    const row = this.row(consumer.ownerNpub, consumer.workspaceId, id);
    const record: SecretRecord = JSON.parse(row.metadata);
    try {
      if (operation !== "sign" && operation !== "return") throw new SecretError("invalid_secret_operation");
      assertSecretUse(record, consumer);
      if (operation === "return" && !record.policy.allowExport) throw new SecretError("secret_export_denied", 403);
      if (operation === "sign" && record.type !== "nostr") throw new SecretError("not_signing_key");
      const result = this.custody.withValue(row.envelope, binding(record), bytes => {
        if (operation === "sign") return { event: signSecretEvent(bytes, event, record.policy.kindRules), publicNpub: record.publicNpub };
        const value = record.type === "nostr" ? nip19.nsecEncode(bytes) : new TextDecoder().decode(bytes);
        onReturned?.(value);
        return { value };
      });
      record.lastUsedAt = new Date().toISOString();
      this.db.query("UPDATE imported_secrets SET metadata=? WHERE id=?").run(JSON.stringify(record), id);
      this.audit(record, operation, consumer.identityNpub, consumer.context, consumer.contextId, "allowed");
      return result;
    } catch (error) {
      this.audit(record, operation, consumer.identityNpub, consumer.context, consumer.contextId, "denied");
      if (error instanceof SecretError) throw error;
      throw new SecretError("secret_operation_failed", 503);
    }
  }
  history(owner: string, workspace: string, id: string) {
    this.get(owner, workspace, id);
    return this.db.query("SELECT at, operation, identity, context, context_id AS contextId, outcome FROM imported_secret_audit WHERE secret_id=? AND owner=? AND workspace=? ORDER BY id DESC LIMIT 100").all(id, owner, workspace);
  }
  private row(owner: string, workspace: string, id: string): SecretRow {
    const row = this.db.query("SELECT metadata, envelope FROM imported_secrets WHERE id=? AND owner=? AND workspace=?").get(id, owner, workspace) as SecretRow | null;
    if (!row) throw new SecretError("secret_not_found", 404);
    return row;
  }
  private audit(record: SecretRecord, operation: string, identity: string, context: string, contextId: string, outcome: string): void {
    this.db.query("INSERT INTO imported_secret_audit (secret_id,owner,workspace,at,operation,identity,context,context_id,outcome) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(record.id, record.ownerNpub, record.workspaceId, new Date().toISOString(), operation, identity, context, contextId, outcome);
  }
  close(): void { this.db.close(); this.custody.close(); }
}
