import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { finalizeEvent, getEventHash, type UnsignedEvent } from "nostr-tools";
import type { BotKeyRecord } from "../identity/bot-key-store";
import type { BrokerKeyVaultBackend } from "./broker-key-vault";
import { nip44Decrypt, nip44Encrypt } from "../nostr/nip44-crypto";
import { matchesExactNostrTags, normalizeNostrKindRules, type NostrKindConstraint } from "./nostr-kind-policy";

export const APPLICATION_METHODS = ["get_public_key", "sign_event", "nip44_encrypt", "nip44_decrypt"] as const;
export type ApplicationMethod = typeof APPLICATION_METHODS[number];
export interface ApplicationGrantPolicy {
  methods: ApplicationMethod[];
  kindRules: NostrKindConstraint[];
  peers: string[];
  allowAnyPeer?: boolean;
}
export interface ApplicationGrant {
  id: string;
  ownerNpub: string;
  botNpub: string;
  pubkey: string;
  keyId: string;
  policy: ApplicationGrantPolicy;
}
export interface SignerRequest {
  id: string;
  credential: string;
  method: string;
  params: Record<string, unknown>;
}
export class SignerError extends Error {
  constructor(readonly code: string) { super(code); }
}
const digest = (credential: string) => createHash("sha256").update(credential).digest("hex");
const hexKey = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Durable application authority; deliberately independent of session capabilities. */
export class ApplicationSigner {
  private readonly db: Database;
  constructor(path: string, private readonly lookup: (npub: string) => BotKeyRecord | null,
    private readonly vault: Pick<BrokerKeyVaultBackend, "withKey">) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS application_grants (id TEXT PRIMARY KEY, credential_hash TEXT UNIQUE NOT NULL, grant_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)");
    for (const suffix of ["", "-wal", "-shm"]) {
      const info = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
      if (info && (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
        this.db.close();
        throw new SignerError("grant_storage_unsafe");
      }
    }
  }
  async registerVerified(actorNpub: string, botNpub: string, expectedPubkey: string, policy: ApplicationGrantPolicy) {
    const record = this.lookup(botNpub);
    if (!record || record.userNpub !== actorNpub || record.botPubkeyHex !== expectedPubkey) throw new SignerError("identity_denied");
    await this.vault.withKey(record, () => undefined);
    if (this.lookup(botNpub)?.id !== record.id) throw new SignerError("identity_denied");
    return this.register(actorNpub, botNpub, expectedPubkey, policy);
  }
  register(actorNpub: string, botNpub: string, expectedPubkey: string, policy: ApplicationGrantPolicy) {
    const record = this.lookup(botNpub);
    if (!record || record.userNpub !== actorNpub || record.botPubkeyHex !== expectedPubkey) throw new SignerError("identity_denied");
    if (!Array.isArray(policy.methods) || !policy.methods.length || policy.methods.some(m => !APPLICATION_METHODS.includes(m))
      || (policy.allowAnyPeer !== undefined && typeof policy.allowAnyPeer !== "boolean")
      || !Array.isArray(policy.peers) || policy.peers.length > 16 || policy.peers.some(p => !hexKey(p))) throw new SignerError("invalid_policy");
    const kinds = policy.kindRules?.map(r => r.kind) ?? [];
    if (kinds.some(kind => !Number.isInteger(kind) || kind < 0 || kind > 65535)
      || kinds.includes(445) || kinds.includes(27235) || kinds.length > 16 || new Set(kinds).size !== kinds.length) throw new SignerError("invalid_policy");
    const kindRules = normalizeNostrKindRules(policy.kindRules, kinds);
    const grant: ApplicationGrant = { id: randomUUID(), ownerNpub: actorNpub, botNpub, pubkey: expectedPubkey,
      keyId: record.id, policy: { methods: [...policy.methods], peers: [...policy.peers], allowAnyPeer: policy.allowAnyPeer === true, kindRules } };
    const credential = `wmapp_v1_${randomBytes(32).toString("base64url")}`;
    this.db.query("INSERT INTO application_grants (id, credential_hash, grant_json) VALUES (?, ?, ?)").run(grant.id, digest(credential), JSON.stringify(grant));
    return { grant, credential };
  }
  revoke(actorNpub: string, id: string): void {
    const row = this.db.query<{ grant_json: string }, [string]>("SELECT grant_json FROM application_grants WHERE id=?").get(id);
    if (!row || JSON.parse(row.grant_json).ownerNpub !== actorNpub) throw new SignerError("grant_denied");
    this.db.query("UPDATE application_grants SET revoked=1 WHERE id=?").run(id);
  }
  close(): void { this.db.close(); }
  private authorize(credential: string, method: string): { grant: ApplicationGrant; record: BotKeyRecord } {
    if (typeof credential !== "string" || credential.length > 128) throw new SignerError("unauthorized");
    const row = this.db.query<{ grant_json: string }, [string]>("SELECT grant_json FROM application_grants WHERE credential_hash=? AND revoked=0").get(digest(credential));
    if (!row) throw new SignerError("unauthorized");
    const grant = JSON.parse(row.grant_json) as ApplicationGrant;
    if (!grant.policy.methods.includes(method as ApplicationMethod)) throw new SignerError("method_denied");
    const record = this.lookup(grant.botNpub);
    if (!record || record.id !== grant.keyId || record.botPubkeyHex !== grant.pubkey || record.userNpub !== grant.ownerNpub) throw new SignerError("identity_denied");
    return { grant, record };
  }
  async execute(request: SignerRequest): Promise<unknown> {
    const { grant, record } = this.authorize(request.credential, request.method);
    if (request.method === "get_public_key") {
      // Exercise custody as well as metadata so unavailable/mismatched keys fail closed.
      return await this.vault.withKey(record, () => { this.authorize(request.credential, request.method); return grant.pubkey; });
    }
    const params = request.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new SignerError("invalid_request");
    if (request.method === "sign_event") {
      const event = structuredClone(params.event) as UnsignedEvent & { id: string };
      const rule = grant.policy.kindRules.find(r => r.kind === event?.kind);
      if (!rule) throw new SignerError("kind_denied");
      if (!event || event.pubkey !== grant.pubkey) throw new SignerError("identity_denied");
      if (!Number.isSafeInteger(event.created_at) || event.created_at < 0 || typeof event.content !== "string"
        || Buffer.byteLength(event.content) > rule.maxContentBytes || !Array.isArray(event.tags) || event.tags.length > rule.maxTags
        || !event.tags.every(t => Array.isArray(t) && t.every(v => typeof v === "string"))) throw new SignerError("invalid_event");
      const tags = event.tags;
      if (tags.reduce((n, t) => n + t.reduce((m, v) => m + Buffer.byteLength(v), 0), 0) > rule.maxTagBytes
        || tags.some(t => !rule.allowedTagNames.includes(t[0] ?? ""))
        || rule.requiredTags?.some(([n, v]) => !tags.some(t => t[0] === n && t[1] === v))
        || !matchesExactNostrTags(tags, rule.exactTags)) throw new SignerError("tags_denied");
      if (!hexKey(event.id) || getEventHash(event) !== event.id) throw new SignerError("event_id_mismatch");
      return await this.vault.withKey(record, key => {
        this.authorize(request.credential, request.method);
        return finalizeEvent({ kind: event.kind, content: event.content, tags: event.tags, created_at: event.created_at }, key);
      });
    }
    const peer = params.peer;
    const text = params.text;
    if (!hexKey(peer) || (!grant.policy.allowAnyPeer && !grant.policy.peers.includes(peer))) throw new SignerError("peer_denied");
    if (typeof text !== "string" || Buffer.byteLength(text) > (request.method === "nip44_encrypt" ? 65535 : 100000)) throw new SignerError("payload_denied");
    return await this.vault.withKey(record, key => {
      this.authorize(request.credential, request.method);
      if (request.method === "nip44_encrypt") return nip44Encrypt(text, key, peer);
      if (request.method === "nip44_decrypt") return nip44Decrypt(text, key, peer);
      throw new SignerError("method_denied");
    });
  }
}
