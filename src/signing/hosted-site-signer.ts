import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import type { Event } from "nostr-tools";
import { assertPrivateFile, privateDatabaseFile } from "../secrets/secret-custody";
import type { SecretStore } from "../secrets/secret-store";
import { SignerError } from "./application-signer";
import { hostedSignupTarget, verifyHostedUserProof } from "./hosted-site-proof";
import { captureHostedSiteCredential } from "./hosted-site-credential";

export interface HostedSiteGrant {
  id: string; ownerNpub: string; workspaceId: string; appId: string; appRoot: string;
  secretId: string; secretRevision: number; siteNpub: string; url: string; expiresAt: number;
}
export interface HostedSiteRequest {
  appId: string; url: string; method: string; payload: string; bodyHash: string; userEventId: string; userEvent: Event;
}
type AppLookup = (id: string) => Promise<{ ownerNpub: string | null; root: string } | undefined>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Separate authority from generic application signing and session delegation. */
export class HostedSiteSigner {
  private readonly db: Database;
  private readonly credentialDirectory: string;
  constructor(path: string, private readonly secrets: SecretStore, private readonly app: AppLookup,
    private readonly now = () => Math.floor(Date.now() / 1000)) {
    privateDatabaseFile(path);
    this.credentialDirectory = join(dirname(path), "hosted-site-credentials");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) assertPrivateFile(`${path}${suffix}`);
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS hosted_site_grants (id TEXT PRIMARY KEY, credential_hash TEXT UNIQUE NOT NULL, metadata TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS hosted_site_uses (grant_id TEXT NOT NULL, event_id TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(grant_id,event_id));
      CREATE TABLE IF NOT EXISTS hosted_site_audit (id INTEGER PRIMARY KEY, grant_id TEXT NOT NULL, at INTEGER NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL);`);
  }
  async registerManaged(ownerNpub: string, input: Omit<HostedSiteGrant, "id" | "ownerNpub" | "appRoot">) {
    const { grant, credential } = await this.register(ownerNpub, input);
    try {
      const credentialFile = captureHostedSiteCredential(this.credentialDirectory, grant.id, credential);
      return { grant, credentialFile };
    } catch (error) { this.revoke(ownerNpub, grant.id); throw error; }
  }
  async register(ownerNpub: string, input: Omit<HostedSiteGrant, "id" | "ownerNpub" | "appRoot">) {
    if (!input || Object.keys(input).sort().join(",") !== "appId,expiresAt,secretId,secretRevision,siteNpub,url,workspaceId"
      || ![input.appId, input.workspaceId, input.secretId, input.siteNpub, input.url].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048)
      || !Number.isSafeInteger(input.secretRevision) || input.secretRevision < 1) throw new SignerError("invalid_grant");
    hostedSignupTarget(input.url);
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now() || input.expiresAt > this.now() + 90 * 86400) throw new SignerError("expiry_denied");
    const app = await this.app(input.appId);
    if (!app || app.ownerNpub !== ownerNpub) throw new SignerError("app_denied");
    const grant: HostedSiteGrant = { ...input, id: randomUUID(), ownerNpub, appRoot: app.root };
    this.secrets.checkHostedSiteCustody(grant);
    const credential = `wmhost_v1_${randomBytes(32).toString("base64url")}`;
    this.db.transaction(() => {
      this.db.query("INSERT INTO hosted_site_grants VALUES (?,?,?,0)").run(grant.id, digest(credential), JSON.stringify(grant));
      this.audit(grant.id, "register", "allowed");
    })();
    return { grant, credential };
  }
  private async authorize(credential: string, appId: string): Promise<HostedSiteGrant> {
    if (typeof credential !== "string" || !/^wmhost_v1_[A-Za-z0-9_-]{43}$/.test(credential)) throw new SignerError("unauthorized");
    const row = this.db.query<{ metadata: string }, [string]>("SELECT metadata FROM hosted_site_grants WHERE credential_hash=? AND revoked=0").get(digest(credential));
    if (!row) throw new SignerError("unauthorized");
    const grant: HostedSiteGrant = JSON.parse(row.metadata);
    try {
      if (grant.appId !== appId) throw new SignerError("app_denied");
      if (grant.expiresAt <= this.now()) throw new SignerError("grant_expired");
      const app = await this.app(appId);
      if (!app || app.ownerNpub !== grant.ownerNpub || app.root !== grant.appRoot) throw new SignerError("app_denied");
      this.secrets.checkHostedSiteCustody(grant);
      // Awaiting registry lookup must not permit concurrent revocation or expiry.
      if (!this.db.query("SELECT id FROM hosted_site_grants WHERE id=? AND revoked=0").get(grant.id)) throw new SignerError("unauthorized");
      if (grant.expiresAt <= this.now()) throw new SignerError("grant_expired");
    } catch (error) { this.audit(grant.id, "authorize", "denied"); throw error; }
    return grant;
  }
  async readiness(credential: string, appId: string, url: string, siteNpub: string) {
    const grant = await this.authorize(credential, appId);
    if (grant.url !== url || grant.siteNpub !== siteNpub) throw new SignerError("target_denied");
    return { ready: true, appId, siteNpub: grant.siteNpub, url: grant.url, expiresAt: grant.expiresAt };
  }
  async attest(credential: string, input: HostedSiteRequest) {
    const grant = await this.authorize(credential, input.appId);
    try {
      if (input.url !== grant.url) throw new SignerError("target_denied");
      const now = this.now();
      const user = verifyHostedUserProof(input, now);
      return this.db.transaction(() => {
        this.db.query("DELETE FROM hosted_site_uses WHERE at<?").run(now - 120);
        if (this.db.query("SELECT event_id FROM hosted_site_uses WHERE grant_id=? AND event_id=?").get(grant.id, user.id)) throw new SignerError("signature_replayed");
        const count = (actor?: string) => (this.db.query<{ n: number }, [string, number, ...string[]]>(
          `SELECT count(*) AS n FROM hosted_site_uses WHERE grant_id=? AND at>=?${actor ? " AND actor=?" : ""}`
        ).get(grant.id, now - 60, ...(actor ? [actor] : []))?.n ?? 0);
        if (count() >= 120 || count(user.pubkey) >= 12) throw new SignerError("signup_rate_limited");
        const event = this.secrets.signHostedSite(grant, {
          kind: 27235, created_at: now, content: randomUUID(),
          tags: [["u", grant.url], ["method", "POST"], ["payload", input.bodyHash], ["user_event_id", user.id]],
        });
        this.db.query("INSERT INTO hosted_site_uses VALUES (?,?,?,?)").run(grant.id, user.id, user.pubkey, now);
        this.audit(grant.id, "attest", "allowed");
        return event;
      })();
    } catch (error) { this.audit(grant.id, "attest", "denied"); throw error; }
  }
  revoke(owner: string, id: string) {
    const row = this.db.query<{ metadata: string }, [string]>("SELECT metadata FROM hosted_site_grants WHERE id=?").get(id);
    if (!row || JSON.parse(row.metadata).ownerNpub !== owner) throw new SignerError("grant_denied");
    this.db.transaction(() => { this.db.query("UPDATE hosted_site_grants SET revoked=1 WHERE id=?").run(id); this.audit(id, "revoke", "allowed"); })();
  }
  history(owner: string, id: string) {
    const row = this.db.query<{ metadata: string }, [string]>("SELECT metadata FROM hosted_site_grants WHERE id=?").get(id);
    if (!row || JSON.parse(row.metadata).ownerNpub !== owner) throw new SignerError("grant_denied");
    return this.db.query("SELECT at,operation,outcome FROM hosted_site_audit WHERE grant_id=? ORDER BY id DESC LIMIT 100").all(id);
  }
  list(owner: string, workspace: string) {
    return (this.db.query<{ metadata: string; revoked: number }, []>("SELECT metadata,revoked FROM hosted_site_grants ORDER BY rowid DESC").all())
      .map(row => ({ grant: JSON.parse(row.metadata) as HostedSiteGrant, revoked: row.revoked === 1 }))
      .filter(row => row.grant.ownerNpub === owner && row.grant.workspaceId === workspace)
      .map(({ grant, revoked }) => ({ ...grant, revoked, credentialFile: join(this.credentialDirectory, `${grant.id}.cap`) }));
  }
  private audit(id: string, operation: string, outcome: string) {
    this.db.query("INSERT INTO hosted_site_audit (grant_id,at,operation,outcome) VALUES (?,?,?,?)").run(id, this.now(), operation, outcome);
  }
  close() { this.db.close(); }
}
