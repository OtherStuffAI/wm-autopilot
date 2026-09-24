import type { Event } from "nostr-tools";

export interface AutopilotConnectManifestV1 {
  kind: "wingman_autopilot_connect";
  version: 1;
  generated_at: string;
  installation: { id: string; npub: string };
  endpoints: { fips: string; https: string | null };
  api: {
    version: 1;
    capabilities: string[];
    health_path: string;
    agents_path: string;
  };
}

export interface AutopilotConnectPackageV1 {
  manifest: AutopilotConnectManifestV1;
  signature: Event;
}

export interface InstallationHealthV1 {
  ok: boolean;
  installation_id: string;
  installation_npub: string;
  api_version: 1;
}

export interface AgentDiscoveryItemV1 {
  agent_id: string;
  bot_npub: string;
  name: string;
  description: string;
  can_instruct: boolean;
}

export interface AgentDiscoveryV1 {
  installation_id: string;
  agents: AgentDiscoveryItemV1[];
}

export interface AgentOverviewV1 {
  installation_id: string;
  agent: AgentDiscoveryItemV1 & {
    picture: string | null;
    nip05: string | null;
    capabilities: string[];
    enabled: boolean;
    archived: boolean;
  };
}
