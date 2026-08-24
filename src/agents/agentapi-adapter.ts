/**
 * AgentApiAdapter — communicates with agents via the agentapi HTTP proxy.
 *
 * Wraps the existing agent-client.ts helper functions behind the AgentAdapter
 * interface. This is the default adapter for all agents (Claude, Codex,
 * OpenCode, Goose, Gemini) and will remain the adapter for agents that don't
 * have a native SDK (Claude, Goose, Gemini).
 */

import type { AgentAdapter, AdapterSessionContext, PromptReadiness } from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import { isAgentRuntimeStatus } from "../types/agent-status";
import {
  buildAgentUrl,
  fetchAgentMessages,
  matchesReadyAgentType,
  sendAgentMessage,
  waitForAgentReady,
  type AgentMessage,
  type AgentReadyOptions,
} from "./agent-client";

export class AgentApiAdapter implements AgentAdapter {
  private readonly host: string;
  private readonly port: number;
  private readonly agent: string;
  private statusInFlight: Promise<AgentRuntimeStatus | null> | null = null;
  private lastStatus: { value: AgentRuntimeStatus | null; observedAt: number } | null = null;
  private agentTypeValidated = false;

  constructor(private readonly context: AdapterSessionContext) {
    this.host = context.host;
    this.port = context.port;
    this.agent = context.agent;
  }

  async fetchStatus(timeoutMs = 5000): Promise<AgentRuntimeStatus | null> {
    if (this.lastStatus && Date.now() - this.lastStatus.observedAt < 500) {
      return this.lastStatus.value;
    }
    if (this.statusInFlight) return this.statusInFlight;

    const request = this.fetchStatusUncached(timeoutMs).then((value) => {
      this.lastStatus = { value, observedAt: Date.now() };
      return value;
    }).finally(() => {
      this.statusInFlight = null;
    });
    this.statusInFlight = request;
    return request;
  }

  private async fetchStatusUncached(timeoutMs: number): Promise<AgentRuntimeStatus | null> {
    const url = buildAgentUrl(this.host, this.port, "/status");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`status request failed (${response.status})`);
      }
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const data = payload as Record<string, unknown>;
      const reportedAgentType = typeof data.agent_type === "string" ? data.agent_type.toLowerCase() : "";
      if (reportedAgentType && !matchesReadyAgentType(this.context.agent, reportedAgentType)) {
        throw new Error(
          `agentapi type mismatch: expected ${this.context.agent}, got ${reportedAgentType}`,
        );
      }
      if (reportedAgentType) this.agentTypeValidated = true;
      return isAgentRuntimeStatus(data.status) ? data.status : null;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("status request timed out");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getPromptReadiness(timeoutMs = 5000): Promise<PromptReadiness> {
    try {
      const status = await this.fetchStatus(timeoutMs);
      if (status === "stable") {
        return {
          state: "ready",
          reason: "agentapi-status-stable",
          retryAfterMs: 250,
          observedAt: Date.now(),
        };
      }
      if (status === "running") {
        return {
          state: "busy",
          reason: "agentapi-status-running",
          retryAfterMs: 1000,
          observedAt: Date.now(),
        };
      }
      return {
        state: "unreachable",
        reason: "agentapi-status-unavailable",
        retryAfterMs: 5000,
        observedAt: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        state: "unreachable",
        reason: `agentapi-status-error: ${message}`,
        retryAfterMs: 5000,
        observedAt: Date.now(),
      };
    }
  }

  async sendMessage(content: string, type = "user"): Promise<void> {
    await this.waitForReady({
      timeoutMs: 8000,
      pollIntervalMs: 250,
    });
    await sendAgentMessage(this.host, this.port, content, { type });
  }

  async fetchMessages(timeoutMs = 3000): Promise<AgentMessage[]> {
    if (!this.agentTypeValidated) {
      await this.fetchStatus(Math.min(timeoutMs, 1000));
    }
    return fetchAgentMessages(this.host, this.port, { timeoutMs });
  }

  async interruptCurrentTurn(): Promise<boolean> {
    return false;
  }

  getEventsUrl(): URL | null {
    return buildAgentUrl(this.host, this.port, "/events");
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    await waitForAgentReady(
      this.host,
      this.port,
      this.agent as any,
      options,
    );
  }

  async dispose(): Promise<void> {
    // AgentApiAdapter has no resources to clean up — the agentapi process
    // is managed by ProcessManager directly.
  }
}
