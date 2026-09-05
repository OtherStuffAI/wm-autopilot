import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { finalizeEvent } from "nostr-tools";

import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord, BotKeyStore } from "../identity/bot-key-store";
import { BrokerKeyNotProvisionedError, type BrokerKeyVaultBackend } from "./broker-key-vault";
import { nip44Decrypt, nip44Encrypt } from "../nostr/nip44-crypto";
import { jsonError, parseBody } from "../utils/request-utils";
import { normalizeNostrKindRules, type NostrKindConstraint } from "./nostr-kind-policy";
import { canonicalizeGitCredentialRequest } from "../git/wingman-credential-protocol";
import { fetchWappLoginChallenge, type WappLoginRequest } from "./wapp-login";

export type { NostrKindConstraint } from "./nostr-kind-policy";

const TOKEN_PREFIX = "wmcap_v1";
export const SESSION_CAPABILITY_TTL_MS = 2 * 60 * 60_000;
const MAX_NONCES_PER_CAPABILITY = 2_048;
const DEFAULT_MAX_CALLS_PER_MINUTE = 120;
const MAX_CHALLENGES_PER_CAPABILITY = 2_048;
const NIP98_KIND = 27_235;
const BLOSSOM_AUTH_KIND = 24_242;
const FLIGHTDECK_PG_MESSAGE_INSTRUCTION_KIND = 33_358;
const SESSION_BINDING_TAG = "wm-session-capability";
const DEFAULT_NIP44_MAX_PLAINTEXT_BYTES = 1_048_576;
const DEFAULT_NIP44_MAX_CIPHERTEXT_BYTES = 1_500_000;

// Keep this list explicit: ordinary agent work needs a small, reviewable set
// of social/profile, relay-discovery, app-data, release, and Flight Deck kinds.
// Blossom kind 24242 is included for compatible clients that request generic
// event signing; the dedicated blossom.authorize operation remains preferred.
export const DEFAULT_AGENT_NOSTR_EVENT_KINDS = Object.freeze([
  0, 1, 3, 4, 7,
  3_063,
  10_002,
  BLOSSOM_AUTH_KIND,
  30_063,
  30_078,
  32_267,
  FLIGHTDECK_PG_MESSAGE_INSTRUCTION_KIND,
]);

export type BrokerOperation =
  | "identity.read"
  | "capability.refresh"
  | "nip98.sign"
  | "nostr.sign"
  | "nip44.encrypt"
  | "nip44.decrypt"
  | "blossom.authorize"
  | "wallet.read"
  | "wallet.spend";

export interface Nip98Constraint {
  origins: string[];
  methods: string[];
  pathPrefixes: string[];
  bodyHashes?: string[];
  requireBodyHashMethods?: string[];
  targets?: Array<{
    origin: string;
    methods: string[];
    pathPrefixes: string[];
    exactPaths?: Nip98ExactPathConstraint[];
    requireBodyHashMethods?: string[];
  }>;
}

export interface Nip98ExtraTagRule {
  name: "nonce" | "aud" | "expiration";
  valueType: "non-empty" | "unix-timestamp";
  maxLength: number;
  maxFutureSeconds?: number;
}

export interface Nip98ExactPathConstraint {
  path: string;
  methods: string[];
  requireBodyHash?: boolean;
  extraTags?: {
    allowed: Nip98ExtraTagRule[];
    required: Array<Nip98ExtraTagRule["name"]>;
    omitSessionBinding?: boolean;
  };
}

export interface NostrConstraint {
  kinds: number[];
  maxContentBytes: number;
  maxTags: number;
  maxTagBytes?: number;
  allowedTagNames?: string[];
  requiredTags?: Array<[string, string]>;
  kindRules?: NostrKindConstraint[];
}

export interface Nip44Constraint {
  encryptPeers: string[];
  decryptPeers: string[];
  maxPlaintextBytes?: number;
  maxCiphertextBytes?: number;
}

export interface BlossomConstraint {
  servers: string[];
  methods: Array<"upload" | "delete" | "list">;
  maxObjectBytes: number;
  objectHashes?: string[];
}

export interface WalletConstraint {
  readMethods: string[];
  spendMethods: string[];
  maxSpendMsats: number;
  maxTotalSpendMsats: number;
}

export interface SessionCapabilityPolicy {
  operations: BrokerOperation[];
  nip98?: Nip98Constraint;
  nostr?: NostrConstraint;
  nip44?: Nip44Constraint;
  blossom?: BlossomConstraint;
  wallet?: WalletConstraint;
  maxCallsPerMinute?: number;
}

export interface IssuedSessionCapability {
  token: string;
  capabilityId: string;
  expiresAt: string;
  botNpub: string;
  botPubkeyHex: string;
  policyRefs: PolicyRevisionRef[];
}

export interface PolicyRevisionRef {
  id: string;
  revision: number;
}

export interface ActiveSessionCapability {
  capabilityId: string;
  sessionId: string;
  ownerNpub: string;
  botNpub: string;
  profileId: string | null;
  workspaceId: string | null;
  issuedAt: string;
  expiresAt: string;
  policyRefs: PolicyRevisionRef[];
}

export interface CapabilityAuditEntry {
  capabilityId: string;
  sessionId: string;
  botNpub: string;
  profileId?: string | null;
  operation: BrokerOperation;
  outcome: "allowed" | "denied";
  reason?: string;
  rateLimit?: {
    currentCount: number;
    limit: number;
    windowMs: number;
    retryAfterMs: number;
    windowResetsAt: string;
  };
  at: string;
}

export interface WalletBrokerAdapter {
  read(input: { method: string; params: unknown; botNpub: string }): Promise<unknown>;
  spend(input: { method: string; params: unknown; amountMsats: number; botNpub: string }): Promise<unknown>;
}

export interface GitCredentialBrokerAdapter {
  discover(input: {
    session: SessionSnapshot;
    botNpub: string;
    workspaceId: string;
    signNip98: (input: { url: string; method: "GET" | "POST" | "PUT"; bodyHash?: string; tags?: string[][] }) => Promise<string>;
  }): Promise<{ gatewayOrigins: string[] }>;
  exchange(input: {
    session: SessionSnapshot;
    botNpub: string;
    workspaceId: string;
    request: {
      protocol: "https";
      host: string;
      path: string;
      gatewayOrigin: string;
      organization: string;
      repository: string;
    };
    signNip98: (input: { url: string; method: "GET" | "POST" | "PUT"; bodyHash?: string; tags?: string[][] }) => Promise<string>;
  }): Promise<{ username: string; password: string; expiresAt: string }>;
}

export interface Nip98SessionBindingEvent {
  pubkey: string;
  created_at: number;
  tags: string[][];
}

interface CapabilityRecord {
  id: string;
  tokenHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  sessionId: string;
  ownerNpub: string;
  identityManagerNpub?: string;
  keySource?: "agent_vault" | "instance";
  botNpub: string;
  botPubkeyHex: string;
  profileId?: string | null;
  workspaceId?: string | null;
  policy: SessionCapabilityPolicy;
  policyRefs: PolicyRevisionRef[];
  revokedAtMs: number | null;
  usedNonces: Set<string>;
  callTimestamps: number[];
  spentMsats: number;
  usedChallenges: Set<string>;
}

export interface CapabilityBrokerDependencies {
  hasWappLoginAuthority?: (input: WappLoginRequest) => boolean;
  fetchWappLogin?: typeof fetch;
  botKeyStore: Pick<BotKeyStore, "getActiveKeyForUser"> & Partial<Pick<BotKeyStore, "getActiveKeyForBotNpub">>;
  keyVault: Pick<BrokerKeyVaultBackend, "withKey">;
  getSession: (sessionId: string) => SessionSnapshot | null | undefined;
  wallet?: WalletBrokerAdapter;
  gitCredential?: GitCredentialBrokerAdapter;
  audit?: (entry: CapabilityAuditEntry) => void;
  now?: () => number;
  stateStore?: CapabilityBrokerStateStore;
  getInstanceIdentity?: () => {
    npub: string;
    pubkeyHex: string;
    secretKey: Uint8Array;
  } | null;
}

export interface PersistedCapabilityRecord extends Omit<CapabilityRecord, "usedNonces" | "usedChallenges"> {
  usedNonces: string[];
  usedChallenges?: string[];
}

export interface CapabilityBrokerStateStore {
  load(): PersistedCapabilityRecord[];
  save(records: PersistedCapabilityRecord[]): void;
}

interface AuthorizedOperation {
  capability: CapabilityRecord;
  botRecord: BotKeyRecord | null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeMethod(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(normalizeHex(value));
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  const normalized = prefix.endsWith("/") && prefix !== "/" ? prefix.slice(0, -1) : prefix;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

function peerAllowed(peers: string[], peer: string): boolean {
  const normalized = normalizeHex(peer);
  return peers.includes("*") || peers.map(normalizeHex).includes(normalized);
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function clonePolicy(policy: SessionCapabilityPolicy): SessionCapabilityPolicy {
  return structuredClone(policy);
}

function parseNip98ExtraTags(value: unknown): string[][] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((tag) => Array.isArray(tag) && tag.length === 2 && tag.every((part) => typeof part === "string"))) {
    return null;
  }
  return value as string[][];
}

function validateNip98ExtraTags(
  tags: string[][],
  constraint: Nip98ExactPathConstraint["extraTags"],
  nowSeconds: number,
): string | null {
  if (!constraint) return tags.length === 0 ? null : "NIP-98 challenge tags are not allowed for this target";
  const rules = new Map(constraint.allowed.map((rule) => [rule.name, rule]));
  for (const tag of tags) {
    const name = tag[0] ?? "";
    const value = tag[1] ?? "";
    const rule = rules.get(name as Nip98ExtraTagRule["name"]);
    if (!rule) return "NIP-98 challenge tag is not allowed";
    if (tags.filter((candidate) => candidate[0] === name).length !== 1) {
      return "NIP-98 challenge tags must occur exactly once";
    }
    if (!value.trim() || Buffer.byteLength(value) > rule.maxLength) {
      return `NIP-98 ${name} tag is empty or exceeds policy`;
    }
    if (rule.valueType === "unix-timestamp") {
      if (!/^\d{1,12}$/.test(value)) return `NIP-98 ${name} tag must be an integer Unix timestamp`;
      const timestamp = Number(value);
      if (!Number.isSafeInteger(timestamp) || timestamp <= nowSeconds) return `NIP-98 ${name} tag has expired`;
      if (!rule.maxFutureSeconds || timestamp > nowSeconds + rule.maxFutureSeconds) {
        return `NIP-98 ${name} tag exceeds the allowed freshness window`;
      }
    }
  }
  for (const required of constraint.required) {
    if (tags.filter((tag) => tag[0] === required).length !== 1) {
      return `NIP-98 challenge requires exactly one ${required} tag`;
    }
  }
  return null;
}

export class CapabilityBroker {
  private readonly capabilitiesByHash = new Map<string, CapabilityRecord>();
  private readonly capabilitiesById = new Map<string, CapabilityRecord>();
  private readonly capabilityHashesBySession = new Map<string, Set<string>>();
  private readonly reissueHandoffsByHash = new Map<string, { sessionId: string; replacementToken: string }>();
  private readonly now: () => number;

  constructor(private readonly deps: CapabilityBrokerDependencies) {
    this.now = deps.now ?? Date.now;
    for (const persisted of deps.stateStore?.load() ?? []) {
      if (!persisted || persisted.revokedAtMs !== null) continue;
      const record: CapabilityRecord = {
        ...persisted,
        policy: clonePolicy(persisted.policy),
        usedNonces: new Set(persisted.usedNonces),
        usedChallenges: new Set(persisted.usedChallenges ?? []),
        callTimestamps: [...persisted.callTimestamps],
        policyRefs: Array.isArray(persisted.policyRefs) ? structuredClone(persisted.policyRefs) : [],
      };
      this.capabilitiesByHash.set(record.tokenHash, record);
      this.capabilitiesById.set(record.id, record);
      const hashes = this.capabilityHashesBySession.get(record.sessionId) ?? new Set<string>();
      hashes.add(record.tokenHash);
      this.capabilityHashesBySession.set(record.sessionId, hashes);
    }
  }

  private persist(): void {
    if (!this.deps.stateStore) return;
    const records = [...this.capabilitiesByHash.values()]
      .filter((record) => record.revokedAtMs === null)
      .map((record) => ({
        ...record,
        policy: clonePolicy(record.policy),
        usedNonces: [...record.usedNonces],
        usedChallenges: [...record.usedChallenges],
        callTimestamps: [...record.callTimestamps],
      }));
    this.deps.stateStore.save(records);
  }

  issueSessionCapability(input: {
    sessionId: string;
    ownerNpub: string;
    identityManagerNpub?: string;
    profileId?: string | null;
    workspaceId?: string | null;
    botNpub?: string | null;
    policy: SessionCapabilityPolicy;
    policyRefs?: PolicyRevisionRef[];
    ttlMs?: number;
  }): IssuedSessionCapability {
    const session = this.deps.getSession(input.sessionId);
    if (!session || session.npub !== input.ownerNpub) {
      throw new Error("Cannot issue capability for an unknown or mismatched session");
    }
    if (session.status === "stopped" || session.status === "error") {
      throw new Error("Cannot issue capability for an inactive session");
    }
    const metadata = session.metadata as Record<string, unknown> | undefined;
    const boundProfileId = typeof metadata?.agentChatAgentId === "string"
      ? metadata.agentChatAgentId
      : typeof metadata?.agentProfileId === "string" ? metadata.agentProfileId : null;
    const boundBotNpub = typeof metadata?.agentChatBotNpub === "string"
      ? metadata.agentChatBotNpub
      : typeof metadata?.flightdeckAgentNpub === "string" ? metadata.flightdeckAgentNpub : null;
    if (input.profileId && boundProfileId !== input.profileId) {
      throw new Error("Session profile binding does not match requested capability identity");
    }
    if (input.botNpub && boundBotNpub !== input.botNpub) {
      throw new Error("Session agent identity binding does not match requested capability identity");
    }
    const selectedBotNpub = input.botNpub ?? boundBotNpub;
    const identityManagerNpub = input.identityManagerNpub ?? input.ownerNpub;
    const instanceIdentity = this.deps.getInstanceIdentity?.() ?? null;
    const selectedInstanceIdentity = selectedBotNpub && instanceIdentity?.npub === selectedBotNpub
      ? instanceIdentity
      : null;
    const botRecord = selectedBotNpub
      ? this.deps.botKeyStore.getActiveKeyForBotNpub?.(selectedBotNpub) ?? null
      : this.deps.botKeyStore.getActiveKeyForUser(input.ownerNpub);
    if (!botRecord && !selectedInstanceIdentity) {
      throw new Error("Session owner has no active bot identity");
    }
    if (botRecord && botRecord.userNpub !== identityManagerNpub) {
      throw new Error("Selected agent identity is not managed by the active profile manager");
    }
    const ttlMs = Math.min(Math.max(input.ttlMs ?? SESSION_CAPABILITY_TTL_MS, 1_000), SESSION_CAPABILITY_TTL_MS);
    const now = this.now();
    const id = randomUUID();
    const token = `${TOKEN_PREFIX}.${randomBytes(32).toString("base64url")}`;
    const hash = tokenHash(token);
    const record: CapabilityRecord = {
      id,
      tokenHash: hash,
      issuedAtMs: now,
      expiresAtMs: now + ttlMs,
      sessionId: input.sessionId,
      ownerNpub: input.ownerNpub,
      identityManagerNpub,
      keySource: selectedInstanceIdentity && !botRecord ? "instance" : "agent_vault",
      botNpub: botRecord?.botNpub ?? selectedInstanceIdentity!.npub,
      botPubkeyHex: botRecord?.botPubkeyHex ?? selectedInstanceIdentity!.pubkeyHex,
      profileId: input.profileId ?? boundProfileId,
      workspaceId: input.workspaceId ?? (typeof metadata?.flightdeckWorkspaceId === "string" ? metadata.flightdeckWorkspaceId : null),
      policy: clonePolicy(input.policy),
      policyRefs: structuredClone(input.policyRefs ?? []),
      revokedAtMs: null,
      usedNonces: new Set(),
      callTimestamps: [],
      spentMsats: 0,
      usedChallenges: new Set(),
    };
    this.capabilitiesByHash.set(hash, record);
    this.capabilitiesById.set(id, record);
    const sessionHashes = this.capabilityHashesBySession.get(input.sessionId) ?? new Set<string>();
    sessionHashes.add(hash);
    this.capabilityHashesBySession.set(input.sessionId, sessionHashes);
    this.persist();
    return {
      token,
      capabilityId: id,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      botNpub: record.botNpub,
      botPubkeyHex: record.botPubkeyHex,
      policyRefs: structuredClone(record.policyRefs),
    };
  }

  listActiveCapabilities(): ActiveSessionCapability[] {
    return [...this.capabilitiesByHash.values()]
      .filter((record) => {
        if (record.revokedAtMs !== null) return false;
        const session = this.deps.getSession(record.sessionId);
        return Boolean(session && session.status !== "stopped" && session.status !== "error");
      })
      .map((record) => ({
        capabilityId: record.id,
        sessionId: record.sessionId,
        ownerNpub: record.ownerNpub,
        botNpub: record.botNpub,
        profileId: record.profileId ?? null,
        workspaceId: record.workspaceId ?? null,
        issuedAt: new Date(record.issuedAtMs).toISOString(),
        expiresAt: new Date(record.expiresAtMs).toISOString(),
        policyRefs: structuredClone(record.policyRefs),
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  revokeSession(sessionId: string): number {
    const hashes = this.capabilityHashesBySession.get(sessionId);
    if (!hashes) return 0;
    let revoked = 0;
    for (const hash of hashes) {
      this.reissueHandoffsByHash.delete(hash);
      const record = this.capabilitiesByHash.get(hash);
      if (record && record.revokedAtMs === null) {
        record.revokedAtMs = this.now();
        record.usedNonces.clear();
        revoked += 1;
      }
    }
    this.persist();
    return revoked;
  }

  reissueSessionCapability(sessionId: string, issue: () => IssuedSessionCapability): IssuedSessionCapability {
    const oldHashes = [...(this.capabilityHashesBySession.get(sessionId) ?? [])]
      .filter((hash) => this.capabilitiesByHash.get(hash)?.revokedAtMs === null);
    this.revokeSession(sessionId);
    const replacement = issue();
    for (const hash of oldHashes) {
      this.reissueHandoffsByHash.set(hash, { sessionId, replacementToken: replacement.token });
    }
    return replacement;
  }

  revokeBotNpub(botNpub: string): number {
    let revoked = 0;
    for (const record of this.capabilitiesByHash.values()) {
      if (record.botNpub === botNpub && record.revokedAtMs === null) {
        record.revokedAtMs = this.now();
        record.usedNonces.clear();
        revoked += 1;
      }
    }
    this.persist();
    return revoked;
  }

  getPublicIdentity(sessionId: string): { botNpub: string; botPubkeyHex: string } | null {
    const session = this.deps.getSession(sessionId);
    if (!session?.npub || session.status === "stopped" || session.status === "error") return null;
    const metadata = session.metadata as Record<string, unknown> | undefined;
    const boundBotNpub = typeof metadata?.agentChatBotNpub === "string"
      ? metadata.agentChatBotNpub
      : typeof metadata?.flightdeckAgentNpub === "string" ? metadata.flightdeckAgentNpub : null;
    const instanceIdentity = this.deps.getInstanceIdentity?.() ?? null;
    if (boundBotNpub && instanceIdentity?.npub === boundBotNpub) {
      return { botNpub: instanceIdentity.npub, botPubkeyHex: instanceIdentity.pubkeyHex };
    }
    const botRecord = boundBotNpub
      ? this.deps.botKeyStore.getActiveKeyForBotNpub?.(boundBotNpub) ?? null
      : this.deps.botKeyStore.getActiveKeyForUser(session.npub);
    return botRecord ? { botNpub: botRecord.botNpub, botPubkeyHex: botRecord.botPubkeyHex } : null;
  }

  async handle(request: Request, url: URL, method: string): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/mcp/capabilities")) return null;
    try {
      return await this.dispatch(request, url, method);
    } catch (error) {
      if (error instanceof BrokerKeyNotProvisionedError) {
        return Response.json({
          error: error.message,
          code: error.code,
          guidance: "Complete the authenticated browser unlock once or restore legacy escrow to the control process for one migration restart.",
        }, { status: 503 });
      }
      throw error;
    }
  }

  private async dispatch(request: Request, url: URL, method: string): Promise<Response> {
    if (method === "GET" && url.pathname === "/api/mcp/capabilities/status") {
      return Response.json({ service: "wingman-capability-broker", processIsolated: false });
    }
    if (method === "GET" && url.pathname === "/api/mcp/capabilities/identity") {
      return await this.handleIdentity(request);
    }
    if (method !== "POST") return jsonError("Not found", 404);
    if (url.pathname === "/api/mcp/capabilities/reissue-adopt") return await this.handleReissueAdopt(request);
    if (url.pathname === "/api/mcp/capabilities/refresh") return await this.handleRefresh(request);
    if (url.pathname === "/api/mcp/capabilities/nip98") return await this.handleNip98(request);
    if (url.pathname === "/api/mcp/capabilities/wapp-login") return await this.handleWappLogin(request);
    if (url.pathname === "/api/mcp/capabilities/git-discovery") return await this.handleGitDiscovery(request);
    if (url.pathname === "/api/mcp/capabilities/git-bootstrap") return Response.json({ error: "Retired: use native Forgejo account and repository APIs." }, { status: 410 });
    if (url.pathname === "/api/mcp/capabilities/git-credential") return await this.handleGitCredential(request);
    if (url.pathname === "/api/mcp/capabilities/nostr-event") return await this.handleNostrEvent(request);
    if (url.pathname === "/api/mcp/capabilities/nip44/encrypt") return await this.handleNip44Encrypt(request);
    if (url.pathname === "/api/mcp/capabilities/nip44/decrypt") return await this.handleNip44Decrypt(request);
    if (url.pathname === "/api/mcp/capabilities/blossom/authorize") return await this.handleBlossomAuthorize(request);
    if (url.pathname === "/api/mcp/capabilities/wallet") return await this.handleWallet(request);
    return jsonError("Not found", 404);
  }

  private async authorize(
    request: Request,
    operation: BrokerOperation,
    sessionId: string,
    options: { allowExpired?: boolean } = {},
  ): Promise<AuthorizedOperation | Response> {
    const token = readBearerToken(request);
    if (!token) return jsonError("Missing capability bearer token", 401);
    const capability = this.capabilitiesByHash.get(tokenHash(token));
    if (!capability) return jsonError("Invalid capability", 403);
    const deny = (reason: string, status = 403, rateLimit?: CapabilityAuditEntry["rateLimit"]) => {
      this.audit(capability, operation, "denied", reason, rateLimit);
      if (!rateLimit) return jsonError(reason, status);
      return Response.json({
        error: reason,
        code: "capability_rate_limited",
        capabilityId: capability.id,
        sessionId: capability.sessionId,
        operation,
        rateLimit,
      }, {
        status,
        headers: {
          "retry-after": String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))),
          "x-ratelimit-limit": String(rateLimit.limit),
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(new Date(rateLimit.windowResetsAt).getTime() / 1_000)),
        },
      });
    };
    const now = this.now();
    if (capability.revokedAtMs !== null) {
      if (this.reissueHandoffsByHash.has(capability.tokenHash)) {
        this.audit(capability, operation, "denied", "Capability has an explicit administrator-issued replacement");
        return Response.json({ error: "Capability was reissued by an administrator", code: "capability_reissued" }, { status: 409 });
      }
      return deny("Capability has been revoked");
    }
    if (capability.expiresAtMs <= now && !options.allowExpired) return deny("Capability has expired");
    if (capability.sessionId !== sessionId) return deny("Capability is bound to a different session");
    if (!capability.policy.operations.includes(operation)) return deny("Capability does not allow this operation");
    const session = this.deps.getSession(sessionId);
    if (!session || session.status === "stopped" || session.status === "error") {
      return deny("Session is not active");
    }
    if (session.npub !== capability.ownerNpub) return deny("Session identity changed");
    const botRecord = this.deps.botKeyStore.getActiveKeyForBotNpub?.(capability.botNpub) ?? null;
    const instanceIdentity = capability.keySource === "instance"
      ? this.deps.getInstanceIdentity?.() ?? null
      : null;
    const agentIdentityChanged = capability.keySource !== "instance" && (
      !botRecord
      || botRecord.userNpub !== (capability.identityManagerNpub ?? capability.ownerNpub)
      || botRecord.botNpub !== capability.botNpub
      || botRecord.botPubkeyHex !== capability.botPubkeyHex
    );
    const instanceIdentityChanged = capability.keySource === "instance" && (
      !instanceIdentity
      || instanceIdentity.npub !== capability.botNpub
      || instanceIdentity.pubkeyHex !== capability.botPubkeyHex
    );
    if (agentIdentityChanged || instanceIdentityChanged) {
      return deny("Agent identity changed");
    }
    const nonce = request.headers.get("x-wingman-capability-nonce")?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return deny("Missing or malformed capability nonce", 400);
    if (capability.usedNonces.has(nonce)) return deny("Capability nonce has already been used");
    capability.usedNonces.add(nonce);
    if (capability.usedNonces.size > MAX_NONCES_PER_CAPABILITY) {
      const oldest = capability.usedNonces.values().next().value;
      if (oldest) capability.usedNonces.delete(oldest);
    }
    capability.callTimestamps = capability.callTimestamps.filter((timestamp) => timestamp > now - 60_000);
    const maxCalls = capability.policy.maxCallsPerMinute ?? DEFAULT_MAX_CALLS_PER_MINUTE;
    if (capability.callTimestamps.length >= maxCalls) {
      const windowMs = 60_000;
      const windowResetsAtMs = (capability.callTimestamps[0] ?? now) + windowMs;
      return deny("Capability rate limit exceeded", 429, {
        currentCount: capability.callTimestamps.length,
        limit: maxCalls,
        windowMs,
        retryAfterMs: Math.max(1, windowResetsAtMs - now),
        windowResetsAt: new Date(windowResetsAtMs).toISOString(),
      });
    }
    capability.callTimestamps.push(now);
    this.persist();
    return { capability, botRecord: capability.keySource === "instance" ? null : botRecord };
  }

  private async handleIdentity(request: Request): Promise<Response> {
    const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
    const authorized = await this.authorize(request, "identity.read", sessionId);
    if (authorized instanceof Response) return authorized;
    this.audit(authorized.capability, "identity.read", "allowed");
    return Response.json({
      identityType: "agent",
      botNpub: authorized.capability.botNpub,
      botPubkeyHex: authorized.capability.botPubkeyHex,
      ownerNpub: authorized.capability.ownerNpub,
    });
  }

  private async handleReissueAdopt(request: Request): Promise<Response> {
    const token = readBearerToken(request);
    if (!token) return jsonError("Missing capability bearer token", 401);
    const hash = tokenHash(token);
    const handoff = this.reissueHandoffsByHash.get(hash);
    const oldCapability = this.capabilitiesByHash.get(hash);
    if (!handoff || !oldCapability) return jsonError("No explicit capability replacement is available", 403);
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (sessionId !== handoff.sessionId || oldCapability.sessionId !== sessionId) return jsonError("Capability replacement is bound to a different session", 403);
    const nonce = request.headers.get("x-wingman-capability-nonce")?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return jsonError("Missing or malformed capability nonce", 400);
    if (oldCapability.usedNonces.has(nonce)) return jsonError("Capability nonce has already been used", 403);
    const session = this.deps.getSession(sessionId);
    if (!session || session.npub !== oldCapability.ownerNpub || session.status === "stopped" || session.status === "error") {
      return jsonError("Session is not active", 403);
    }
    for (const [candidateHash, candidate] of this.reissueHandoffsByHash) {
      if (candidate.sessionId === sessionId && candidate.replacementToken === handoff.replacementToken) {
        this.reissueHandoffsByHash.delete(candidateHash);
      }
    }
    return Response.json({ token: handoff.replacementToken });
  }

  private async handleRefresh(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    // A session capability is renewable for the lifetime of its exact live
    // session. Expiry still blocks every signing/data operation; only this
    // same-policy refresh path may recover after an idle period or restart.
    const authorized = await this.authorize(request, "capability.refresh", sessionId, { allowExpired: true });
    if (authorized instanceof Response) return authorized;
    const token = readBearerToken(request);
    if (!token) return this.denied(authorized.capability, "capability.refresh", "Missing capability bearer token", 401);
    authorized.capability.expiresAtMs = this.now() + SESSION_CAPABILITY_TTL_MS;
    this.persist();
    this.audit(authorized.capability, "capability.refresh", "allowed");
    return Response.json({
      token,
      capabilityId: authorized.capability.id,
      expiresAt: new Date(authorized.capability.expiresAtMs).toISOString(),
      botNpub: authorized.capability.botNpub,
      botPubkeyHex: authorized.capability.botPubkeyHex,
      policyRefs: structuredClone(authorized.capability.policyRefs),
    } satisfies IssuedSessionCapability);
  }

  private async handleWappLogin(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nostr.sign", sessionId);
    if (authorized instanceof Response) return authorized;
    const input: WappLoginRequest = {
      sessionId, ownerNpub: authorized.capability.ownerNpub,
      installationId: typeof body.wappInstallationId === "string" ? body.wappInstallationId.trim() : "",
      url: typeof body.url === "string" ? body.url : "",
    };
    if (!this.deps.hasWappLoginAuthority?.(input)) {
      return this.denied(authorized.capability, "nostr.sign", "WApp login requires an active execution-bound installation and exact registered login URL");
    }
    let template;
    try { template = await fetchWappLoginChallenge(input.url, this.now(), this.deps.fetchWappLogin); }
    catch (error) {
      return this.denied(authorized.capability, "nostr.sign", (error as Error).message, 502);
    }
    if (authorized.capability.revokedAtMs !== null || authorized.capability.expiresAtMs <= this.now()
      || !this.deps.hasWappLoginAuthority(input)) {
      return this.denied(authorized.capability, "nostr.sign", "WApp login authority changed during challenge fetch");
    }
    const fingerprint = `wapp-login:${input.installationId}:${input.url}:${template.tags[0]![1]}`;
    if (authorized.capability.usedChallenges.has(fingerprint)) {
      return this.denied(authorized.capability, "nostr.sign", "WApp login challenge has already been signed");
    }
    // Reserve before the asynchronous vault call, preventing concurrent reuse.
    authorized.capability.usedChallenges.add(fingerprint);
    if (authorized.capability.usedChallenges.size > MAX_CHALLENGES_PER_CAPABILITY) {
      const oldest = authorized.capability.usedChallenges.values().next().value;
      if (oldest) authorized.capability.usedChallenges.delete(oldest);
    }
    this.persist();
    const event = await this.withAuthorizedKey(authorized, (key) => finalizeEvent(template, key));
    this.audit(authorized.capability, "nostr.sign", "allowed", "execution-bound WApp native login");
    return Response.json({ event, signedBy: authorized.capability.botNpub, wappInstallationId: input.installationId, url: input.url });
  }

  private async handleNip98(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nip98.sign", sessionId);
    if (authorized instanceof Response) return authorized;
    const targetUrl = typeof body.url === "string" ? body.url.trim() : "";
    const method = typeof body.method === "string" ? normalizeMethod(body.method) : "";
    const bodyHash = typeof body.bodyHash === "string" ? normalizeHex(body.bodyHash) : undefined;
    const extraTags = parseNip98ExtraTags(body.tags);
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return this.denied(authorized.capability, "nip98.sign", "url must be an absolute URL", 400);
    }
    if (bodyHash && !isHex64(bodyHash)) {
      return this.denied(authorized.capability, "nip98.sign", "bodyHash must be a SHA-256 hex digest", 400);
    }
    if (!extraTags) {
      return this.denied(authorized.capability, "nip98.sign", "tags must be an array of two-string tuples", 400);
    }
    const constraint = authorized.capability.policy.nip98;
    if (!constraint) return this.denied(authorized.capability, "nip98.sign", "NIP-98 policy is missing");
    const originTargets = constraint.targets?.filter((candidate) => candidate.origin === parsed.origin) ?? [];
    const exactMatches = originTargets.flatMap((candidate) => (candidate.exactPaths ?? [])
      .filter((exactPath) => exactPath.path === parsed.pathname)
      .map((exactPath) => ({ target: candidate, exactPath })));
    const exactMatch = exactMatches[0];
    const prefixTargets = originTargets.filter((candidate) => candidate.pathPrefixes.some((prefix) => pathMatchesPrefix(parsed.pathname, prefix)));
    const legacyOriginAllowed = originTargets.length === 0 && constraint.origins.includes(parsed.origin);
    const target = exactMatch?.target ?? prefixTargets[0];
    const exactPath = exactMatch?.exactPath;
    const allowedOrigins = constraint.targets?.map((candidate) => candidate.origin) ?? constraint.origins;
    const allowedMethods = exactPath?.methods ?? target?.methods ?? constraint.methods;
    const requireBodyHashMethods = target?.requireBodyHashMethods ?? constraint.requireBodyHashMethods;
    if (!allowedOrigins.includes(parsed.origin)) return this.denied(authorized.capability, "nip98.sign", "NIP-98 origin is not allowed");
    if (!allowedMethods.map(normalizeMethod).includes(method)) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 method is not allowed");
    }
    if (!exactPath && prefixTargets.length === 0 && !(legacyOriginAllowed && constraint.pathPrefixes.some((prefix) => pathMatchesPrefix(parsed.pathname, prefix)))) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 path is not allowed");
    }
    if (constraint.bodyHashes?.length && (!bodyHash || !constraint.bodyHashes.map(normalizeHex).includes(bodyHash))) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 body hash is not allowed");
    }
    const bodyHashRequired = exactPath
      ? exactPath.requireBodyHash === true
      : requireBodyHashMethods?.map(normalizeMethod).includes(method) === true;
    if (bodyHashRequired && !bodyHash) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 body hash is required for this method", 400);
    }
    const createdAt = Math.floor(this.now() / 1000);
    const tagError = validateNip98ExtraTags(extraTags, exactPath?.extraTags, createdAt);
    if (tagError) return this.denied(authorized.capability, "nip98.sign", tagError, 400);
    const challengeTagOrder = new Map(exactPath?.extraTags?.allowed.map((rule, index) => [rule.name, index]) ?? []);
    const canonicalExtraTags = exactPath?.extraTags
      ? [...extraTags].sort((left, right) => (challengeTagOrder.get(left[0] as Nip98ExtraTagRule["name"]) ?? Number.MAX_SAFE_INTEGER)
        - (challengeTagOrder.get(right[0] as Nip98ExtraTagRule["name"]) ?? Number.MAX_SAFE_INTEGER))
      : extraTags;
    if (exactPath?.extraTags) {
      const requestId = canonicalExtraTags.find((tag) => tag[0] === "nonce")?.[1] ?? "";
      const expectedBodyHash = createHash("sha256").update(JSON.stringify({ request_id: requestId })).digest("hex");
      if (bodyHash !== expectedBodyHash) {
        return this.denied(authorized.capability, "nip98.sign", "NIP-98 challenge payload hash does not match the exact request body", 400);
      }
    }
    const challengeFingerprint = canonicalExtraTags.length > 0
      ? createHash("sha256").update(JSON.stringify([parsed.toString(), method, bodyHash ?? null, canonicalExtraTags])).digest("hex")
      : null;
    if (challengeFingerprint && authorized.capability.usedChallenges.has(challengeFingerprint)) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 challenge has already been signed");
    }
    if (challengeFingerprint) {
      authorized.capability.usedChallenges.add(challengeFingerprint);
      if (authorized.capability.usedChallenges.size > MAX_CHALLENGES_PER_CAPABILITY) {
        const oldest = authorized.capability.usedChallenges.values().next().value;
        if (oldest) authorized.capability.usedChallenges.delete(oldest);
      }
      this.persist();
    }
    let result: { token: string; signedBy: string };
    try {
      result = await this.withAuthorizedKey(authorized, (secretKey) => {
        const tags = [["u", parsed.toString()], ["method", method]];
        if (bodyHash) tags.push(["payload", bodyHash]);
        tags.push(...canonicalExtraTags);
        if (!exactPath?.extraTags?.omitSessionBinding) {
          const bindingMac = this.createSessionBindingMac(authorized.capability, {
            pubkey: authorized.capability.botPubkeyHex,
            createdAt,
            url: parsed.toString(),
            method,
            bodyHash,
          });
          tags.push([SESSION_BINDING_TAG, authorized.capability.id, authorized.capability.sessionId, bindingMac]);
        }
        const event = finalizeEvent({ kind: NIP98_KIND, content: "", tags, created_at: createdAt }, secretKey);
        return { token: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`, signedBy: authorized.capability.botNpub };
      });
    } catch (error) {
      if (challengeFingerprint) {
        authorized.capability.usedChallenges.delete(challengeFingerprint);
        this.persist();
      }
      throw error;
    }
    this.audit(authorized.capability, "nip98.sign", "allowed");
    return Response.json(result);
  }

  private async handleGitDiscovery(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nip98.sign", sessionId);
    if (authorized instanceof Response) return authorized;
    const adapter = this.deps.gitCredential;
    if (!adapter) return this.denied(authorized.capability, "nip98.sign", "Native Forgejo credential brokerage is unavailable", 503);
    const session = this.deps.getSession(sessionId);
    const workspaceId = authorized.capability.workspaceId?.trim() ?? "";
    if (!session) {
      return this.denied(authorized.capability, "nip98.sign", "The agent session is unavailable");
    }
    try {
      const result = await adapter.discover({
        session,
        botNpub: authorized.capability.botNpub,
        workspaceId,
        signNip98: (input) => this.signExactNip98(authorized, input),
      });
      this.audit(authorized.capability, "nip98.sign", "allowed");
      return Response.json(result);
    } catch (error) {
      return this.denied(authorized.capability, "nip98.sign", "Native Forgejo configuration is unavailable (git_broker_unavailable)", 502);
    }
  }

  private async handleGitCredential(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nip98.sign", sessionId);
    if (authorized instanceof Response) return authorized;
    const adapter = this.deps.gitCredential;
    if (!adapter) return this.denied(authorized.capability, "nip98.sign", "Native Forgejo credential brokerage is unavailable", 503);
    const session = this.deps.getSession(sessionId);
    const workspaceId = authorized.capability.workspaceId?.trim() ?? "";
    if (!session) {
      return this.denied(authorized.capability, "nip98.sign", "The agent session is unavailable");
    }
    let credentialRequest;
    try {
      credentialRequest = canonicalizeGitCredentialRequest({
        protocol: typeof body.protocol === "string" ? body.protocol : "",
        host: typeof body.host === "string" ? body.host : "",
        path: typeof body.path === "string" ? body.path : "",
      });
    } catch {
      return this.denied(authorized.capability, "nip98.sign", "Git credential request is malformed", 400);
    }
    try {
      const result = await adapter.exchange({
        session,
        botNpub: authorized.capability.botNpub,
        workspaceId,
        request: credentialRequest,
        signNip98: (input) => this.signExactNip98(authorized, input),
      });
      this.audit(authorized.capability, "nip98.sign", "allowed");
      return Response.json(result);
    } catch (error) {
      return this.denied(authorized.capability, "nip98.sign", "Native Forgejo sign-in failed; check the native account and Tower login allowlist (git_broker_unavailable)", 502);
    }
  }

  private async signExactNip98(
    authorized: AuthorizedOperation,
    input: { url: string; method: "GET" | "POST" | "PUT"; bodyHash?: string; tags?: string[][] },
  ): Promise<string> {
    const parsed = new URL(input.url);
    const createdAt = Math.floor(this.now() / 1_000);
    return await this.withAuthorizedKey(authorized, (secretKey) => {
      const extras = input.tags ?? [["nonce", randomBytes(16).toString("hex")]];
      if (extras.some(tag => !["nonce", "aud", "expiration"].includes(tag[0] ?? ""))) throw new Error("Invalid native login signing tag.");
      const tags = [["u", parsed.toString()], ["method", input.method], ...extras];
      if (input.bodyHash) tags.push(["payload", input.bodyHash]);
      const event = finalizeEvent({ kind: NIP98_KIND, content: "", tags, created_at: createdAt }, secretKey);
      return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
    });
  }

  verifyNip98SessionBinding(event: Nip98SessionBindingEvent): string | null {
    const tag = event.tags.find((candidate) => candidate[0] === SESSION_BINDING_TAG);
    const capabilityId = tag?.[1];
    const sessionId = tag?.[2];
    const providedMac = tag?.[3];
    if (!capabilityId || !sessionId || !providedMac) return null;
    const capability = this.capabilitiesById.get(capabilityId);
    if (!capability || capability.sessionId !== sessionId || capability.botPubkeyHex !== event.pubkey ||
      capability.revokedAtMs !== null || capability.expiresAtMs <= this.now()) {
      return null;
    }
    const session = this.deps.getSession(sessionId);
    if (!session || session.npub !== capability.ownerNpub || session.status === "stopped" || session.status === "error") {
      return null;
    }
    const url = event.tags.find((candidate) => candidate[0] === "u")?.[1];
    const method = event.tags.find((candidate) => candidate[0] === "method")?.[1];
    const bodyHash = event.tags.find((candidate) => candidate[0] === "payload")?.[1];
    if (!url || !method) return null;
    const expectedMac = this.createSessionBindingMac(capability, {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      url,
      method,
      bodyHash,
    });
    const expected = Buffer.from(expectedMac, "hex");
    const provided = Buffer.from(providedMac, "hex");
    return expected.length === provided.length && timingSafeEqual(expected, provided) ? sessionId : null;
  }

  private createSessionBindingMac(
    capability: CapabilityRecord,
    input: { pubkey: string; createdAt: number; url: string; method: string; bodyHash?: string },
  ): string {
    return createHmac("sha256", capability.tokenHash)
      .update(JSON.stringify([
        capability.id,
        capability.sessionId,
        input.pubkey,
        input.createdAt,
        input.url,
        input.method,
        input.bodyHash ?? null,
      ]))
      .digest("hex");
  }

  private async handleNostrEvent(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nostr.sign", sessionId);
    if (authorized instanceof Response) return authorized;
    const event = body.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return this.denied(authorized.capability, "nostr.sign", "event is required", 400);
    }
    const template = event as Record<string, unknown>;
    const kind = template.kind;
    const content = template.content;
    const tags = template.tags;
    const constraint = authorized.capability.policy.nostr;
    if (!constraint) return this.denied(authorized.capability, "nostr.sign", "Nostr policy is missing");
    if (!Number.isInteger(kind) || kind === NIP98_KIND || !constraint.kinds.includes(kind as number)) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event kind is not allowed");
    }
    let kindRules: NostrKindConstraint[];
    try {
      kindRules = normalizeNostrKindRules(
        constraint.kindRules,
        constraint.kinds.filter((candidate) => candidate !== NIP98_KIND && !DEFAULT_AGENT_NOSTR_EVENT_KINDS.includes(candidate)),
      );
    } catch {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event kind constraints are invalid");
    }
    const effectiveConstraint = kindRules.find((rule) => rule.kind === kind) ?? constraint;
    if (typeof content !== "string" || Buffer.byteLength(content) > effectiveConstraint.maxContentBytes) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event content exceeds policy", 400);
    }
    if (!Array.isArray(tags) || tags.length > effectiveConstraint.maxTags || !tags.every((tag) => Array.isArray(tag) && tag.every((value) => typeof value === "string"))) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event tags exceed policy", 400);
    }
    const stringTags = tags as string[][];
    const tagBytes = stringTags.reduce((total, tag) => total + tag.reduce((size, value) => size + Buffer.byteLength(value), 0), 0);
    if (tagBytes > (effectiveConstraint.maxTagBytes ?? 65_536)) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event tags exceed byte policy", 400);
    }
    if (effectiveConstraint.allowedTagNames && stringTags.some((tag) => !effectiveConstraint.allowedTagNames!.includes(tag[0] ?? ""))) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event tag is not allowed");
    }
    if (effectiveConstraint.requiredTags?.some(([name, value]) => !stringTags.some((tag) => tag[0] === name && tag[1] === value))) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event is missing a required tag");
    }
    const signed = await this.withAuthorizedKey(authorized, (secretKey) => finalizeEvent({
      kind: kind as number,
      content,
      tags: stringTags,
      created_at: Math.floor(this.now() / 1000),
    }, secretKey));
    this.audit(authorized.capability, "nostr.sign", "allowed");
    return Response.json({ event: signed, signerPubkey: authorized.capability.botPubkeyHex, signerNpub: authorized.capability.botNpub });
  }

  private async handleNip44Encrypt(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nip44.encrypt", sessionId);
    if (authorized instanceof Response) return authorized;
    const plaintext = typeof body.plaintext === "string" ? body.plaintext : null;
    const peer = typeof body.recipientPubkey === "string" ? normalizeHex(body.recipientPubkey) : "";
    if (!plaintext || !isHex64(peer)) return this.denied(authorized.capability, "nip44.encrypt", "plaintext and recipientPubkey are required", 400);
    const constraint = authorized.capability.policy.nip44;
    if (!constraint || !peerAllowed(constraint.encryptPeers, peer)) return this.denied(authorized.capability, "nip44.encrypt", "NIP-44 recipient is not allowed");
    if (constraint.maxPlaintextBytes !== undefined && Buffer.byteLength(plaintext) > constraint.maxPlaintextBytes) {
      return this.denied(authorized.capability, "nip44.encrypt", "NIP-44 plaintext exceeds policy", 400);
    }
    try {
      const ciphertext = await this.withAuthorizedKey(authorized, (secretKey) => nip44Encrypt(plaintext, secretKey, peer));
      this.audit(authorized.capability, "nip44.encrypt", "allowed");
      return Response.json({ ciphertext, senderPubkey: authorized.capability.botPubkeyHex, senderNpub: authorized.capability.botNpub });
    } catch (error) {
      if (error instanceof BrokerKeyNotProvisionedError) throw error;
      return this.denied(authorized.capability, "nip44.encrypt", "NIP-44 encryption failed", 400);
    }
  }

  private async handleNip44Decrypt(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nip44.decrypt", sessionId);
    if (authorized instanceof Response) return authorized;
    const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
    const peer = typeof body.senderPubkey === "string" ? normalizeHex(body.senderPubkey) : "";
    if (!ciphertext || !isHex64(peer)) return this.denied(authorized.capability, "nip44.decrypt", "ciphertext and senderPubkey are required", 400);
    const constraint = authorized.capability.policy.nip44;
    if (!constraint || !peerAllowed(constraint.decryptPeers, peer)) return this.denied(authorized.capability, "nip44.decrypt", "NIP-44 sender is not allowed");
    if (constraint.maxCiphertextBytes !== undefined && Buffer.byteLength(ciphertext) > constraint.maxCiphertextBytes) {
      return this.denied(authorized.capability, "nip44.decrypt", "NIP-44 ciphertext exceeds policy", 400);
    }
    try {
      const plaintext = await this.withAuthorizedKey(authorized, (secretKey) => nip44Decrypt(ciphertext, secretKey, peer));
      this.audit(authorized.capability, "nip44.decrypt", "allowed");
      return Response.json({ plaintext, decryptedBy: authorized.capability.botPubkeyHex, decryptedByNpub: authorized.capability.botNpub });
    } catch (error) {
      if (error instanceof BrokerKeyNotProvisionedError) throw error;
      return this.denied(authorized.capability, "nip44.decrypt", "NIP-44 decryption failed", 400);
    }
  }

  private async handleBlossomAuthorize(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "blossom.authorize", sessionId);
    if (authorized instanceof Response) return authorized;
    const server = typeof body.server === "string" ? body.server.trim() : "";
    const blossomMethod = typeof body.method === "string" ? body.method.trim().toLowerCase() : "";
    const objectHash = typeof body.objectHash === "string" ? normalizeHex(body.objectHash) : "";
    const objectSize = typeof body.objectSize === "number" ? body.objectSize : 0;
    let origin: string;
    try { origin = new URL(server).origin; } catch { return this.denied(authorized.capability, "blossom.authorize", "Blossom server must be an absolute URL", 400); }
    const constraint = authorized.capability.policy.blossom;
    if (!constraint || !constraint.servers.includes(origin)) return this.denied(authorized.capability, "blossom.authorize", "Blossom server is not allowed");
    if (!constraint.methods.includes(blossomMethod as BlossomConstraint["methods"][number])) return this.denied(authorized.capability, "blossom.authorize", "Blossom method is not allowed");
    if (!isHex64(objectHash)) return this.denied(authorized.capability, "blossom.authorize", "Blossom object hash is required", 400);
    if (!Number.isSafeInteger(objectSize) || objectSize < 0 || objectSize > constraint.maxObjectBytes) return this.denied(authorized.capability, "blossom.authorize", "Blossom object size exceeds policy");
    if (constraint.objectHashes?.length && !constraint.objectHashes.map(normalizeHex).includes(objectHash)) return this.denied(authorized.capability, "blossom.authorize", "Blossom object hash is not allowed");
    const event = await this.withAuthorizedKey(authorized, (secretKey) => finalizeEvent({
      kind: BLOSSOM_AUTH_KIND,
      content: `Authorize Blossom ${blossomMethod}`,
      created_at: Math.floor(this.now() / 1000),
      tags: [["t", blossomMethod], ["x", objectHash], ["size", String(objectSize)], ["server", origin], ["expiration", String(Math.floor((this.now() + 60_000) / 1000))]],
    }, secretKey));
    this.audit(authorized.capability, "blossom.authorize", "allowed");
    return Response.json({ authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`, event, signerNpub: authorized.capability.botNpub });
  }

  private async handleWallet(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const amountMsats = typeof body.amountMsats === "number" ? body.amountMsats : 0;
    const operation: BrokerOperation = amountMsats > 0 ? "wallet.spend" : "wallet.read";
    const authorized = await this.authorize(request, operation, sessionId);
    if (authorized instanceof Response) return authorized;
    if (!this.deps.wallet) return this.denied(authorized.capability, operation, "Wallet broker is not configured", 501);
    const walletMethod = typeof body.method === "string" ? body.method.trim() : "";
    const constraint = authorized.capability.policy.wallet;
    if (!constraint) return this.denied(authorized.capability, operation, "Wallet policy is missing");
    if (operation === "wallet.read") {
      if (!constraint.readMethods.includes(walletMethod)) return this.denied(authorized.capability, operation, "Wallet read method is not allowed");
      const result = await this.deps.wallet.read({ method: walletMethod, params: body.params, botNpub: authorized.capability.botNpub });
      this.audit(authorized.capability, operation, "allowed");
      return Response.json({ result });
    }
    if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0 || amountMsats > constraint.maxSpendMsats || authorized.capability.spentMsats + amountMsats > constraint.maxTotalSpendMsats) {
      return this.denied(authorized.capability, operation, "Wallet spend exceeds capability budget");
    }
    if (!constraint.spendMethods.includes(walletMethod)) return this.denied(authorized.capability, operation, "Wallet spend method is not allowed");
    // Reserve the budget before awaiting the adapter so concurrent requests
    // cannot both pass the cumulative limit. Roll back only when the adapter
    // reports failure.
    authorized.capability.spentMsats += amountMsats;
    this.persist();
    let result: unknown;
    try {
      result = await this.deps.wallet.spend({ method: walletMethod, params: body.params, amountMsats, botNpub: authorized.capability.botNpub });
    } catch (error) {
      authorized.capability.spentMsats -= amountMsats;
      this.persist();
      throw error;
    }
    this.audit(authorized.capability, operation, "allowed");
    return Response.json({ result, remainingMsats: constraint.maxTotalSpendMsats - authorized.capability.spentMsats });
  }

  private async withBotKey<T>(record: BotKeyRecord, operation: (secretKey: Uint8Array) => T | Promise<T>): Promise<T> {
    return this.deps.keyVault.withKey(record, operation);
  }

  private async withAuthorizedKey<T>(
    authorized: AuthorizedOperation,
    operation: (secretKey: Uint8Array) => T | Promise<T>,
  ): Promise<T> {
    if (authorized.botRecord) return this.withBotKey(authorized.botRecord, operation);
    const instanceIdentity = this.deps.getInstanceIdentity?.() ?? null;
    if (
      !instanceIdentity
      || instanceIdentity.npub !== authorized.capability.botNpub
      || instanceIdentity.pubkeyHex !== authorized.capability.botPubkeyHex
    ) {
      throw new BrokerKeyNotProvisionedError(
        authorized.capability.identityManagerNpub ?? authorized.capability.ownerNpub,
        authorized.capability.botNpub,
      );
    }
    const secretKey = new Uint8Array(instanceIdentity.secretKey);
    try {
      return await operation(secretKey);
    } finally {
      secretKey.fill(0);
    }
  }

  private denied(capability: CapabilityRecord, operation: BrokerOperation, reason: string, status = 403): Response {
    this.audit(capability, operation, "denied", reason);
    return jsonError(reason, status);
  }

  private audit(
    capability: CapabilityRecord,
    operation: BrokerOperation,
    outcome: "allowed" | "denied",
    reason?: string,
    rateLimit?: CapabilityAuditEntry["rateLimit"],
  ): void {
    this.deps.audit?.({
      capabilityId: capability.id,
      sessionId: capability.sessionId,
      botNpub: capability.botNpub,
      profileId: capability.profileId ?? null,
      operation,
      outcome,
      ...(reason ? { reason } : {}),
      ...(rateLimit ? { rateLimit } : {}),
      at: new Date(this.now()).toISOString(),
    });
  }
}

export function buildDefaultAgentCapabilityPolicy(input: {
  towerUrl: string;
  towerUrls?: string[];
  autopilotUrl: string;
  ownerNpub?: string;
  blossomServers?: string[];
}): SessionCapabilityPolicy {
  const towerOrigins = [...new Set([input.towerUrl, ...(input.towerUrls ?? [])]
    .map((towerUrl) => new URL(towerUrl).origin))];
  const autopilotOrigin = new URL(input.autopilotUrl).origin;
  const ownerPath = input.ownerNpub ? `/api/owners/${encodeURIComponent(input.ownerNpub)}` : null;
  const mutatingMethods = ["POST", "PUT", "PATCH"];
  return {
    operations: ["identity.read", "capability.refresh", "nip98.sign", "nostr.sign", "nip44.encrypt", "nip44.decrypt", "blossom.authorize"],
    nip98: {
      origins: [...towerOrigins, autopilotOrigin],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      pathPrefixes: [],
      targets: [
        ...towerOrigins.map((towerOrigin) => ({
          origin: towerOrigin,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          pathPrefixes: ["/api/v4"],
          requireBodyHashMethods: mutatingMethods,
        })),
        {
          origin: autopilotOrigin,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          pathPrefixes: [
            "/api/apps",
            "/api/archive",
            "/api/delegate-sessions",
            "/api/nightwatch",
            "/api/pipelines",
            "/api/remote-instruct",
            "/api/scheduler",
            "/api/sessions",
            "/api/wapps",
            ...(ownerPath ? [ownerPath] : []),
          ],
          exactPaths: [
            { path: "/api/admin/wapps/legacy-custody-migration", methods: ["POST"], requireBodyHash: true },
            { path: "/api/system/restart", methods: ["POST"], requireBodyHash: false },
            { path: "/api/system/restart-and-resume", methods: ["POST"], requireBodyHash: false },
            { path: "/api/system/restart/status", methods: ["GET"] },
          ],
          requireBodyHashMethods: mutatingMethods,
        },
      ],
    },
    nostr: {
      kinds: [...DEFAULT_AGENT_NOSTR_EVENT_KINDS],
      maxContentBytes: 1_048_576,
      maxTags: 256,
      maxTagBytes: 65_536,
    },
    nip44: {
      encryptPeers: ["*"],
      decryptPeers: ["*"],
      maxPlaintextBytes: DEFAULT_NIP44_MAX_PLAINTEXT_BYTES,
      maxCiphertextBytes: DEFAULT_NIP44_MAX_CIPHERTEXT_BYTES,
    },
    blossom: {
      servers: (input.blossomServers ?? towerOrigins).map((server) => new URL(server).origin),
      methods: ["upload", "delete", "list"],
      maxObjectBytes: 25 * 1_024 * 1_024,
    },
    maxCallsPerMinute: DEFAULT_MAX_CALLS_PER_MINUTE,
  };
}
