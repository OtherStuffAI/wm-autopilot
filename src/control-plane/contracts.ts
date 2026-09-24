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

export interface AutopilotConnectManifestV2 {
  kind: "wingman_autopilot_connect";
  version: 2;
  generated_at: string;
  installation: { id: string; npub: string };
  transport: { fips: { npub: string } };
  endpoints: { fips: string; https: string | null };
  api: AutopilotConnectManifestV1["api"];
}

export interface AutopilotConnectPackageV1 {
  manifest: AutopilotConnectManifestV1;
  signature: Event;
}

export interface AutopilotConnectPackageV2 {
  manifest: AutopilotConnectManifestV2;
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
  paths: {
    overview: string;
    pipelines: string;
    schedules: string;
    triggers: string;
  };
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

export interface PipelineDefinitionSummaryV1 {
  pipeline_definition_id: string;
  name: string;
  description: string;
  scope: "shared" | "user";
  version: string | number | null;
  tags: string[];
}

export interface AgentPipelineOverrideV1 {
  kind: "workspace" | "scope" | "channel";
  context_id: string;
  pipeline_definition_id: string;
}

export interface AgentPipelinesV1 {
  installation_id: string;
  agent_id: string;
  bot_npub: string;
  availability_mode: "implicit_all" | "explicit";
  default_mode: "implicit_library" | "explicit";
  available_definitions: PipelineDefinitionSummaryV1[];
  assignments: Array<{ pipeline_definition_id: string }>;
  defaults: Array<{ pipeline_definition_id: string }>;
  overrides: AgentPipelineOverrideV1[];
  missing_definition_ids: string[];
}

export interface AgentScheduleItemV1 {
  schedule_id: string;
  agent_id: string;
  bot_npub: string;
  name: string;
  enabled: boolean;
  cron_expression: string;
  timezone: string;
  active_start_time: string | null;
  active_end_time: string | null;
  action_type: "session" | "pipeline" | "cleanup";
  pipeline_definition_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
}

export interface AgentTriggerItemV1 {
  trigger_id: string;
  agent_id: string;
  bot_npub: string;
  name: string;
  enabled: boolean;
  trigger_type: "file_watcher" | "unsupported";
  file_pattern: string;
  action_type: "session" | "pipeline" | "cleanup";
  pipeline_definition_id: string | null;
  last_run_at: string | null;
}

export interface AgentSchedulesV1 {
  installation_id: string;
  agent_id: string;
  bot_npub: string;
  schedules: AgentScheduleItemV1[];
}

export interface AgentTriggersV1 {
  installation_id: string;
  agent_id: string;
  bot_npub: string;
  triggers: AgentTriggerItemV1[];
}
