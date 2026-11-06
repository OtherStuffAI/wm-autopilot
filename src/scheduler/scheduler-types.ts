import type { ScheduledSessionContext } from "./session-context";

export type TriggerType = "cron" | "file_watcher";
export type ScheduledTriggerType = TriggerType | "unsupported";
export type SchedulerActionType = "session" | "pipeline" | "cleanup";

export const RELAY_TRIGGER_UNSUPPORTED_REASON =
  'Nostr relay scheduler triggers are unsupported and cannot initiate work.';

export interface ScheduledJob {
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
  nightwatchmanEnabled: boolean;
  triggerType: ScheduledTriggerType;
  persistedTriggerType: string;
  unsupportedReason: string | null;
  cronExpression: string;
  timezone: string;
  watchDirectory: string | null;
  filePattern: string;
  activeStartTime: string | null;
  activeEndTime: string | null;
  actionType: SchedulerActionType;
  pipelineDefinitionId: string | null;
  pipelineInputJson: string | null;
  pipelineAgent: string | null;
  wappActivityInstallationId: string | null;
  flightdeckContext?: ScheduledSessionContext | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  sessionId: string | null;
  pipelineRunId: string | null;
  startedAt: string;
  status: "started" | "launched" | "success" | "error";
  errorMessage: string | null;
}

export interface CreateJobInput {
  id?: string;
  name: string;
  userNpub: string;
  agentId?: string | null;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  model?: string | null;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled?: boolean;
  triggerType?: TriggerType;
  cronExpression?: string;
  timezone?: string;
  watchDirectory?: string;
  filePattern?: string;
  activeStartTime?: string;
  activeEndTime?: string;
  actionType?: SchedulerActionType;
  pipelineDefinitionId?: string | null;
  pipelineInputJson?: string | null;
  pipelineAgent?: string | null;
  wappActivityInstallationId?: string | null;
  flightdeckContext?: ScheduledSessionContext | null;
  enabled?: boolean;
}

export interface UpdateJobInput {
  name?: string;
  agentId?: string | null;
  botNpub?: string;
  agent?: string;
  model?: string | null;
  workingDirectory?: string;
  initialPrompt?: string;
  nightwatchmanEnabled?: boolean;
  triggerType?: TriggerType;
  cronExpression?: string;
  timezone?: string;
  watchDirectory?: string;
  filePattern?: string;
  activeStartTime?: string | null;
  activeEndTime?: string | null;
  actionType?: SchedulerActionType;
  pipelineDefinitionId?: string | null;
  pipelineInputJson?: string | null;
  pipelineAgent?: string | null;
  wappActivityInstallationId?: string | null;
  flightdeckContext?: ScheduledSessionContext | null;
  enabled?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

