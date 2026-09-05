import { createHash } from "node:crypto";

import { finalizeEvent, nip19, verifyEvent } from "nostr-tools";

export interface WappPublishingGrantDestination {
  scope_id: string;
  available?: boolean;
  channel_id?: string;
  channel_ids?: string[];
  scope_label?: string | null;
  channel_labels?: Record<string, string>;
}

export interface WappPublishingGrant {
  grant_id: string;
  wapp_installation_id: string;
  publisher_npub: string;
  workspace_id: string;
  capabilities: string[];
  destinations: WappPublishingGrantDestination[];
  registered_open_origins: string[];
  grant_version: number;
  status: string;
}

export interface WappActivityProjection {
  external_id: string;
  version: number;
  scope_id: string;
  channel_id: string;
  category: string;
  title: string;
  summary: string;
  occurred_at: string;
  priority: "low" | "normal" | "high";
  state: "active" | "resolved" | "withdrawn";
  open_url?: string | null;
}

export function isWappDestinationGranted(grant: WappPublishingGrant, scopeId: string, channelId: string): boolean {
  return Array.isArray(grant.destinations) && grant.destinations.some((destination) => (
    destination && destination.available !== false && destination.scope_id === scopeId &&
    (destination.channel_id === channelId || (Array.isArray(destination.channel_ids) && destination.channel_ids.includes(channelId)))
  ));
}

export type WappPublishingErrorCategory = "retryable" | "refresh_grant" | "permanent";

export interface WappPublishingRouteAdapter {
  grantUrl(towerUrl: string, workspaceId: string): string;
  publicationUrl(towerUrl: string, workspaceId: string): string;
  classifyError(input: { status: number; code: string }): WappPublishingErrorCategory;
}

const REFRESH_GRANT_CODES = new Set([
  "publisher_not_registered",
  "stale_publisher_key",
  "publishing_grant_not_found",
  "publishing_grant_disabled",
  "publishing_grant_revoked",
]);

export const TowerWappActivityRoutes: WappPublishingRouteAdapter = {
  grantUrl(towerUrl, workspaceId) {
    return new URL(
      `/api/v4/wapp-activity/workspaces/${encodeURIComponent(workspaceId)}/grants/me`,
      towerUrl,
    ).toString();
  },
  publicationUrl(towerUrl, workspaceId) {
    return new URL(
      `/api/v4/wapp-activity/workspaces/${encodeURIComponent(workspaceId)}/items`,
      towerUrl,
    ).toString();
  },
  classifyError({ status, code }) {
    if (REFRESH_GRANT_CODES.has(code)) return "refresh_grant";
    if (code === "rate_limited" || [408, 425, 429].includes(status) || status >= 500) return "retryable";
    return "permanent";
  },
};

export interface WappPublishingClientOptions {
  towerUrl: string;
  workspaceId: string;
  wappInstallationId: string;
  publisherNpub: string;
  nsec: string;
  routes: WappPublishingRouteAdapter;
  fetchImpl?: WappPublishingFetch;
  refreshIntervalMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  refreshScheduler?: (refresh: () => void, intervalMs: number) => () => void;
}

export type WappPublishingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class WappPublishingError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly category: WappPublishingErrorCategory;

  constructor(input: { status?: number | null; code: string; category: WappPublishingErrorCategory }) {
    super(`Tower WApp publishing request failed (${input.status ?? "transport"}, ${input.code})`);
    this.name = "WappPublishingError";
    this.status = input.status ?? null;
    this.code = input.code;
    this.category = input.category;
  }
}

export function sha256Payload(serializedBody: string): string {
  return createHash("sha256").update(serializedBody, "utf8").digest("hex");
}

export function createWappNip98Authorization(input: {
  url: string;
  method: string;
  nsec: string;
  serializedBody?: string;
  createdAt?: number;
}): string {
  const decoded = nip19.decode(input.nsec.trim());
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("WAPP_NSEC must be a valid nsec value");
  }
  const tags: string[][] = [
    ["u", input.url],
    ["method", input.method.toUpperCase()],
  ];
  if (input.serializedBody !== undefined) {
    tags.push(["payload", sha256Payload(input.serializedBody)]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: "",
  }, decoded.data);
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

function errorCode(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const candidate = (payload as Record<string, unknown>).code ?? (payload as Record<string, unknown>).error;
    if (typeof candidate === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(candidate)) return candidate;
  }
  return `http_${status}`;
}

function grantFromPayload(payload: unknown): WappPublishingGrant | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const grant = root.grant && typeof root.grant === "object" ? root.grant : root;
  return grant as unknown as WappPublishingGrant;
}

function retryDelay(response: Response, attempt: number, baseMs: number): number {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 60_000);
  return Math.min(baseMs * (2 ** attempt), 30_000);
}

export class WappPublishingClient {
  readonly #options: WappPublishingClientOptions;
  private readonly fetchImpl: WappPublishingFetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly refreshScheduler: NonNullable<WappPublishingClientOptions["refreshScheduler"]>;
  private grant: WappPublishingGrant | null = null;
  private signedNpub: string | null = null;

  get signingNpub(): string | null {
    return this.signedNpub;
  }
  private grantEtag: string | null = null;
  private stopRefresh: (() => void) | null = null;

  constructor(options: WappPublishingClientOptions) {
    this.#options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.refreshScheduler = options.refreshScheduler ?? ((refresh, intervalMs) => {
      const timer = setInterval(refresh, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  }

  get cachedGrant(): Readonly<WappPublishingGrant> | null {
    return this.grant;
  }

  get cachedGrantEtag(): string | null {
    return this.grantEtag;
  }

  async start(): Promise<WappPublishingGrant> {
    const grant = await this.refreshGrant();
    if (!this.stopRefresh) {
      this.stopRefresh = this.refreshScheduler(() => {
        void this.refreshGrant().catch(() => undefined);
      }, this.#options.refreshIntervalMs ?? 300_000);
    }
    return grant;
  }

  stop(): void {
    this.stopRefresh?.();
    this.stopRefresh = null;
  }

  async refreshGrant(): Promise<WappPublishingGrant> {
    const url = this.#options.routes.grantUrl(this.#options.towerUrl, this.#options.workspaceId);
    const authorization = createWappNip98Authorization({
      url, method: "GET", nsec: this.#options.nsec,
      createdAt: Math.floor(this.now() / 1_000),
    });
    const event = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString("utf8"));
    if (!verifyEvent(event)) {
      throw new WappPublishingError({ code: "publisher_signature_invalid", category: "permanent" });
    }
    this.signedNpub = nip19.npubEncode(event.pubkey);
    if (this.signedNpub !== this.#options.publisherNpub) {
      throw new WappPublishingError({ code: "publisher_identity_mismatch", category: "permanent" });
    }
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        ...(this.grantEtag ? { "If-None-Match": this.grantEtag } : {}),
      },
    }).catch(() => {
      throw new WappPublishingError({ code: "transport_error", category: "retryable" });
    });
    if (response.status === 304 && this.grant) return this.grant;
    if (!response.ok) throw await this.responseError(response);
    const payload = await response.json().catch(() => null);
    const grant = grantFromPayload(payload);
    if (!grant || grant.wapp_installation_id !== this.#options.wappInstallationId || grant.publisher_npub !== this.#options.publisherNpub || grant.workspace_id !== this.#options.workspaceId) {
      throw new WappPublishingError({ status: response.status, code: "grant_identity_mismatch", category: "permanent" });
    }
    if (grant.status !== "active") {
      throw new WappPublishingError({ status: response.status, code: "grant_not_active", category: "permanent" });
    }
    this.grant = grant;
    this.grantEtag = response.headers.get("etag") ?? this.grantEtag;
    return grant;
  }

  async publish(projection: WappActivityProjection): Promise<unknown> {
    const grant = this.grant ?? await this.refreshGrant();
    if (grant.status !== "active" || !grant.capabilities.includes("activity.publish")) {
      throw new WappPublishingError({ code: "grant_not_active", category: "permanent" });
    }
    const destinationAllowed = isWappDestinationGranted(grant, projection.scope_id, projection.channel_id);
    if (!destinationAllowed) {
      throw new WappPublishingError({ code: "destination_not_granted", category: "permanent" });
    }
    const serializedBody = JSON.stringify(projection);
    const url = this.#options.routes.publicationUrl(this.#options.towerUrl, this.#options.workspaceId);
    const maxRetries = this.#options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: createWappNip98Authorization({
              url,
              method: "POST",
              nsec: this.#options.nsec,
              serializedBody,
              createdAt: Math.floor(this.now() / 1_000),
            }),
            "Content-Type": "application/json",
          },
          body: serializedBody,
        });
      } catch {
        if (attempt >= maxRetries) {
          throw new WappPublishingError({ code: "transport_error", category: "retryable" });
        }
        await this.sleep((this.#options.retryBaseMs ?? 250) * (2 ** attempt));
        continue;
      }
      if (response.ok) return await response.json().catch(() => null);
      const error = await this.responseError(response);
      if (error.category === "refresh_grant") {
        await this.refreshGrant();
        throw error;
      }
      if (error.category !== "retryable" || attempt >= maxRetries) throw error;
      await this.sleep(retryDelay(response, attempt, this.#options.retryBaseMs ?? 250));
    }
  }

  private async responseError(response: Response): Promise<WappPublishingError> {
    const payload = await response.json().catch(() => null);
    const code = errorCode(payload, response.status);
    return new WappPublishingError({
      status: response.status,
      code,
      category: this.#options.routes.classifyError({ status: response.status, code }),
    });
  }
}
