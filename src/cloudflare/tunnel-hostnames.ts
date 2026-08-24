import { normalizeAppHostname } from "../apps/app-domain-registry";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const CATCH_ALL_SERVICE = "http_status:404";

export type CloudflareTunnelEnv = Record<string, string | undefined> & {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_TUNNEL_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
};

export interface CloudflareTunnelClientOptions {
  apiToken: string;
  accountId: string;
  tunnelId: string;
  zoneId: string;
  fetchImpl?: typeof fetch;
}

export interface CloudflareIngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
}

interface CloudflareTunnelConfiguration {
  ingress: CloudflareIngressRule[];
}

interface CloudflareApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
}

interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export interface TunnelHostnameResult {
  hostname: string;
  serviceUrl: string;
  tunnelId: string;
  cnameTarget: string;
  dnsRecordId: string | null;
}

export interface TunnelHostnameVerification {
  hostname: string;
  serviceUrl: string;
  tunnelId: string;
  cnameTarget: string;
  hasIngress: boolean;
  hasDnsRecord: boolean;
  dnsRecordId: string | null;
  ingressShadowed: boolean;
  shadowingHostname: string | null;
  httpHostHeaderOverridden: boolean;
  active: boolean;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: Array<{ code?: number; message?: string }>;

  constructor(message: string, status: number, errors: Array<{ code?: number; message?: string }> = []) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
  }
}

function readEnvString(env: CloudflareTunnelEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

export function createCloudflareTunnelClientFromEnv(
  env: CloudflareTunnelEnv = process.env,
): CloudflareTunnelClient | null {
  const apiToken = readEnvString(env, "CLOUDFLARE_API_TOKEN");
  const accountId = readEnvString(env, "CLOUDFLARE_ACCOUNT_ID");
  const tunnelId = readEnvString(env, "CLOUDFLARE_TUNNEL_ID");
  const zoneId = readEnvString(env, "CLOUDFLARE_ZONE_ID");
  if (!apiToken || !accountId || !tunnelId || !zoneId) {
    return null;
  }
  return new CloudflareTunnelClient({ apiToken, accountId, tunnelId, zoneId });
}

export class CloudflareTunnelClient {
  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly tunnelId: string;
  private readonly zoneId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudflareTunnelClientOptions) {
    this.apiToken = options.apiToken;
    this.accountId = options.accountId;
    this.tunnelId = options.tunnelId;
    this.zoneId = options.zoneId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getTunnelId(): string {
    return this.tunnelId;
  }

  getCnameTarget(): string {
    return `${this.tunnelId}.cfargotunnel.com`;
  }

  async upsertPublicHostname(input: {
    hostname: string;
    serviceUrl: string;
    tunnelId?: string | null;
  }): Promise<TunnelHostnameResult> {
    this.ensureTunnel(input.tunnelId);
    const hostname = this.normalizeHostname(input.hostname);
    const serviceUrl = this.normalizeServiceUrl(input.serviceUrl);
    const config = await this.getTunnelConfiguration();
    const ingress = upsertIngressRule(config.ingress, { hostname, serviceUrl });
    await this.putTunnelConfiguration({ ingress });
    const dnsRecord = await this.upsertDnsRecord(hostname);
    return {
      hostname,
      serviceUrl,
      tunnelId: this.tunnelId,
      cnameTarget: this.getCnameTarget(),
      dnsRecordId: dnsRecord?.id ?? null,
    };
  }

  async verifyPublicHostname(input: {
    hostname: string;
    serviceUrl: string;
    tunnelId?: string | null;
  }): Promise<TunnelHostnameVerification> {
    this.ensureTunnel(input.tunnelId);
    const hostname = this.normalizeHostname(input.hostname);
    const serviceUrl = this.normalizeServiceUrl(input.serviceUrl);
    const [config, dnsRecord] = await Promise.all([
      this.getTunnelConfiguration(),
      this.findDnsRecord(hostname),
    ]);
    const ingressRule = config.ingress.find((rule) => normalizeIngressHostname(rule.hostname) === hostname);
    const firstMatchingRule = config.ingress.find((rule) => ingressRuleMatchesHostname(rule, hostname));
    const hasIngress = ingressRule?.service === serviceUrl;
    const ingressShadowed = hasIngress && firstMatchingRule !== ingressRule;
    const shadowingHostname = ingressShadowed ? normalizeIngressHostname(firstMatchingRule?.hostname) : null;
    const httpHostHeader = ingressRule?.originRequest?.httpHostHeader;
    const httpHostHeaderOverridden = typeof httpHostHeader === "string" && httpHostHeader.trim().length > 0;
    const cnameTarget = this.getCnameTarget();
    const hasDnsRecord = dnsRecord?.type === "CNAME" &&
      dnsRecord.content.toLowerCase() === cnameTarget.toLowerCase() &&
      dnsRecord.proxied === true;

    return {
      hostname,
      serviceUrl,
      tunnelId: this.tunnelId,
      cnameTarget,
      hasIngress,
      hasDnsRecord,
      dnsRecordId: dnsRecord?.id ?? null,
      ingressShadowed,
      shadowingHostname,
      httpHostHeaderOverridden,
      active: hasIngress && hasDnsRecord && !ingressShadowed && !httpHostHeaderOverridden,
    };
  }

  async removePublicHostname(input: {
    hostname: string;
    tunnelId?: string | null;
    deleteDns?: boolean;
  }): Promise<{ hostname: string; removedIngress: boolean; removedDns: boolean }> {
    this.ensureTunnel(input.tunnelId);
    const hostname = this.normalizeHostname(input.hostname);
    const config = await this.getTunnelConfiguration();
    const nextIngress = config.ingress.filter((rule) => rule.hostname !== hostname);
    const removedIngress = nextIngress.length !== config.ingress.length;
    if (removedIngress) {
      await this.putTunnelConfiguration({ ingress: ensureCatchAllIngress(nextIngress) });
    }

    let removedDns = false;
    if (input.deleteDns) {
      const dnsRecord = await this.findDnsRecord(hostname);
      if (dnsRecord) {
        await this.request(`/zones/${this.zoneId}/dns_records/${dnsRecord.id}`, { method: "DELETE" });
        removedDns = true;
      }
    }

    return { hostname, removedIngress, removedDns };
  }

  private ensureTunnel(tunnelId: string | null | undefined): void {
    if (tunnelId && tunnelId !== this.tunnelId) {
      throw new Error(`Configured Cloudflare tunnel ${this.tunnelId} does not match requested tunnel ${tunnelId}`);
    }
  }

  private normalizeHostname(input: string): string {
    const hostname = normalizeAppHostname(input);
    if (!hostname) {
      throw new Error("A valid hostname is required");
    }
    return hostname;
  }

  private normalizeServiceUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("serviceUrl is required");
    }
    if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) {
      throw new Error("serviceUrl must be an http:// or https:// URL");
    }
    return trimmed;
  }

  private async getTunnelConfiguration(): Promise<CloudflareTunnelConfiguration> {
    const response = await this.request<CloudflareTunnelConfiguration | { config?: CloudflareTunnelConfiguration }>(
      `/accounts/${this.accountId}/cfd_tunnel/${this.tunnelId}/configurations`,
      { method: "GET" },
    );
    const result = response.result;
    const wrappedConfig = (result as { config?: CloudflareTunnelConfiguration }).config;
    const config = wrappedConfig ?? (result as CloudflareTunnelConfiguration);
    return { ingress: Array.isArray(config.ingress) ? config.ingress : [] };
  }

  private async putTunnelConfiguration(config: CloudflareTunnelConfiguration): Promise<void> {
    await this.request(`/accounts/${this.accountId}/cfd_tunnel/${this.tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
  }

  private async findDnsRecord(hostname: string): Promise<CloudflareDnsRecord | null> {
    const query = new URLSearchParams({ type: "CNAME", name: hostname });
    const response = await this.request<CloudflareDnsRecord[]>(
      `/zones/${this.zoneId}/dns_records?${query.toString()}`,
      { method: "GET" },
    );
    return response.result[0] ?? null;
  }

  private async upsertDnsRecord(hostname: string): Promise<CloudflareDnsRecord | null> {
    const existing = await this.findDnsRecord(hostname);
    const payload = {
      type: "CNAME",
      name: hostname,
      content: this.getCnameTarget(),
      proxied: true,
    };

    if (!existing) {
      const response = await this.request<CloudflareDnsRecord>(`/zones/${this.zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return response.result;
    }

    if (
      existing.content.toLowerCase() === payload.content.toLowerCase() &&
      existing.proxied === payload.proxied
    ) {
      return existing;
    }

    const response = await this.request<CloudflareDnsRecord>(`/zones/${this.zoneId}/dns_records/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return response.result;
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
  ): Promise<CloudflareApiEnvelope<T>> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiToken}`);
    headers.set("Content-Type", "application/json");

    const response = await this.fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
      ...init,
      headers,
    });
    const payload = await response.json().catch(() => null) as CloudflareApiEnvelope<T> | null;
    if (!response.ok || !payload?.success) {
      const errors = payload?.errors ?? [];
      const message = errors.map((error) => error.message).filter(Boolean).join("; ") ||
        `Cloudflare API request failed with status ${response.status}`;
      throw new CloudflareApiError(message, response.status, errors);
    }
    return payload;
  }
}

function upsertIngressRule(
  ingress: CloudflareIngressRule[],
  input: { hostname: string; serviceUrl: string },
): CloudflareIngressRule[] {
  const route: CloudflareIngressRule = {
    hostname: input.hostname,
    service: input.serviceUrl,
  };
  const ordered = ensureCatchAllIngress(ingress);
  const routed = ordered.filter((rule) => !isCatchAllRule(rule));
  const existingIndex = routed.findIndex(
    (rule) => normalizeIngressHostname(rule.hostname) === input.hostname,
  );
  const withoutHostname = routed.filter(
    (rule) => normalizeIngressHostname(rule.hostname) !== input.hostname,
  );
  const shadowingWildcardIndex = withoutHostname.findIndex(
    (rule) => isWildcardRule(rule) && ingressRuleMatchesHostname(rule, input.hostname),
  );
  const existingIsShadowed = existingIndex >= 0 && routed
    .slice(0, existingIndex)
    .some((rule) => ingressRuleMatchesHostname(rule, input.hostname));
  const insertionIndex = existingIsShadowed && shadowingWildcardIndex >= 0
    ? shadowingWildcardIndex
    : existingIndex >= 0
      ? Math.min(existingIndex, withoutHostname.length)
      : shadowingWildcardIndex >= 0
        ? shadowingWildcardIndex
        : withoutHostname.length;
  const nextRouted = [...withoutHostname];
  nextRouted.splice(insertionIndex, 0, route);
  return [...nextRouted, ordered[ordered.length - 1]!];
}

function ensureCatchAllIngress(ingress: CloudflareIngressRule[]): CloudflareIngressRule[] {
  const catchAll = ingress.find(isCatchAllRule) ?? { service: CATCH_ALL_SERVICE };
  return [...ingress.filter((rule) => !isCatchAllRule(rule)), catchAll];
}

function isCatchAllRule(rule: CloudflareIngressRule): boolean {
  return !rule.hostname;
}

function ingressRuleMatchesHostname(rule: CloudflareIngressRule, hostname: string): boolean {
  const ruleHostname = normalizeIngressHostname(rule.hostname);
  if (!ruleHostname) return true;
  if (ruleHostname === hostname) return true;
  if (!ruleHostname.startsWith("*.")) return false;
  const suffix = ruleHostname.slice(1);
  return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

function isWildcardRule(rule: CloudflareIngressRule): boolean {
  return normalizeIngressHostname(rule.hostname)?.startsWith("*.") ?? false;
}

function normalizeIngressHostname(hostname: string | undefined): string | null {
  const normalized = hostname?.trim().toLowerCase();
  return normalized || null;
}
