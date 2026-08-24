import type { AgentType } from "../config";

export interface AgentReadyOptions {
  timeoutMs?: number | null | undefined;
  pollIntervalMs?: number | null | undefined;
}

export interface AgentMessage {
  role: string;
  content: string;
  createdAt: string;
  /** Stable upstream message/part identity when the agent provides one. */
  messageId?: string;
  /** Stable ACP turn boundary identity when the transport can provide one. */
  turnId?: string;
  /** Deterministic transcript order supplied by turn-aware transports. */
  order?: number;
}

export interface AgentMessageOptions {
  attempts?: number | null | undefined;
  delayMs?: number | null | undefined;
  type?: string | null | undefined;
}

export interface AgentMessageFetchOptions {
  timeoutMs?: number | null | undefined;
}

const DEFAULT_AGENT_MESSAGE_TIMEOUT_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createTimeoutSignal = (timeoutMs: number): AbortSignal => {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
  return controller.signal;
};

export const parseAllowedHosts = (value: string): string[] => {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const pickAgentHost = (hosts: string[]): string => {
  // Prefer explicit IPv4 loopback first to avoid localhost resolving to ::1
  // when AgentAPI is only reachable over IPv4.
  if (hosts.includes("127.0.0.1")) {
    return "127.0.0.1";
  }
  const ipv4Hosts = hosts.filter((host) => /^\d+\.\d+\.\d+\.\d+$/.test(host));
  if (ipv4Hosts.length > 0) {
    return ipv4Hosts[0]!;
  }
  if (hosts.includes("localhost")) {
    return "localhost";
  }
  return "127.0.0.1";
};

export const normaliseHostForUrl = (host: string): string => host;

export const buildAgentUrl = (host: string, port: number, path: string): URL => {
  return new URL(path, `http://${host}:${port}/`);
};

export function matchesReadyAgentType(agent: AgentType, reportedAgentType: string): boolean {
  if (reportedAgentType === agent) {
    return true;
  }

  // Pi currently runs behind agentapi as a custom PTY command, so `/status`
  // reports `custom` even when the launched Wingman session is explicitly Pi.
  if (agent === "pi" && reportedAgentType === "custom") {
    return true;
  }

  return false;
}

export const waitForAgentReady = async (
  host: string,
  port: number,
  agent: AgentType,
  options?: AgentReadyOptions,
) => {
  const effectiveTimeout =
    typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : 30000;
  const interval =
    typeof options?.pollIntervalMs === "number" && options.pollIntervalMs > 0 ? options.pollIntervalMs : 250;
  const deadline = Date.now() + effectiveTimeout;
  const statusUrl = buildAgentUrl(host, port, "/status");

  while (Date.now() < deadline) {
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      const requestTimeoutMs = Math.min(remainingMs, Math.max(interval * 2, 1000));
      const response = await fetch(statusUrl, {
        signal: createTimeoutSignal(requestTimeoutMs),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
        const agentType = data && typeof data.agent_type === "string" ? data.agent_type.toLowerCase() : "";
        const status = data && typeof data.status === "string" ? data.status : "";
        if (matchesReadyAgentType(agent, agentType) && (status === "running" || status === "stable")) {
          return;
        }
      }
    } catch {
      // Ignore transient failures while waiting for the agent to boot.
    }
    await sleep(interval);
  }

  throw new Error(`Timed out waiting for ${agent} agent to become ready`);
};

export const sendAgentMessage = async (
  host: string,
  port: number,
  content: string,
  options?: AgentMessageOptions,
) => {
  const attempts = typeof options?.attempts === "number" && options.attempts > 0 ? options.attempts : 10;
  const delay = typeof options?.delayMs === "number" && options.delayMs >= 0 ? options.delayMs : 1000;
  const type = options?.type && options.type.trim().length > 0 ? options.type.trim() : "user";
  const url = buildAgentUrl(host, port, "/message");
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, content }),
      });
      if (!response.ok) {
        const message = await response
          .json()
          .then((payload) => {
            if (!payload || typeof payload !== "object") {
              return null;
            }
            const data = payload as Record<string, unknown>;
            const errorText = data.error;
            return typeof errorText === "string" && errorText.length > 0 ? errorText : null;
          })
          .catch(() => null);
        throw new Error(message ?? response.statusText ?? "Agent request failed");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delay);
      }
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Failed to deliver agent message: ${lastError.message}`);
  }
  throw new Error("Failed to deliver agent message");
};

export const normaliseAgentMessages = (items: unknown[]): AgentMessage[] => {
  const base = Date.now();
  return items
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const value = item as Record<string, unknown>;
      const role =
        typeof value.type === "string" && value.type.length > 0
          ? value.type
          : typeof value.role === "string" && value.role.length > 0
            ? value.role
            : "assistant";

      const contentRaw =
        typeof value.content === "string" && value.content.length > 0
          ? value.content
          : typeof value.message === "string" && value.message.length > 0
            ? value.message
            : "";

      if (!contentRaw) {
        return undefined;
      }

      const createdAtCandidate =
        typeof value.createdAt === "string"
          ? value.createdAt
          : typeof value.created_at === "string"
            ? value.created_at
            : typeof value.timestamp === "string"
              ? value.timestamp
              : undefined;

      const createdAt = createdAtCandidate ?? new Date(base + index).toISOString();

      return {
        role,
        content: contentRaw,
        createdAt,
      };
    })
    .filter((entry): entry is AgentMessage => Boolean(entry));
};

export const fetchAgentMessages = async (
  host: string,
  port: number,
  options?: AgentMessageFetchOptions,
): Promise<AgentMessage[]> => {
  const url = buildAgentUrl(host, port, "/messages");
  const timeoutMs = typeof options?.timeoutMs === "number" && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_AGENT_MESSAGE_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url, { signal: createTimeoutSignal(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new Error(`Agent messages request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(response.statusText || "Agent request failed");
  }
  const payload = await response.json().catch(() => null);
  const items = Array.isArray(payload)
    ? (payload as unknown[])
    : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).messages)
      ? ((payload as Record<string, unknown>).messages as unknown[])
      : [];
  return normaliseAgentMessages(items);
};
