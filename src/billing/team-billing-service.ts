import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

import type { AgentType } from "../config";
import { getSessionSecretBytes } from "../auth/session-secret";
import { normaliseNpub } from "../identity/npub-utils";
import { instanceSettingsService } from "../settings/instance-settings-service";
import { decryptTeamProviderKey, encryptTeamProviderKey } from "./team-key-crypto";
import {
  teamBillingStore,
  type TeamBillingConfig,
  type TeamProviderKeyRecord,
  type UsageLedgerRecord,
} from "../storage/team-billing-store";

type MemberInput = { normalizedNpub: string; npub: string };

export interface TeamBillingServiceDependencies {
  listIdentityMembers: () => MemberInput[];
  serverPort: number;
  baseUrl: string;
  getOpenRouterApiKey?: () => string | null;
}

export interface BillingLaunchConfig {
  billingMode: "credits" | "subscription";
  env: Record<string, string>;
  commandArgs?: string[];
  /**
   * Structured Codex `--config` overrides mirroring `commandArgs`, for the
   * native Codex SDK adapter which has no spawned CLI to receive `-c` args.
   */
  codexConfig?: Record<string, unknown>;
  fallbackReason: string | null;
}

interface ProxyTokenPayload {
  sid: string;
  n: string;
  npub: string | null;
}

const TOKEN_PREFIX = "wmpt1";
const PROXY_AUDIENCE = "wingman-provider-proxy";
const OPENROUTER_PROVIDER = "openrouter";
const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";
const CREDITS_SUPPORTED_AGENTS = new Set<AgentType>(["codex", "claude", "goose"]);

const TOKEN_SIGNATURE_ALGO = "sha256";

const resolveCodexHomeForSession = (sessionId: string): string => {
  const safeSessionId = sessionId.trim().replace(/[^a-zA-Z0-9-]/g, "") || "session";
  return resolve(process.cwd(), "data", "codex-home", safeSessionId);
};

const toBase64Url = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
};

const microsFromUsd = (usd: number): number => {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.max(0, Math.round(usd * 1_000_000));
};

const usdFromMicros = (micros: number): number => {
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return micros / 1_000_000;
};

const bpsToMultiplier = (bps: number): number => 1 + (Math.max(0, bps) / 10_000);

const pickOpenRouterManagementKey = (): string | null => {
  const managed = instanceSettingsService.get("integrations.openrouter_management_key");
  if (managed) {
    return managed;
  }
  const candidates = [
    Bun.env.OPENROUTER_PROVISIONING_KEY,
    Bun.env.OPENROUTER_MANAGEMENT_KEY,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) {
      return value;
    }
  }
  return null;
};

const hasOpenRouterManagementKey = (): boolean => Boolean(pickOpenRouterManagementKey());

const pickOpenRouterRuntimeKey = (): string | null => {
  const managed = instanceSettingsService.get("integrations.openrouter_api_key");
  if (managed) {
    return managed;
  }
  const candidates = [
    Bun.env.OPENROUTER_TEAM_RUNTIME_KEY,
    Bun.env.OPENROUTER_BILLING_RUNTIME_KEY,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) {
      return value;
    }
  }
  return null;
};

const normalizeOpenRouterApiBase = (): string => {
  const raw = typeof Bun.env.OPENROUTER_API_BASE === "string" ? Bun.env.OPENROUTER_API_BASE.trim() : "";
  if (!raw) return OPENROUTER_DEFAULT_BASE;
  return raw.replace(/\/+$/, "");
};

const getLaunchBaseUrl = (deps: TeamBillingServiceDependencies): string => `http://localhost:${deps.serverPort}`;

function parseUsdCostFromUnknown(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input) && input >= 0) return input;
  if (typeof input === "string") {
    const parsed = Number.parseFloat(input.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

const COST_LIKE_KEYS = new Set([
  "cost",
  "total_cost",
  "estimated_cost",
  "prompt_cost",
  "completion_cost",
  "input_cost",
  "output_cost",
  "upstream_inference_cost",
  "upstream_inference_input_cost",
  "upstream_inference_output_cost",
]);

const COST_WRAPPER_KEYS = new Set(["usage", "response", "data", "result", "message"]);

function parseUsageCostRecord(record: Record<string, unknown>): number | null {
  const totalCandidates = [
    record.cost,
    record.total_cost,
    record.estimated_cost,
    record.upstream_inference_cost,
  ];
  for (const candidate of totalCandidates) {
    const parsed = parseUsdCostFromUnknown(candidate);
    if (parsed !== null) return parsed;
  }

  const inputCost = parseUsdCostFromUnknown(record.prompt_cost ?? record.input_cost ?? null);
  const outputCost = parseUsdCostFromUnknown(record.completion_cost ?? record.output_cost ?? null);
  if (inputCost !== null || outputCost !== null) {
    return (inputCost ?? 0) + (outputCost ?? 0);
  }
  return null;
}

function parseUsdCostDeep(value: unknown, depth = 0): number | null {
  if (!value || typeof value !== "object") return null;
  if (depth > 6) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseUsdCostDeep(item, depth + 1);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  const record = value as Record<string, unknown>;

  // Prefer direct or usage-based totals first to avoid partial fields.
  const direct = parseUsageCostRecord(record);
  if (direct !== null) return direct;

  const usage = record.usage;
  if (usage && typeof usage === "object") {
    const usageParsed = parseUsageCostRecord(usage as Record<string, unknown>);
    if (usageParsed !== null) return usageParsed;
  }

  // Traverse wrapper objects that often contain the real response payload.
  for (const key of COST_WRAPPER_KEYS) {
    const child = record[key];
    if (!child || typeof child !== "object") continue;
    const nested = parseUsdCostDeep(child, depth + 1);
    if (nested !== null) return nested;
  }

  // Fallback: scan all children for cost-like keys.
  for (const [key, child] of Object.entries(record)) {
    if (COST_LIKE_KEYS.has(key.toLowerCase())) {
      const parsed = parseUsdCostFromUnknown(child);
      if (parsed !== null) return parsed;
    }
    if (child && typeof child === "object") {
      const nested = parseUsdCostDeep(child, depth + 1);
      if (nested !== null) return nested;
    }
  }

  return null;
}

function parseUsdCostFromResponseBody(body: unknown): number | null {
  return parseUsdCostDeep(body, 0);
}

function parseUsdCostFromHeaders(headers: Headers): number | null {
  const candidates = [
    headers.get("x-openrouter-cost"),
    headers.get("x-openrouter-usage-cost"),
    headers.get("x-request-cost"),
  ];
  for (const candidate of candidates) {
    const parsed = parseUsdCostFromUnknown(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export class TeamBillingService {
  private readonly deps: TeamBillingServiceDependencies;
  private cachedProviderKey: { value: string; hash: string | null; cachedAt: number } | null = null;

  constructor(deps: TeamBillingServiceDependencies) {
    this.deps = deps;
  }

  private signToken(payloadBase64: string): string {
    const secret = getSessionSecretBytes();
    return createHmac(TOKEN_SIGNATURE_ALGO, secret).update(`${PROXY_AUDIENCE}.${payloadBase64}`).digest("base64url");
  }

  private readActiveProviderKeyRecord(): TeamProviderKeyRecord | null {
    return teamBillingStore.getActiveProviderKey(OPENROUTER_PROVIDER);
  }

  private decryptProviderKey(record: TeamProviderKeyRecord): string {
    return decryptTeamProviderKey({
      iv: record.iv,
      authTag: record.authTag,
      ciphertext: record.encryptedValue,
    });
  }

  private invalidateProviderKeyCache() {
    this.cachedProviderKey = null;
  }

  private getNormalizedMemberList(): MemberInput[] {
    const list = this.deps.listIdentityMembers();
    const dedup = new Map<string, string>();
    for (const item of list) {
      const normalized = normaliseNpub(item.normalizedNpub) ?? normaliseNpub(item.npub);
      if (!normalized) continue;
      dedup.set(normalized, item.npub);
    }
    return Array.from(dedup.entries()).map(([normalizedNpub, npub]) => ({ normalizedNpub, npub }));
  }

  syncTeamMembers(): number {
    const members = this.getNormalizedMemberList();
    for (const member of members) {
      teamBillingStore.upsertMember(member.normalizedNpub, member.npub);
    }
    return teamBillingStore.getMemberCount();
  }

  getBudgetSummary(config = teamBillingStore.getConfig()) {
    const memberCount = teamBillingStore.getMemberCount();
    const budgetUsdCents = config.baseAllocationUsdCents + (memberCount * config.perMemberUsdCents);
    return {
      memberCount,
      budgetUsdCents,
      budgetUsd: budgetUsdCents / 100,
      baseAllocationUsdCents: config.baseAllocationUsdCents,
      perMemberUsdCents: config.perMemberUsdCents,
      markupBps: config.markupBps,
      markupPercent: Number((config.markupBps / 100).toFixed(2)),
    };
  }

  getTeamConfigWithSummary() {
    const config = teamBillingStore.getConfig();
    const summary = this.getBudgetSummary(config);
    const providerKey = this.readActiveProviderKeyRecord();
    return {
      config,
      summary,
      hasProviderKey: Boolean(providerKey),
      providerKeyHash: providerKey?.keyHash ?? null,
      providerKeyUpdatedAt: providerKey?.updatedAt ?? null,
      creditsSupportedAgents: Array.from(CREDITS_SUPPORTED_AGENTS),
      hasManagementKeyConfigured: hasOpenRouterManagementKey(),
    };
  }

  isCreditsEnabled(): boolean {
    return teamBillingStore.getConfig().useCredits;
  }

  isCreditsSupportedAgent(agent: AgentType): boolean {
    return CREDITS_SUPPORTED_AGENTS.has(agent);
  }

  async canUseCreditsForAgent(agent: AgentType): Promise<boolean> {
    if (!this.isCreditsEnabled()) return false;
    if (!this.isCreditsSupportedAgent(agent)) return false;
    const key = await this.getProviderApiKey();
    return Boolean(key);
  }

  async primeProviderKeyCache(): Promise<boolean> {
    const value = await this.getProviderApiKey();
    return typeof value === "string" && value.length > 0;
  }

  async getProviderApiKey(): Promise<string | null> {
    if (this.cachedProviderKey?.value) {
      return this.cachedProviderKey.value;
    }
    const record = this.readActiveProviderKeyRecord();
    if (!record) return null;
    const value = this.decryptProviderKey(record);
    this.cachedProviderKey = {
      value,
      hash: record.keyHash ?? null,
      cachedAt: Date.now(),
    };
    return value;
  }

  private async provisionOpenRouterKey(limitUsd: number): Promise<{ key: string; hash: string | null }> {
    const managementKey = pickOpenRouterManagementKey();
    if (!managementKey) {
      throw new Error(
        "Missing OpenRouter management key. Set OPENROUTER_PROVISIONING_KEY or OPENROUTER_MANAGEMENT_KEY with /keys permissions.",
      );
    }
    const config = teamBillingStore.getConfig();
    const url = `${normalizeOpenRouterApiBase()}/keys`;
    const body = {
      name: `wingman-team-${config.teamUuid.slice(0, 12)}`,
      limit: Number(limitUsd.toFixed(2)),
      limit_reset: "monthly",
      include_byok_in_limit: true,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${managementKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new Error(
        `OpenRouter key creation failed (${response.status}). Ensure this key has /keys management access. Provider response: ${message.slice(0, 300)}`,
      );
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const data = payload?.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : payload;
    const keyCandidate = payload?.key ?? data?.key ?? data?.api_key ?? data?.value;
    const hashCandidate = payload?.hash ?? data?.hash ?? data?.key_hash ?? data?.id;
    const key = typeof keyCandidate === "string" ? keyCandidate.trim() : "";
    const hash = typeof hashCandidate === "string" ? hashCandidate.trim() : null;
    if (!key) {
      throw new Error("OpenRouter key creation succeeded but no key value was returned");
    }
    return { key, hash };
  }

  private async updateOpenRouterKeyLimit(hash: string, limitUsd: number): Promise<void> {
    const managementKey = pickOpenRouterManagementKey();
    if (!managementKey || !hash) return;
    const url = `${normalizeOpenRouterApiBase()}/keys/${encodeURIComponent(hash)}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${managementKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        limit: Number(limitUsd.toFixed(2)),
        limit_reset: "monthly",
        include_byok_in_limit: true,
      }),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      console.warn(`[billing] failed to update OpenRouter key limit (${response.status}): ${message.slice(0, 240)}`);
    }
  }

  async ensureProviderKeyForCredits(): Promise<void> {
    const config = teamBillingStore.getConfig();
    const budget = this.getBudgetSummary(config);
    const providerLimitUsd = budget.budgetUsd / bpsToMultiplier(config.markupBps);

    const existing = this.readActiveProviderKeyRecord();
    if (!existing) {
      try {
        const provisioned = await this.provisionOpenRouterKey(providerLimitUsd);
        const encrypted = encryptTeamProviderKey(provisioned.key);
        teamBillingStore.setActiveProviderKey({
          provider: OPENROUTER_PROVIDER,
          keyHash: provisioned.hash ?? null,
          encryptedValue: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
        });
        this.cachedProviderKey = {
          value: provisioned.key,
          hash: provisioned.hash ?? null,
          cachedAt: Date.now(),
        };
        return;
      } catch (error) {
        const runtimeKey = pickOpenRouterRuntimeKey();
        if (!runtimeKey) {
          throw error;
        }
        console.warn(
          `[billing] OpenRouter key provisioning failed; falling back to explicit billing runtime key: ${(error as Error).message}`,
        );
        const encrypted = encryptTeamProviderKey(runtimeKey);
        teamBillingStore.setActiveProviderKey({
          provider: OPENROUTER_PROVIDER,
          keyHash: null,
          encryptedValue: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
        });
        this.cachedProviderKey = {
          value: runtimeKey,
          hash: null,
          cachedAt: Date.now(),
        };
        return;
      }
    }

    // If current active key was from runtime fallback (no hash) and a management key
    // is now configured, rotate to a managed team key so limits can be controlled.
    if (!existing.keyHash && hasOpenRouterManagementKey()) {
      try {
        const provisioned = await this.provisionOpenRouterKey(providerLimitUsd);
        const encrypted = encryptTeamProviderKey(provisioned.key);
        teamBillingStore.setActiveProviderKey({
          provider: OPENROUTER_PROVIDER,
          keyHash: provisioned.hash ?? null,
          encryptedValue: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
        });
        this.cachedProviderKey = {
          value: provisioned.key,
          hash: provisioned.hash ?? null,
          cachedAt: Date.now(),
        };
        return;
      } catch (error) {
        console.warn(
          `[billing] Failed to rotate fallback runtime key to managed key: ${(error as Error).message}`,
        );
      }
    }

    const existingKey = this.decryptProviderKey(existing);
    this.cachedProviderKey = {
      value: existingKey,
      hash: existing.keyHash ?? null,
      cachedAt: Date.now(),
    };
    if (existing.keyHash) {
      await this.updateOpenRouterKeyLimit(existing.keyHash, providerLimitUsd);
    }
  }

  async setUseCredits(enabled: boolean): Promise<ReturnType<TeamBillingService["getTeamConfigWithSummary"]>> {
    this.syncTeamMembers();
    if (enabled) {
      await this.ensureProviderKeyForCredits();
    } else {
      this.invalidateProviderKeyCache();
    }
    teamBillingStore.updateConfig({ useCredits: enabled });
    return this.getTeamConfigWithSummary();
  }

  updateTeamConfig(
    patch: Partial<{
      externalTeamId: string | null;
      baseAllocationUsdCents: number;
      perMemberUsdCents: number;
      markupBps: number;
    }>,
  ): ReturnType<TeamBillingService["getTeamConfigWithSummary"]> {
    teamBillingStore.updateConfig(patch);
    return this.getTeamConfigWithSummary();
  }

  createSessionProxyToken(sessionId: string, npub: string | null): string {
    const payload: ProxyTokenPayload = {
      sid: sessionId,
      n: randomBytes(12).toString("base64url"),
      npub: npub ?? null,
    };
    const payloadString = JSON.stringify(payload);
    const encoded = toBase64Url(payloadString);
    const signature = this.signToken(encoded);
    return `${TOKEN_PREFIX}.${encoded}.${signature}`;
  }

  verifySessionProxyToken(token: string): ProxyTokenPayload | null {
    if (!token || typeof token !== "string") return null;
    const [prefix, payloadEncoded, signature] = token.split(".");
    if (!prefix || !payloadEncoded || !signature) return null;
    if (prefix !== TOKEN_PREFIX) return null;
    const expected = this.signToken(payloadEncoded);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    try {
      const decoded = fromBase64Url(payloadEncoded);
      const parsed = JSON.parse(decoded) as ProxyTokenPayload;
      if (!parsed || typeof parsed.sid !== "string" || !parsed.sid.trim()) {
        return null;
      }
      return {
        sid: parsed.sid.trim(),
        n: typeof parsed.n === "string" ? parsed.n : "",
        npub: typeof parsed.npub === "string" ? parsed.npub : null,
      };
    } catch {
      return null;
    }
  }

  async resolveLaunchConfig(input: {
    sessionId: string;
    agent: AgentType;
    npub: string | null;
  }): Promise<BillingLaunchConfig> {
    const config = teamBillingStore.getConfig();
    if (!config.useCredits) {
      if (input.agent === "goose") {
        const openRouterApiKey = this.deps.getOpenRouterApiKey?.()?.trim();
        if (openRouterApiKey) {
          return {
            billingMode: "subscription",
            env: {
              GOOSE_PROVIDER: OPENROUTER_PROVIDER,
              GOOSE_PROVIDER__API_KEY: openRouterApiKey,
              OPENROUTER_API_KEY: openRouterApiKey,
            },
            fallbackReason: "credits-disabled",
          };
        }
      }
      return {
        billingMode: "subscription",
        env: {},
        fallbackReason: "credits-disabled",
      };
    }
    const key = await this.getProviderApiKey();
    if (!key) {
      return {
        billingMode: "subscription",
        env: {},
        fallbackReason: "team-key-unavailable",
      };
    }
    if (!this.isCreditsSupportedAgent(input.agent)) {
      return {
        billingMode: "subscription",
        env: {},
        fallbackReason: `agent-${input.agent}-unsupported-for-credits`,
      };
    }

    const launchBaseUrl = getLaunchBaseUrl(this.deps);
    const proxyToken = this.createSessionProxyToken(input.sessionId, input.npub);

    if (input.agent === "codex") {
      return {
        billingMode: "credits",
        env: {
          OPENAI_BASE_URL: `${launchBaseUrl}/api/provider/openai`,
          OPENAI_API_KEY: proxyToken,
          CODEX_API_KEY: proxyToken,
          // Isolate Codex from persisted ChatGPT auth in ~/.codex for credits sessions.
          CODEX_HOME: resolveCodexHomeForSession(input.sessionId),
        },
        // Codex interactive mode can prefer persisted ChatGPT auth unless we
        // force API auth for this process.
        commandArgs: ["-c", 'forced_login_method="api"'],
        codexConfig: { forced_login_method: "api" },
        fallbackReason: null,
      };
    }
    if (input.agent === "claude") {
      return {
        billingMode: "credits",
        env: {
          ANTHROPIC_BASE_URL: `${launchBaseUrl}/api/provider/anthropic`,
          ANTHROPIC_API_KEY: proxyToken,
        },
        fallbackReason: null,
      };
    }
    if (input.agent === "goose") {
      return {
        billingMode: "credits",
        env: {
          GOOSE_PROVIDER: "openrouter",
          GOOSE_PROVIDER__API_KEY: proxyToken,
          GOOSE_PROVIDER__HOST: `${launchBaseUrl}/api/provider/openrouter`,
          OPENROUTER_HOST: `${launchBaseUrl}/api/provider/openrouter`,
          OPENROUTER_API_KEY: proxyToken,
        },
        fallbackReason: null,
      };
    }

    return {
      billingMode: "subscription",
      env: {},
      fallbackReason: `agent-${input.agent}-unsupported-for-credits`,
    };
  }

  async recordProxyUsage(input: {
    sessionId: string;
    npub: string | null;
    agent: string;
    endpoint: string;
    method: string;
    statusCode: number | null;
    providerRequestId?: string | null;
    costUsd?: number | null;
  }): Promise<UsageLedgerRecord> {
    const config = teamBillingStore.getConfig();
    const upstreamMicros = microsFromUsd(input.costUsd ?? 0);
    const wingmanMicros = Math.round(upstreamMicros * bpsToMultiplier(config.markupBps));
    return teamBillingStore.appendUsage({
      sessionId: input.sessionId,
      npub: input.npub,
      agent: input.agent,
      endpoint: input.endpoint,
      method: input.method,
      statusCode: input.statusCode,
      provider: OPENROUTER_PROVIDER,
      providerRequestId: input.providerRequestId ?? null,
      upstreamCostMicrosUsd: upstreamMicros,
      wingmanCostMicrosUsd: wingmanMicros,
    });
  }

  getRecentUsage(limit = 100): Array<UsageLedgerRecord & { upstreamCostUsd: number; wingmanCostUsd: number }> {
    return teamBillingStore.listRecentUsage(limit).map((entry) => ({
      ...entry,
      upstreamCostUsd: usdFromMicros(entry.upstreamCostMicrosUsd),
      wingmanCostUsd: usdFromMicros(entry.wingmanCostMicrosUsd),
    }));
  }

  parseProxyCost(headers: Headers, body: unknown): number {
    const fromHeaders = parseUsdCostFromHeaders(headers);
    if (fromHeaders !== null) return fromHeaders;
    const fromBody = parseUsdCostFromResponseBody(body);
    if (fromBody !== null) return fromBody;
    return 0;
  }

  resolveProviderApiKeyHash(): string | null {
    const cached = this.cachedProviderKey?.hash;
    if (cached) return cached;
    return this.readActiveProviderKeyRecord()?.keyHash ?? null;
  }
}
