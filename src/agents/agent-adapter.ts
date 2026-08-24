/**
 * AgentAdapter — abstracts the communication protocol between Wingman and an agent.
 *
 * AgentApiAdapter (agentapi HTTP proxy) remains the fallback for agents without
 * a native transport. OpenCodeAdapter and CodexAdapter use their SDKs directly.
 */

import type { AgentType } from "../config";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import type { AcpPermissionPolicy } from "./acp-permission-policy";
import { featureFlagStore, resolveFeatureFlagEffectiveState } from "../storage/feature-flag-store";

export type PromptReadinessState = "ready" | "starting" | "busy" | "unreachable";

export interface PromptReadiness {
  state: PromptReadinessState;
  reason: string;
  retryAfterMs: number;
  observedAt: number;
}

/** Minimal session context needed by adapters */
export interface AdapterSessionContext {
  id: string;
  port: number;
  agent: AgentType;
  host: string;
  pm2Name?: string;
  /** Working directory for the agent session (used by native SDK adapters) */
  workingDirectory?: string;
  /** Environment variables for the agent process (used by native SDK adapters) */
  env?: Record<string, string>;
  /** Optional model override selected for this session. */
  model?: string;
  /** ACP runtime permission behavior snapshotted when the session was created. */
  acpPermissionPolicy?: AcpPermissionPolicy;
  /** Codex thread ID for session resume (used by CodexAdapter) */
  codexThreadId?: string;
  /** Configured Codex CLI passed through to the Codex ACP adapter. */
  codexCli?: string;
  /** Configured Codex ACP executable path. */
  codexAcpCli?: string;
  /**
   * Structured Codex `--config` overrides (MCP servers, billing auth, etc.)
   * passed to `@openai/codex-sdk` since the native adapter spawns no CLI to
   * receive `-c` flags.
   */
  codexConfig?: Record<string, unknown>;
  /** OpenCode session ID for session resume (used by OpenCodeAdapter) */
  opencodeSdkSessionId?: string;
  /** Goose ACP session ID for session resume (used by GooseAdapter) */
  gooseSessionId?: string;
  /** Configured Goose executable path or PATH-resolved command. */
  gooseCli?: string;
  /** Configured Goose provider used when no session-specific override exists. */
  gooseProvider?: string;
  /** Pi ACP session ID for session resume. */
  piSessionId?: string;
  /** Configured Pi executable used by the Pi ACP bridge. */
  piCli?: string;
  /** Configured Pi ACP executable path. */
  piAcpCli?: string;
  /** OpenRouter credential injected into the Pi ACP subprocess without persisting it in session metadata. */
  piOpenRouterApiKey?: string;
  /** Absolute packaged Maple Desktop executable path. */
  mapleAcpCli?: string;
  /** Maple ACP session ID for native session resume. */
  mapleSessionId?: string;
  /** Called when an adapter discovers or creates the native agent session ID. */
  onNativeSessionId?: (sessionId: string) => void;
  /** Optional billing callback for native SDK adapters that bypass the proxy */
  recordUsage?: (data: {
    sessionId: string;
    endpoint: string;
    costUsd?: number | null;
    inputTokens?: number;
    outputTokens?: number;
  }) => Promise<void>;
}

export interface AgentAdapter {
  /** Get the agent's current runtime status */
  fetchStatus(timeoutMs?: number): Promise<AgentRuntimeStatus | null>;

  /** Get whether the agent can accept a new user prompt right now. */
  getPromptReadiness?(timeoutMs?: number): Promise<PromptReadiness>;

  /** Send a message to the agent. Throws on failure after retries. */
  sendMessage(content: string, type?: string): Promise<void>;

  /** Whether prompts must bypass AgentAPI and use this adapter directly. */
  deliversPromptsDirectly?(): boolean;

  /** Fetch conversation message history */
  fetchMessages(timeoutMs?: number): Promise<AgentMessage[]>;

  /** Return pending interactive permissions, when supported. */
  getPendingPermissions?(): AgentPermission[];

  /** Resolve a pending interactive permission, when supported. */
  respondToPermission?(permissionId: string, response: "once" | "always" | "reject"): Promise<boolean>;

  /** Interrupt the current turn when the adapter supports it */
  interruptCurrentTurn(): Promise<boolean>;

  /**
   * Get the URL for the agent's SSE event stream.
   * Returns null if the adapter handles streaming through a different mechanism.
   * Used by session-events.ts to proxy events to the browser.
   */
  getEventsUrl(): URL | null;

  /**
   * Subscribe to adapter-native message/status events when no upstream SSE URL exists.
   * Returns an unsubscribe function when supported.
   */
  subscribeToEvents?(
    listener: (event: AdapterStreamEvent) => void,
  ): (() => void) | null;

  /** Wait for agent to be ready to accept prompts */
  waitForReady(options?: AgentReadyOptions): Promise<void>;

  /** Clean up adapter-specific resources on session stop */
  dispose(): Promise<void>;
}

export type AdapterStreamEvent =
  | {
      type: "message";
      message: AgentMessage;
    }
  | {
      type: "status";
      status: AgentRuntimeStatus | null;
    }
  | {
      type: "permission";
      permission: AgentPermission;
    };

export interface AgentPermission {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  pattern?: string | string[];
  options?: AgentPermissionOption[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentPermissionOption {
  optionId: string;
  label: string;
  response: "once" | "always" | "reject";
}

export type AgentAdapterFactory = (context: AdapterSessionContext) => AgentAdapter;

export const CODEX_NATIVE_SDK_FLAG = "codex-use-native-sdk";
export const CODEX_ACP_FLAG = "codex-use-acp";
export const OPENCODE_NATIVE_SDK_FLAG = "opencode-use-native-sdk";
export const GOOSE_NATIVE_ACP_FLAG = "goose-use-native-acp";
export const PI_ACP_FLAG = "pi-use-acp";

export type AgentTransport = "agentapi" | "codex-acp" | "codex-sdk" | "goose-acp" | "maple-acp" | "opencode-sdk" | "pi-acp" | "pi-native";

/** Whether the native `@openai/codex-sdk` adapter is the active Codex transport. */
export function isCodexNativeSdkEnabled(): boolean {
  const flag = featureFlagStore.getFlag(CODEX_NATIVE_SDK_FLAG);
  return Boolean(flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on");
}

export function isCodexAcpEnabled(): boolean {
  const flag = featureFlagStore.getFlag(CODEX_ACP_FLAG);
  return Boolean(flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on");
}

export function isGooseNativeAcpEnabled(): boolean {
  const flag = featureFlagStore.getFlag(GOOSE_NATIVE_ACP_FLAG);
  return Boolean(flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on");
}

export function isPiAcpEnabled(): boolean {
  const flag = featureFlagStore.getFlag(PI_ACP_FLAG);
  return Boolean(flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on");
}

/**
 * Resolve transport only at a session creation or rehydration boundary. Codex
 * ACP intentionally wins when both Codex flags are on because it is the more
 * explicit transport opt-in. Callers persist the result on the session.
 */
export function resolveAgentTransport(agent: AgentType, pinned?: string | null): AgentTransport {
  if (isCompatibleTransport(agent, pinned)) return pinned;
  if (agent === "maple") return "maple-acp";
  if (agent === "codex") return resolveCodexTransport(isCodexAcpEnabled(), isCodexNativeSdkEnabled());
  if (agent === "opencode") {
    const flag = featureFlagStore.getFlag(OPENCODE_NATIVE_SDK_FLAG);
    if (flag && resolveFeatureFlagEffectiveState(flag.state, true) === "on") return "opencode-sdk";
  }
  if (agent === "goose" && isGooseNativeAcpEnabled()) return "goose-acp";
  if (agent === "pi") return resolvePiTransport(isPiAcpEnabled());
  return "agentapi";
}

export function resolveCodexTransport(acpEnabled: boolean, nativeSdkEnabled: boolean): AgentTransport {
  if (acpEnabled) return "codex-acp";
  if (nativeSdkEnabled) return "codex-sdk";
  return "agentapi";
}

export function resolvePiTransport(acpEnabled: boolean): AgentTransport {
  return acpEnabled ? "pi-acp" : "agentapi";
}

export function resolveAdapterFactory(agent: AgentType, transport = resolveAgentTransport(agent)): AgentAdapterFactory {
  if (transport === "pi-native") {
    return (context: AdapterSessionContext) => {
      const { PiAdapter } = require("./pi-adapter") as typeof import("./pi-adapter");
      return new PiAdapter(context);
    };
  }

  if (transport === "pi-acp") {
    return (context: AdapterSessionContext) => {
      const { PiAcpAdapter } = require("./pi-acp-adapter") as typeof import("./pi-acp-adapter");
      return new PiAcpAdapter(context);
    };
  }

  if (transport === "codex-acp") {
    return (context: AdapterSessionContext) => {
      const { CodexAcpAdapter } = require("./codex-acp-adapter") as typeof import("./codex-acp-adapter");
      return new CodexAcpAdapter(context);
    };
  }

  if (transport === "codex-sdk") {
    return (context: AdapterSessionContext) => {
      const { CodexAdapter } = require("./codex-adapter") as typeof import("./codex-adapter");
      return new CodexAdapter(context);
    };
  }

  if (transport === "opencode-sdk") {
    return (context: AdapterSessionContext) => {
      const { OpenCodeAdapter } = require("./opencode-adapter") as typeof import("./opencode-adapter");
      return new OpenCodeAdapter(context);
    };
  }

  if (transport === "goose-acp") {
    return (context: AdapterSessionContext) => {
      const { GooseAdapter } = require("./goose-adapter") as typeof import("./goose-adapter");
      return new GooseAdapter(context);
    };
  }

  if (transport === "maple-acp") {
    return (context: AdapterSessionContext) => {
      const { MapleAcpAdapter } = require("./maple-acp-adapter") as typeof import("./maple-acp-adapter");
      return new MapleAcpAdapter(context);
    };
  }

  // Default: all agents use agentapi
  return (context: AdapterSessionContext) => {
    const { AgentApiAdapter } = require("./agentapi-adapter") as typeof import("./agentapi-adapter");
    return new AgentApiAdapter(context);
  };
}

function isCompatibleTransport(agent: AgentType, value: string | null | undefined): value is AgentTransport {
  if (value === "agentapi") return true;
  if (agent === "codex") return value === "codex-acp" || value === "codex-sdk";
  if (agent === "goose") return value === "goose-acp";
  if (agent === "maple") return value === "maple-acp";
  if (agent === "opencode") return value === "opencode-sdk";
  if (agent === "pi") return value === "pi-acp" || value === "pi-native";
  return false;
}
