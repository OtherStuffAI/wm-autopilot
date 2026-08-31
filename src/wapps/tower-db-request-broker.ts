import { createHash, randomBytes } from "node:crypto";

import { createWappNip98Authorization, type WappPublishingFetch } from "./wapp-publishing-client";
import { wappStore, type WappStore } from "./wapp-store";

export const WAPP_TOWER_DB_BROKER_PATH = "/api/internal/wapps/tower-db";
export const WAPP_TOWER_DB_MAX_BODY_BYTES = 1_048_576;
export const WAPP_TOWER_DB_CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type AllowedMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface WappTowerDbBrokerRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface WappTowerDbRuntimeCapability {
  token: string;
  expiresAt: string;
}

interface CapabilityRecord {
  installationId: string;
  appId: string;
  ownerNpub: string;
  appNpub: string;
  towerBindingId: string;
  towerUrl: string;
  workspaceId: string | null;
  workspaceOwnerNpub: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

interface WappTowerDbRequestBrokerOptions {
  store?: WappStore;
  fetchImpl?: WappPublishingFetch;
  now?: () => number;
  capabilityTtlMs?: number;
  maxBodyBytes?: number;
}

export class WappTowerDbBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WappTowerDbBrokerError";
  }
}

function capabilityDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeTowerOrigin(towerUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(towerUrl);
  } catch {
    throw new WappTowerDbBrokerError("tower_binding_invalid", 409, "WApp Tower binding URL is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash
  ) {
    throw new WappTowerDbBrokerError("tower_binding_invalid", 409, "WApp Tower binding must contain only an HTTP origin");
  }
  return parsed.origin;
}

function validateListQuery(searchParams: URLSearchParams): void {
  const allowed = new Set(["limit", "offset", "order_by", "order_dir"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) {
      throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB query parameters are not allowed");
    }
  }
  for (const key of ["limit", "offset"] as const) {
    const value = searchParams.get(key);
    if (value === null) continue;
    if (!/^\d{1,9}$/.test(value)) {
      throw new WappTowerDbBrokerError("db_path_not_allowed", 403, `WApp Tower DB ${key} is invalid`);
    }
    const parsed = Number.parseInt(value, 10);
    if (key === "limit" && (parsed < 1 || parsed > 500)) {
      throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB limit must be between 1 and 500");
    }
  }
  const orderBy = searchParams.get("order_by");
  if (orderBy !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(orderBy)) {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB order_by is invalid");
  }
  const orderDir = searchParams.get("order_dir");
  if (orderDir !== null && orderDir !== "asc" && orderDir !== "desc") {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB order_dir is invalid");
  }
}

function validateRowId(encodedRowId: string): void {
  if (!/^(?:[A-Za-z0-9._~:-]|%[0-9A-Fa-f]{2}){1,768}$/.test(encodedRowId)) {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB row id is invalid");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedRowId);
  } catch {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB row id encoding is invalid");
  }
  if (
    decoded.length > 256
    || decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB row id is invalid");
  }
}

function normalizeAllowedPath(method: AllowedMethod, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB path is not allowed");
  }
  const queryIndex = path.indexOf("?");
  const rawPathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  let parsed: URL;
  try {
    parsed = new URL(path, "http://wapp-broker.invalid");
  } catch {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB path is invalid");
  }
  if (parsed.origin !== "http://wapp-broker.invalid" || parsed.pathname !== rawPathname) {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB path is not allowed");
  }

  let allowedMethods: readonly AllowedMethod[] | null = null;
  let allowsListQuery = false;
  if (rawPathname === "/provision") {
    allowedMethods = ["POST"];
  } else if (rawPathname === "/migrations") {
    allowedMethods = ["GET", "POST"];
  } else if (/^\/tables\/[A-Za-z_][A-Za-z0-9_]{0,62}\/query$/.test(rawPathname)) {
    allowedMethods = ["POST"];
  } else if (/^\/tables\/[A-Za-z_][A-Za-z0-9_]{0,62}\/rows$/.test(rawPathname)) {
    allowedMethods = ["GET", "POST"];
    allowsListQuery = method === "GET";
  } else {
    const rowMatch = rawPathname.match(/^\/tables\/[A-Za-z_][A-Za-z0-9_]{0,62}\/rows\/([^/]+)$/);
    if (rowMatch) {
      validateRowId(rowMatch[1]!);
      allowedMethods = ["GET", "PATCH", "DELETE"];
    }
  }
  if (!allowedMethods) {
    throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "WApp Tower DB path is not allowed");
  }
  if (!allowedMethods.includes(method)) {
    throw new WappTowerDbBrokerError("db_method_not_allowed", 405, "Method is not allowed for this WApp Tower DB path");
  }
  if (parsed.search) {
    if (!allowsListQuery) {
      throw new WappTowerDbBrokerError("db_path_not_allowed", 403, "Query parameters are not allowed for this WApp Tower DB path");
    }
    validateListQuery(parsed.searchParams);
  }
  return `${rawPathname}${parsed.search}`;
}

function serializeBody(input: WappTowerDbBrokerRequest, method: AllowedMethod, maxBodyBytes: number): string | undefined {
  const hasBody = Object.prototype.hasOwnProperty.call(input, "body");
  if (method === "GET" || method === "DELETE") {
    if (hasBody) {
      throw new WappTowerDbBrokerError("db_body_not_allowed", 400, `${method} WApp Tower DB requests cannot include a body`);
    }
    return undefined;
  }
  if (!hasBody) {
    throw new WappTowerDbBrokerError("db_body_required", 400, `${method} WApp Tower DB requests require a JSON body`);
  }
  const serialized = JSON.stringify(input.body);
  if (serialized === undefined) {
    throw new WappTowerDbBrokerError("db_body_invalid", 400, "WApp Tower DB body must be JSON serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBodyBytes) {
    throw new WappTowerDbBrokerError("db_body_too_large", 413, `WApp Tower DB body exceeds ${maxBodyBytes} bytes`);
  }
  return serialized;
}

export class WappTowerDbRequestBroker {
  private readonly store: WappStore;
  private readonly fetchImpl: WappPublishingFetch;
  private readonly now: () => number;
  private readonly capabilityTtlMs: number;
  private readonly maxBodyBytes: number;
  private readonly capabilities = new Map<string, CapabilityRecord>();

  constructor(options: WappTowerDbRequestBrokerOptions = {}) {
    this.store = options.store ?? wappStore;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.capabilityTtlMs = options.capabilityTtlMs ?? WAPP_TOWER_DB_CAPABILITY_TTL_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? WAPP_TOWER_DB_MAX_BODY_BYTES;
  }

  issue(input: { installationId: string; appId: string }): WappTowerDbRuntimeCapability {
    const wapp = this.store.get(input.installationId);
    if (
      !wapp
      || wapp.recordState !== "active"
      || wapp.status !== "active"
      || wapp.appId !== input.appId
      || !wapp.towerBindingId
      || !wapp.towerBinding
      || !wapp.appNpub
      || !this.store.hasAppSigningKey(wapp.id)
    ) {
      throw new WappTowerDbBrokerError("wapp_broker_binding_incomplete", 409, "Tower-backed WApp broker identity is incomplete");
    }
    normalizeTowerOrigin(wapp.towerBinding.towerUrl);
    const token = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.capabilityTtlMs;
    this.capabilities.set(capabilityDigest(token), {
      installationId: wapp.wappInstallationId,
      appId: wapp.appId,
      ownerNpub: wapp.ownerNpub,
      appNpub: wapp.appNpub,
      towerBindingId: wapp.towerBindingId,
      towerUrl: wapp.towerBinding.towerUrl,
      workspaceId: wapp.towerBinding.workspaceId,
      workspaceOwnerNpub: wapp.towerBinding.workspaceOwnerNpub,
      issuedAt,
      expiresAt,
      revokedAt: null,
    });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeToken(token: string): void {
    const capability = this.capabilities.get(capabilityDigest(token));
    if (capability && capability.revokedAt === null) capability.revokedAt = this.now();
  }

  revokeApp(appId: string): void {
    const revokedAt = this.now();
    for (const capability of this.capabilities.values()) {
      if (capability.appId === appId && capability.revokedAt === null) capability.revokedAt = revokedAt;
    }
  }

  async request(token: string, input: WappTowerDbBrokerRequest): Promise<Response> {
    const capability = this.capabilities.get(capabilityDigest(token));
    if (!capability) {
      throw new WappTowerDbBrokerError("capability_invalid", 401, "WApp Tower DB capability is invalid");
    }
    if (capability.revokedAt !== null) {
      throw new WappTowerDbBrokerError("capability_revoked", 401, "WApp Tower DB capability has been revoked");
    }
    if (capability.expiresAt <= this.now()) {
      throw new WappTowerDbBrokerError("capability_expired", 401, "WApp Tower DB capability has expired");
    }

    const wapp = this.store.get(capability.installationId);
    const binding = wapp?.towerBinding;
    if (!wapp || wapp.recordState !== "active" || wapp.status !== "active") {
      throw new WappTowerDbBrokerError("wapp_not_active", 409, "WApp installation is not active");
    }
    if (
      wapp.wappInstallationId !== capability.installationId
      || wapp.appId !== capability.appId
      || wapp.ownerNpub !== capability.ownerNpub
      || wapp.appNpub !== capability.appNpub
      || wapp.towerBindingId !== capability.towerBindingId
      || !binding
      || binding.towerUrl !== capability.towerUrl
      || binding.workspaceId !== capability.workspaceId
      || binding.workspaceOwnerNpub !== capability.workspaceOwnerNpub
    ) {
      throw new WappTowerDbBrokerError("wapp_identity_drift", 409, "WApp broker identity or Tower binding changed after process start");
    }
    if (!this.store.hasAppSigningKey(wapp.id)) {
      throw new WappTowerDbBrokerError("wapp_signing_key_missing", 409, "WApp broker signing identity is unavailable");
    }

    const method = input.method?.trim().toUpperCase() as AllowedMethod;
    if (!(["GET", "POST", "PATCH", "DELETE"] as const).includes(method)) {
      throw new WappTowerDbBrokerError("db_method_not_allowed", 405, "WApp Tower DB method is not allowed");
    }
    const path = normalizeAllowedPath(method, input.path?.trim() ?? "");
    const serializedBody = serializeBody(input, method, this.maxBodyBytes);
    const towerOrigin = normalizeTowerOrigin(binding.towerUrl);
    const targetPath = `/api/v4/workspaces/${encodeURIComponent(binding.workspaceOwnerNpub)}`
      + `/apps/${encodeURIComponent(wapp.appNpub)}/db${path}`;
    const targetUrl = new URL(targetPath, towerOrigin).toString();
    capability.expiresAt = this.now() + this.capabilityTtlMs;

    let response: Response;
    try {
      response = await this.store.withAppSigningKey(wapp.id, async (nsec) => {
        const authorization = createWappNip98Authorization({
          url: targetUrl,
          method,
          nsec,
          serializedBody,
        });
        return await this.fetchImpl(targetUrl, {
          method,
          redirect: "manual",
          headers: {
            Accept: "application/json",
            Authorization: authorization,
            ...(serializedBody === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: serializedBody,
        });
      });
    } catch (error) {
      if (error instanceof WappTowerDbBrokerError) throw error;
      throw new WappTowerDbBrokerError("tower_request_failed", 502, `Tower WApp DB request failed: ${(error as Error).message}`);
    }

    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export const wappTowerDbRequestBroker = new WappTowerDbRequestBroker();
