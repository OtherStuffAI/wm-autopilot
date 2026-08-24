import {
  CODEX_ACP_FLAG,
  CODEX_NATIVE_SDK_FLAG,
  GOOSE_NATIVE_ACP_FLAG,
  OPENCODE_NATIVE_SDK_FLAG,
  PI_ACP_FLAG,
} from "../agents/agent-adapter";
import { NIGHTWATCH_FEATURE_FLAG_KEY } from "../nightwatch/nightwatch-constants";
import type { CreateFeatureFlagInput, FeatureFlagRecord, FeatureFlagState } from "../storage/feature-flag-store";

export const PROJECTS_FLAG_KEY = "projects_visibility";
export const PIPELINE_AGENT_OUTPUT_FORMATTING_FLAG_KEY = "pipeline_agent_output_formatting";

export const MANAGED_FEATURE_FLAG_DEFAULTS: Array<CreateFeatureFlagInput & { state: FeatureFlagState }> = [
  {
    key: PROJECTS_FLAG_KEY,
    label: "Projects visibility",
    description: "Controls whether the Projects view is visible in the UI.",
    state: "on_admin",
  },
  {
    key: NIGHTWATCH_FEATURE_FLAG_KEY,
    label: "Night Watchman",
    description: "Autonomous agent review system that continues sessions overnight.",
    state: "off",
  },
  {
    key: "private_chats_enabled",
    label: "Private Chats",
    description: "Controls whether the Private Chats button is visible on the home screen.",
    state: "on",
  },
  {
    key: PIPELINE_AGENT_OUTPUT_FORMATTING_FLAG_KEY,
    label: "Agent output formatting",
    description: "Formats agent output in session and pipeline views to reduce terminal capture wrapping artifacts.",
    state: "off",
  },
  {
    key: CODEX_NATIVE_SDK_FLAG,
    label: "Codex Native SDK",
    description: "Use @openai/codex-sdk directly instead of agentapi for Codex sessions.",
    state: "off",
  },
  {
    key: CODEX_ACP_FLAG,
    label: "Codex ACP",
    description: "Use the Codex ACP adapter instead of AgentAPI. Takes precedence over the native SDK flag.",
    state: "off",
  },
  {
    key: OPENCODE_NATIVE_SDK_FLAG,
    label: "OpenCode Native SDK",
    description: "Use @opencode-ai/sdk directly instead of agentapi for OpenCode sessions.",
    state: "on",
  },
  {
    key: GOOSE_NATIVE_ACP_FLAG,
    label: "Goose Native ACP",
    description: "Use Goose ACP directly instead of AgentAPI, enabling native session resume.",
    state: "off",
  },
  {
    key: PI_ACP_FLAG,
    label: "Pi ACP",
    description: "Use Pi through the pi-acp bridge instead of AgentAPI for new sessions.",
    state: "off",
  },
];

interface ManagedFeatureFlagStore {
  ensureDefaults(defaults: CreateFeatureFlagInput[]): void;
  ensureDefaultState(key: string, state: FeatureFlagState): FeatureFlagRecord | null;
}

export function ensureManagedFeatureFlags(store: ManagedFeatureFlagStore): void {
  store.ensureDefaults(MANAGED_FEATURE_FLAG_DEFAULTS);
  store.ensureDefaultState(CODEX_NATIVE_SDK_FLAG, "off");
  store.ensureDefaultState(CODEX_ACP_FLAG, "off");
  store.ensureDefaultState(OPENCODE_NATIVE_SDK_FLAG, "on");
  store.ensureDefaultState(GOOSE_NATIVE_ACP_FLAG, "off");
  store.ensureDefaultState(PI_ACP_FLAG, "off");
}
