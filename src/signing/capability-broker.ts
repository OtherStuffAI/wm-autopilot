import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { finalizeEvent } from "nostr-tools";

import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord, BotKeyStore } from "../identity/bot-key-store";
import { BrokerKeyNotProvisionedError, type BrokerKeyVaultBackend } from "./broker-key-vault";
import { nip44Decrypt, nip44Encrypt } from "../nostr/nip44-crypto";
import { jsonError, parseBody } from "../utils/request-utils";

const TOKEN_PREFIX = "wmcap_v1";
export const SESSION_CAPABILITY_TTL_MS = 2 * 60 * 60_000;
const MAX_NONCES_PER_CAPABILITY = 2_048;
const DEFAULT_MAX_CALLS_PER_MINUTE = 120;
const NIP98_KIND = 27_235;
const BLOSSOM_AUTH_KIND = 24_242;
const FLIGHTDECK_PG_MESSAGE_INSTRUCTION_KIND = 33_358;
const SESSION_BINDING_TAG = "wm-session-capability";

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
    exactPaths?: Array<{ path: string; methods: string[]; requireBodyHash?: boolean }>;
    requireBodyHashMethods?: string[];
  }>;
}

export interface NostrConstraint {
  kinds: number[];
  maxContentBytes: number;
  maxTags: number;
  maxTagBytes?: number;
  allowedTagNames?: string[];
  requiredTags?: Array<[string, string]>;
}

export interface Nip44Constraint {
  encryptPeers: string[];
  decryptPeers: string[];
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
  botNpub: string;
  botPubkeyHex: string;
  profileId?: string | null;
  policy: SessionCapabilityPolicy;
  revokedAtMs: number | null;
  usedNonces: Set<string>;
  callTimestamps: number[];
  spentMsats: number;
}

export interface CapabilityBrokerDependencies {
  botKeyStore: Pick<BotKeyStore, "getActiveKeyForUser"> & Partial<Pick<BotKeyStore, "getActiveKeyForBotNpub">>;
  keyVault: Pick<BrokerKeyVaultBackend, "withKey">;
  getSession: (sessionId: string) => SessionSnapshot | null | undefined;
  wallet?: WalletBrokerAdapter;
  audit?: (entry: CapabilityAuditEntry) => void;
  now?: () => number;
  stateStore?: CapabilityBrokerStateStore;
}

export interface PersistedCapabilityRecord extends Omit<CapabilityRecord, "usedNonces"> {
  usedNonces: string[];
}

export interface CapabilityBrokerStateStore {
  load(): PersistedCapabilityRecord[];
  save(records: PersistedCapabilityRecord[]): void;
}

interface AuthorizedOperation {
  capability: CapabilityRecord;
  botRecord: BotKeyRecord;
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

export class CapabilityBroker {
  private readonly capabilitiesByHash = new Map<string, CapabilityRecord>();
  private readonly capabilitiesById = new Map<string, CapabilityRecord>();
  private readonly capabilityHashesBySession = new Map<string, Set<string>>();
  private readonly now: () => number;

  constructor(private readonly deps: CapabilityBrokerDependencies) {
    this.now = deps.now ?? Date.now;
    for (const persisted of deps.stateStore?.load() ?? []) {
      if (!persisted || persisted.revokedAtMs !== null) continue;
      const record: CapabilityRecord = {
        ...persisted,
        policy: clonePolicy(persisted.policy),
        usedNonces: new Set(persisted.usedNonces),
        callTimestamps: [...persisted.callTimestamps],
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
        callTimestamps: [...record.callTimestamps],
      }));
    this.deps.stateStore.save(records);
  }

  issueSessionCapability(input: {
    sessionId: string;
    ownerNpub: string;
    profileId?: string | null;
    botNpub?: string | null;
    policy: SessionCapabilityPolicy;
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
    const botRecord = selectedBotNpub
      ? this.deps.botKeyStore.getActiveKeyForBotNpub?.(selectedBotNpub) ?? null
      : this.deps.botKeyStore.getActiveKeyForUser(input.ownerNpub);
    if (!botRecord) {
      throw new Error("Session owner has no active bot identity");
    }
    if (botRecord.userNpub !== input.ownerNpub) {
      throw new Error("Selected agent identity is not managed by the session owner");
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
      botNpub: botRecord.botNpub,
      botPubkeyHex: botRecord.botPubkeyHex,
      profileId: input.profileId ?? boundProfileId,
      policy: clonePolicy(input.policy),
      revokedAtMs: null,
      usedNonces: new Set(),
      callTimestamps: [],
      spentMsats: 0,
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
    };
  }

  revokeSession(sessionId: string): number {
    const hashes = this.capabilityHashesBySession.get(sessionId);
    if (!hashes) return 0;
    let revoked = 0;
    for (const hash of hashes) {
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
    const botRecord = this.deps.botKeyStore.getActiveKeyForUser(session.npub);
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
    if (url.pathname === "/api/mcp/capabilities/refresh") return await this.handleRefresh(request);
    if (url.pathname === "/api/mcp/capabilities/nip98") return await this.handleNip98(request);
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
    if (capability.revokedAtMs !== null) return deny("Capability has been revoked");
    if (capability.expiresAtMs <= now && !options.allowExpired) return deny("Capability has expired");
    if (capability.sessionId !== sessionId) return deny("Capability is bound to a different session");
    if (!capability.policy.operations.includes(operation)) return deny("Capability does not allow this operation");
    const session = this.deps.getSession(sessionId);
    if (!session || session.status === "stopped" || session.status === "error") {
      return deny("Session is not active");
    }
    if (session.npub !== capability.ownerNpub) return deny("Session identity changed");
    const botRecord = this.deps.botKeyStore.getActiveKeyForBotNpub?.(capability.botNpub) ?? null;
    if (
      !botRecord
      || botRecord.userNpub !== capability.ownerNpub
      || botRecord.botNpub !== capability.botNpub
      || botRecord.botPubkeyHex !== capability.botPubkeyHex
    ) {
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
    return { capability, botRecord };
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
    } satisfies IssuedSessionCapability);
  }

  private async handleNip98(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authorized = await this.authorize(request, "nip98.sign", sessionId);
    if (authorized instanceof Response) return authorized;
    const targetUrl = typeof body.url === "string" ? body.url.trim() : "";
    const method = typeof body.method === "string" ? normalizeMethod(body.method) : "";
    const bodyHash = typeof body.bodyHash === "string" ? normalizeHex(body.bodyHash) : undefined;
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return this.denied(authorized.capability, "nip98.sign", "url must be an absolute URL", 400);
    }
    if (bodyHash && !isHex64(bodyHash)) {
      return this.denied(authorized.capability, "nip98.sign", "bodyHash must be a SHA-256 hex digest", 400);
    }
    const constraint = authorized.capability.policy.nip98;
    if (!constraint) return this.denied(authorized.capability, "nip98.sign", "NIP-98 policy is missing");
    const target = constraint.targets?.find((candidate) => candidate.origin === parsed.origin);
    const allowedOrigins = constraint.targets?.map((candidate) => candidate.origin) ?? constraint.origins;
    const allowedMethods = target?.methods ?? constraint.methods;
    const allowedPathPrefixes = target?.pathPrefixes ?? constraint.pathPrefixes;
    const exactPath = target?.exactPaths?.find((candidate) => candidate.path === parsed.pathname);
    const requireBodyHashMethods = target?.requireBodyHashMethods ?? constraint.requireBodyHashMethods;
    if (!allowedOrigins.includes(parsed.origin)) return this.denied(authorized.capability, "nip98.sign", "NIP-98 origin is not allowed");
    if (!allowedMethods.map(normalizeMethod).includes(method) || (exactPath && !exactPath.methods.map(normalizeMethod).includes(method))) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 method is not allowed");
    }
    if (!exactPath && !allowedPathPrefixes.some((prefix) => pathMatchesPrefix(parsed.pathname, prefix))) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 path is not allowed");
    }
    if (constraint.bodyHashes?.length && (!bodyHash || !constraint.bodyHashes.map(normalizeHex).includes(bodyHash))) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 body hash is not allowed");
    }
    if (exactPath?.requireBodyHash !== false && requireBodyHashMethods?.map(normalizeMethod).includes(method) && !bodyHash) {
      return this.denied(authorized.capability, "nip98.sign", "NIP-98 body hash is required for this method", 400);
    }
    const result = await this.withBotKey(authorized.botRecord, (secretKey) => {
      const createdAt = Math.floor(this.now() / 1000);
      const tags = [["u", parsed.toString()], ["method", method]];
      if (bodyHash) tags.push(["payload", bodyHash]);
      const bindingMac = this.createSessionBindingMac(authorized.capability, {
        pubkey: authorized.capability.botPubkeyHex,
        createdAt,
        url: parsed.toString(),
        method,
        bodyHash,
      });
      tags.push([SESSION_BINDING_TAG, authorized.capability.id, authorized.capability.sessionId, bindingMac]);
      const event = finalizeEvent({ kind: NIP98_KIND, content: "", tags, created_at: createdAt }, secretKey);
      return { token: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`, signedBy: authorized.capability.botNpub };
    });
    this.audit(authorized.capability, "nip98.sign", "allowed");
    return Response.json(result);
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
    if (!Number.isInteger(kind) || !constraint.kinds.includes(kind as number)) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event kind is not allowed");
    }
    if (typeof content !== "string" || Buffer.byteLength(content) > constraint.maxContentBytes) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event content exceeds policy", 400);
    }
    if (!Array.isArray(tags) || tags.length > constraint.maxTags || !tags.every((tag) => Array.isArray(tag) && tag.every((value) => typeof value === "string"))) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event tags exceed policy", 400);
    }
    const stringTags = tags as string[][];
    const tagBytes = stringTags.reduce((total, tag) => total + tag.reduce((size, value) => size + Buffer.byteLength(value), 0), 0);
    if (tagBytes > (constraint.maxTagBytes ?? 65_536)) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event tags exceed byte policy", 400);
    }
    if (constraint.allowedTagNames && stringTags.some((tag) => !constraint.allowedTagNames!.includes(tag[0] ?? ""))) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event tag is not allowed");
    }
    if (constraint.requiredTags?.some(([name, value]) => !stringTags.some((tag) => tag[0] === name && tag[1] === value))) {
      return this.denied(authorized.capability, "nostr.sign", "Nostr event is missing a required tag");
    }
    const signed = await this.withBotKey(authorized.botRecord, (secretKey) => finalizeEvent({
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
    if (plaintext === null || !isHex64(peer)) return this.denied(authorized.capability, "nip44.encrypt", "plaintext and recipientPubkey are required", 400);
    const constraint = authorized.capability.policy.nip44;
    if (!constraint || !peerAllowed(constraint.encryptPeers, peer)) return this.denied(authorized.capability, "nip44.encrypt", "NIP-44 recipient is not allowed");
    const ciphertext = await this.withBotKey(authorized.botRecord, (secretKey) => nip44Encrypt(plaintext, secretKey, peer));
    this.audit(authorized.capability, "nip44.encrypt", "allowed");
    return Response.json({ ciphertext, senderPubkey: authorized.capability.botPubkeyHex, senderNpub: authorized.capability.botNpub });
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
    try {
      const plaintext = await this.withBotKey(authorized.botRecord, (secretKey) => nip44Decrypt(ciphertext, secretKey, peer));
      this.audit(authorized.capability, "nip44.decrypt", "allowed");
      return Response.json({ plaintext, decryptedBy: authorized.capability.botPubkeyHex, decryptedByNpub: authorized.capability.botNpub });
    } catch {
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
    const event = await this.withBotKey(authorized.botRecord, (secretKey) => finalizeEvent({
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
            { path: "/api/system/restart", methods: ["POST"], requireBodyHash: false },
            { path: "/api/system/restart-and-resume", methods: ["POST"], requireBodyHash: false },
            { path: "/api/system/restart/status", methods: ["GET"] },
          ],
          requireBodyHashMethods: mutatingMethods,
        },
      ],
    },
    nostr: {
      kinds: [0, 1, 3, 4, 7, 10_002, 30_078, FLIGHTDECK_PG_MESSAGE_INSTRUCTION_KIND],
      maxContentBytes: 1_048_576,
      maxTags: 256,
      maxTagBytes: 65_536,
    },
    nip44: { encryptPeers: ["*"], decryptPeers: ["*"] },
    blossom: {
      servers: (input.blossomServers ?? towerOrigins).map((server) => new URL(server).origin),
      methods: ["upload", "delete", "list"],
      maxObjectBytes: 25 * 1_024 * 1_024,
    },
    maxCallsPerMinute: DEFAULT_MAX_CALLS_PER_MINUTE,
  };
}
