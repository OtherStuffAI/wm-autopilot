import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "wmsign_v1";
const TOKEN_AUDIENCE = "wingman-runner-signing";
const HMAC_ALGORITHM = "sha256";

export interface Nip98SigningCapability {
  hosts?: string[];
  methods?: string[];
  urls?: string[];
  pathPrefixes?: string[];
}

export interface NostrSigningCapability {
  kinds?: number[];
}

export interface SigningCapabilityTokenPayload {
  aud: typeof TOKEN_AUDIENCE;
  v: 1;
  exp: number;
  sessionId?: string;
  nip98?: Nip98SigningCapability;
  nostr?: NostrSigningCapability;
}

export interface SigningCapabilityTokenInput {
  ttlSeconds: number;
  sessionId?: string;
  nip98?: Nip98SigningCapability;
  nostr?: NostrSigningCapability;
}

export type SigningCapabilityVerification =
  | { ok: true; payload: SigningCapabilityTokenPayload }
  | { ok: false; reason: string };

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function signPayload(secret: string, payloadBase64: string): string {
  return createHmac(HMAC_ALGORITHM, secret)
    .update(`${TOKEN_PREFIX}.${payloadBase64}`)
    .digest("base64url");
}

function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function normaliseMethod(method: string): string {
  return method.trim().toUpperCase();
}

function normaliseHost(host: string): string {
  return host.trim().toLowerCase();
}

function hostMatches(pattern: string, host: string): boolean {
  const normalisedPattern = normaliseHost(pattern);
  const normalisedHost = normaliseHost(host);
  if (normalisedPattern === normalisedHost) {
    return true;
  }
  if (normalisedPattern.startsWith("*.")) {
    const suffix = normalisedPattern.slice(1);
    return normalisedHost.endsWith(suffix) && normalisedHost.length > suffix.length;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => Number.isInteger(entry));
}

function normaliseNip98Capability(value: unknown): Nip98SigningCapability | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    hosts: isStringArray(value.hosts) ? value.hosts.map(normaliseHost).filter(Boolean) : undefined,
    methods: isStringArray(value.methods) ? value.methods.map(normaliseMethod).filter(Boolean) : undefined,
    urls: isStringArray(value.urls) ? value.urls.filter(Boolean) : undefined,
    pathPrefixes: isStringArray(value.pathPrefixes) ? value.pathPrefixes.filter(Boolean) : undefined,
  };
}

function normaliseNostrCapability(value: unknown): NostrSigningCapability | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    kinds: isNumberArray(value.kinds) ? value.kinds : undefined,
  };
}

function normalisePayload(value: unknown): SigningCapabilityTokenPayload | null {
  if (!isRecord(value) || value.aud !== TOKEN_AUDIENCE || value.v !== 1 || typeof value.exp !== "number") {
    return null;
  }

  const payload: SigningCapabilityTokenPayload = {
    aud: TOKEN_AUDIENCE,
    v: 1,
    exp: value.exp,
  };
  if (typeof value.sessionId === "string" && value.sessionId.trim()) {
    payload.sessionId = value.sessionId.trim();
  }
  const nip98 = normaliseNip98Capability(value.nip98);
  if (nip98) {
    payload.nip98 = nip98;
  }
  const nostr = normaliseNostrCapability(value.nostr);
  if (nostr) {
    payload.nostr = nostr;
  }
  return payload;
}

export function mintSigningCapabilityToken(
  secret: string,
  input: SigningCapabilityTokenInput,
  nowMs = Date.now(),
): string {
  if (!secret.trim()) {
    throw new Error("Signing token secret is required");
  }
  if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be greater than zero");
  }

  const payload: SigningCapabilityTokenPayload = {
    aud: TOKEN_AUDIENCE,
    v: 1,
    exp: Math.floor(nowMs / 1000) + Math.floor(input.ttlSeconds),
  };
  if (input.sessionId?.trim()) {
    payload.sessionId = input.sessionId.trim();
  }
  if (input.nip98) {
    payload.nip98 = normaliseNip98Capability(input.nip98) ?? {};
  }
  if (input.nostr) {
    payload.nostr = normaliseNostrCapability(input.nostr) ?? {};
  }

  const payloadBase64 = encodeJson(payload);
  return `${TOKEN_PREFIX}.${payloadBase64}.${signPayload(secret, payloadBase64)}`;
}

export function verifySigningCapabilityToken(
  secret: string,
  token: string,
  nowMs = Date.now(),
): SigningCapabilityVerification {
  if (!secret.trim()) {
    return { ok: false, reason: "Signing token secret is not configured" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { ok: false, reason: "Invalid signing token format" };
  }

  const [, payloadBase64, signature] = parts;
  if (!payloadBase64 || !signature) {
    return { ok: false, reason: "Invalid signing token format" };
  }
  const expectedSignature = signPayload(secret, payloadBase64);
  if (!signaturesMatch(expectedSignature, signature)) {
    return { ok: false, reason: "Invalid signing token signature" };
  }

  const payload = normalisePayload(decodeJson<unknown>(payloadBase64));
  if (!payload) {
    return { ok: false, reason: "Invalid signing token payload" };
  }
  if (payload.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false, reason: "Signing token has expired" };
  }
  return { ok: true, payload };
}

export function assertTokenSessionAllowed(
  payload: SigningCapabilityTokenPayload,
  sessionId: string | undefined,
): string | null {
  if (!payload.sessionId) {
    return null;
  }
  if (!sessionId || payload.sessionId !== sessionId) {
    return "Signing token is not valid for this session";
  }
  return null;
}

export function assertNip98SigningAllowed(
  payload: SigningCapabilityTokenPayload,
  targetUrl: string,
  method: string,
): string | null {
  const capability = payload.nip98;
  if (!capability) {
    return "Signing token does not allow NIP-98 signing";
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return "url must be a valid absolute URL";
  }

  const methods = capability.methods?.map(normaliseMethod) ?? [];
  if (methods.length > 0 && !methods.includes("*") && !methods.includes(normaliseMethod(method))) {
    return "Signing token does not allow this HTTP method";
  }

  const exactUrls = capability.urls ?? [];
  if (exactUrls.includes(parsed.toString())) {
    return null;
  }

  const hosts = capability.hosts ?? [];
  const hostAllowed = hosts.some((host) => hostMatches(host, parsed.hostname));
  if (!hostAllowed) {
    return "Signing token does not allow this host";
  }

  const pathPrefixes = capability.pathPrefixes ?? [];
  if (pathPrefixes.length > 0 && !pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
    return "Signing token does not allow this URL path";
  }

  return null;
}

export function assertNostrSigningAllowed(
  payload: SigningCapabilityTokenPayload,
  kind: number,
): string | null {
  const capability = payload.nostr;
  if (!capability) {
    return "Signing token does not allow Nostr event signing";
  }
  if (!Number.isInteger(kind) || kind < 0) {
    return "event.kind must be a non-negative integer";
  }
  const kinds = capability.kinds ?? [];
  if (kinds.length > 0 && !kinds.includes(kind)) {
    return "Signing token does not allow this Nostr event kind";
  }
  return null;
}
