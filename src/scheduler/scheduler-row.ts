import { RELAY_TRIGGER_UNSUPPORTED_REASON, type ScheduledTriggerType, type SchedulerActionType, type ScheduledJob } from "./scheduler-types";

export interface RawJobRow {
  id: string;
  name: string;
  userNpub: string;
  agentId: string | null;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  model: string | null;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled: number;
  triggerType: string;
  cronExpression: string;
  timezone: string;
  watchDirectory: string | null;
  filePattern: string;
  activeStartTime: string | null;
  activeEndTime: string | null;
  actionType: string;
  pipelineDefinitionId: string | null;
  pipelineInputJson: string | null;
  pipelineAgent: string | null;
  wappActivityInstallationId: string | null;
  flightdeckContextJson: string | null;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function rowToJob(row: RawJobRow): ScheduledJob {
  const persistedTriggerType = row.triggerType || "cron";
  const triggerType: ScheduledTriggerType = persistedTriggerType === "cron" || persistedTriggerType === "file_watcher"
    ? persistedTriggerType
    : "unsupported";
  const unsupportedReason = triggerType === "unsupported"
    ? persistedTriggerType === "nostr"
      ? RELAY_TRIGGER_UNSUPPORTED_REASON
      : `Scheduler trigger type "${persistedTriggerType}" is unsupported and cannot initiate work.`
    : null;
  const { flightdeckContextJson, ...job } = row;
  return {
    ...job,
    flightdeckContext: flightdeckContextJson ? JSON.parse(flightdeckContextJson) : null,
    nightwatchmanEnabled: Boolean(row.nightwatchmanEnabled),
    triggerType,
    persistedTriggerType,
    unsupportedReason,
    actionType: (row.actionType || "session") as SchedulerActionType,
    filePattern: row.filePattern || "*",
    enabled: Boolean(row.enabled) && triggerType !== "unsupported",
  };
}


export const JOB_SELECT_COLS = `
  id, name,
  user_npub AS userNpub,
  agent_id AS agentId,
  bot_npub AS botNpub,
  wrapped_key_ciphertext AS wrappedKeyCiphertext,
  wrapped_key_nonce AS wrappedKeyNonce,
  agent, model, working_directory AS workingDirectory,
  initial_prompt AS initialPrompt,
  nightwatchman_enabled AS nightwatchmanEnabled,
  trigger_type AS triggerType,
  cron_expression AS cronExpression,
  timezone,
  watch_directory AS watchDirectory,
  file_pattern AS filePattern,
  active_start_time AS activeStartTime,
  active_end_time AS activeEndTime,
  action_type AS actionType,
  pipeline_definition_id AS pipelineDefinitionId,
  pipeline_input_json AS pipelineInputJson,
  pipeline_agent AS pipelineAgent,
  wapp_activity_installation_id AS wappActivityInstallationId,
  flightdeck_context_json AS flightdeckContextJson,
  enabled,
  last_run_at AS lastRunAt,
  next_run_at AS nextRunAt,
  created_at AS createdAt,
  updated_at AS updatedAt`;

