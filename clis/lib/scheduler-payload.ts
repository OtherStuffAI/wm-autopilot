import type { ParsedOptions } from "./scheduler-options";

export function buildCreatePayload(options: ParsedOptions): Record<string, unknown> {
  const name = options.name?.trim();
  const agent = options.agent?.trim();
  const workingDirectory = options.workingDirectory?.trim();
  const initialPrompt = options.prompt?.trim();
  const actionType = options.actionType ?? 'session';

  if (actionType === "pipeline" && (options.agent !== undefined || options.model !== undefined || options.workingDirectory !== undefined || options.prompt !== undefined)) {
    throw new Error("Session agent/model/directory/prompt options require a session action");
  }
  if (actionType === "session" && (options.pipelineDefinitionId !== undefined || options.pipelineInput !== undefined || options.pipelineAgent !== undefined)) {
    throw new Error("Pipeline options require --action-type pipeline");
  }
  if (!name) throw new Error('create requires --name <name>');
  if (actionType === 'pipeline') {
    if (!options.pipelineDefinitionId) throw new Error('create requires --pipeline-definition-id <id> for pipeline jobs');
  } else {
    if (!agent) throw new Error('create requires --agent <agent>');
    if (!workingDirectory) throw new Error('create requires --working-directory <path>');
    if (!initialPrompt) throw new Error('create requires --prompt <text>');
  }

  const triggerType = options.triggerType ?? 'cron';
  if (triggerType === 'cron' && !options.cronExpression) {
    throw new Error('create requires --cron <expr> when --trigger-type cron');
  }
  if (triggerType === 'file_watcher' && !options.watchDirectory) {
    throw new Error('create requires --watch-directory <path> when --trigger-type file_watcher');
  }

  const payload: Record<string, unknown> = {
    name,
    actionType,
    triggerType,
  };
  if (options.botNpub) payload.botNpub = options.botNpub;
  if (options.flightdeckContext !== undefined) payload.flightdeckContext = options.flightdeckContext;

  if (actionType === 'pipeline') {
    payload.pipelineDefinitionId = options.pipelineDefinitionId;
    payload.pipelineInput = options.pipelineInput ?? {};
    if (options.pipelineAgent !== undefined) payload.pipelineAgent = options.pipelineAgent;
  } else {
    payload.agent = agent;
    if (options.model) payload.model = options.model;
    payload.workingDirectory = workingDirectory;
    payload.initialPrompt = initialPrompt;
  }

  if (options.cronExpression) payload.cronExpression = options.cronExpression;
  if (options.timezone) payload.timezone = options.timezone;
  if (options.watchDirectory) payload.watchDirectory = options.watchDirectory;
  if (options.filePattern) payload.filePattern = options.filePattern;
  if (options.activeStartTime) payload.activeStartTime = options.activeStartTime;
  if (options.activeEndTime) payload.activeEndTime = options.activeEndTime;
  if (options.enabled !== undefined) payload.enabled = options.enabled;

  return payload;
}

export function buildUpdatePayload(options: ParsedOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (options.flightdeckContext !== undefined) payload.flightdeckContext = options.flightdeckContext;
  if (options.name !== undefined) payload.name = options.name;
  if (options.botNpub !== undefined) payload.botNpub = options.botNpub;
  if (options.actionType !== undefined) payload.actionType = options.actionType;
  if (options.agent !== undefined) payload.agent = options.agent;
  if (options.model !== undefined) payload.model = options.model;
  if (options.workingDirectory !== undefined) payload.workingDirectory = options.workingDirectory;
  if (options.prompt !== undefined) payload.initialPrompt = options.prompt;
  if (options.pipelineDefinitionId !== undefined) payload.pipelineDefinitionId = options.pipelineDefinitionId;
  if (options.pipelineInput !== undefined) payload.pipelineInput = options.pipelineInput;
  if (options.pipelineAgent !== undefined) payload.pipelineAgent = options.pipelineAgent;
  if (options.triggerType !== undefined) payload.triggerType = options.triggerType;
  if (options.cronExpression !== undefined) payload.cronExpression = options.cronExpression;
  if (options.timezone !== undefined) payload.timezone = options.timezone;
  if (options.watchDirectory !== undefined) payload.watchDirectory = options.watchDirectory;
  if (options.filePattern !== undefined) payload.filePattern = options.filePattern;
  if (options.activeStartTime !== undefined) payload.activeStartTime = options.activeStartTime;
  if (options.activeEndTime !== undefined) payload.activeEndTime = options.activeEndTime;
  if (options.enabled !== undefined) payload.enabled = options.enabled;

  if (Object.keys(payload).length === 0) {
    throw new Error('update requires at least one field to change');
  }

  return payload;
}

