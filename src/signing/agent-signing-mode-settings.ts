import { type InstanceSettingsStore, instanceSettingsStore } from "../storage/instance-settings-store";
import {
  DEFAULT_AGENT_SIGNING_MODE,
  normalizeAgentSigningMode,
  type AgentSigningMode,
} from "./agent-signing-policy";

export const AGENT_SIGNING_MODE_SETTING_KEY = "agents.signing_mode";

export interface AgentSigningModeSnapshot {
  mode: AgentSigningMode;
  configured: boolean;
  updatedAt: string | null;
  source: string | null;
}

export class AgentSigningModeSettings {
  constructor(
    private readonly store: InstanceSettingsStore = instanceSettingsStore,
    private readonly fallbackMode: AgentSigningMode = DEFAULT_AGENT_SIGNING_MODE,
  ) {}

  getMode(): AgentSigningMode {
    const value = this.store.get(AGENT_SIGNING_MODE_SETTING_KEY);
    return value ? normalizeAgentSigningMode(value) : this.fallbackMode;
  }

  snapshot(): AgentSigningModeSnapshot {
    const record = this.store.getRecord(AGENT_SIGNING_MODE_SETTING_KEY);
    return {
      mode: record ? normalizeAgentSigningMode(record.value) : this.fallbackMode,
      configured: Boolean(record),
      updatedAt: record?.updatedAt ?? null,
      source: record?.source ?? null,
    };
  }

  setMode(mode: AgentSigningMode | string, actorNpub: string): AgentSigningModeSnapshot {
    const normalized = normalizeAgentSigningMode(mode);
    this.store.set({
      key: AGENT_SIGNING_MODE_SETTING_KEY,
      value: normalized,
      valueKind: "string",
      source: "app",
      sourceDetail: actorNpub,
    });
    return this.snapshot();
  }
}
