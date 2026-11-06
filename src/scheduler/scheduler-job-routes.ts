import type { SchedulerApiDependencies } from "./scheduler-api";
import { RELAY_TRIGGER_UNSUPPORTED_REASON } from "./scheduler-store";
import { wrapEscrowUuid } from "./key-wrapper";
import { getSessionSecretBytes } from "../auth/session-secret";
import { AGENT_TYPES as VALID_AGENTS, AGENT_TYPE_LIST } from "../agent-types";
import { PathSchema } from "../utils/validation";
import { parseJsonBody, validateCronExpression, normaliseModel, parsePipelineInput, parseScheduledContext } from "./scheduler-api-input";

/** POST /api/scheduler/jobs */
export async function handleCreateJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  request: Request,
): Promise<Response> {
  const body = await parseJsonBody(request);

  // Validate required fields
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  const model = normaliseModel(body.model);
  const workingDirectory = typeof body.workingDirectory === "string" ? body.workingDirectory.trim() : "";
  const initialPrompt = typeof body.initialPrompt === "string" ? body.initialPrompt.trim() : "";
  const actionType = body.actionType === "pipeline"
    ? "pipeline" as const
    : body.actionType === "cleanup"
      ? "cleanup" as const
      : "session" as const;
  const pipelineDefinitionId = typeof body.pipelineDefinitionId === "string" ? body.pipelineDefinitionId.trim() : "";
  const pipelineInput = parsePipelineInput(body.pipelineInput ?? body.pipelineInputJson);
  if (body.triggerType === "nostr") {
    return Response.json({ error: RELAY_TRIGGER_UNSUPPORTED_REASON }, { status: 400 });
  }
  if (body.triggerType !== undefined && body.triggerType !== "cron" && body.triggerType !== "file_watcher") {
    return Response.json({ error: "triggerType must be cron or file_watcher" }, { status: 400 });
  }
  const triggerType = body.triggerType === "file_watcher" ? "file_watcher" as const : "cron" as const;
  const cronExpression = typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "UTC";
  const watchDirectory = typeof body.watchDirectory === "string" ? body.watchDirectory.trim() : "";
  const filePattern = typeof body.filePattern === "string" ? body.filePattern.trim() : "*";
  const activeStartTime = typeof body.activeStartTime === "string" ? body.activeStartTime.trim() : null;
  const activeEndTime = typeof body.activeEndTime === "string" ? body.activeEndTime.trim() : null;
  const pipelineAgent = typeof body.pipelineAgent === "string" ? body.pipelineAgent.trim() : "";
  const wappActivityInstallationId = typeof body.wappActivityInstallationId === "string"
    ? body.wappActivityInstallationId.trim()
    : "";
  const requestedBotNpub = typeof body.botNpub === "string" ? body.botNpub.trim() : "";

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (actionType === "pipeline") {
    if (!pipelineDefinitionId) return Response.json({ error: "pipelineDefinitionId is required" }, { status: 400 });
    if (!pipelineInput.ok) return Response.json({ error: pipelineInput.error }, { status: 400 });
    if (pipelineAgent && !VALID_AGENTS.includes(pipelineAgent as typeof VALID_AGENTS[number])) {
      return Response.json({ error: `pipelineAgent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
    }
  } else if (actionType === "session") {
    if (!VALID_AGENTS.includes(agent as typeof VALID_AGENTS[number])) {
      return Response.json({ error: `agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
    }
    if (!workingDirectory) return Response.json({ error: "workingDirectory is required" }, { status: 400 });
    const wdResult = PathSchema.safeParse(workingDirectory);
    if (!wdResult.success) {
      return Response.json({ error: wdResult.error.issues[0]?.message ?? "Invalid workingDirectory" }, { status: 400 });
    }
    if (!initialPrompt) return Response.json({ error: "initialPrompt is required" }, { status: 400 });
  } else if (triggerType !== "cron") {
    return Response.json({ error: "cleanup actions only support schedule triggers" }, { status: 400 });
  }

  // Validate active window times (HH:MM format)
  const timeRe = /^\d{2}:\d{2}$/;
  if (activeStartTime && !timeRe.test(activeStartTime)) {
    return Response.json({ error: "activeStartTime must be HH:MM format" }, { status: 400 });
  }
  if (activeEndTime && !timeRe.test(activeEndTime)) {
    return Response.json({ error: "activeEndTime must be HH:MM format" }, { status: 400 });
  }
  if ((activeStartTime && !activeEndTime) || (!activeStartTime && activeEndTime)) {
    return Response.json({ error: "Both activeStartTime and activeEndTime are required when setting an active window" }, { status: 400 });
  }

  if (triggerType === "cron") {
    if (!cronExpression) return Response.json({ error: "cronExpression is required for schedule triggers" }, { status: 400 });
    if (!validateCronExpression(cronExpression)) {
      return Response.json({ error: "Invalid cron expression" }, { status: 400 });
    }
  } else if (triggerType === "file_watcher") {
    if (!watchDirectory) return Response.json({ error: "watchDirectory is required for file watcher triggers" }, { status: 400 });
    const watchResult = PathSchema.safeParse(watchDirectory);
    if (!watchResult.success) {
      return Response.json({ error: watchResult.error.issues[0]?.message ?? "Invalid watchDirectory" }, { status: 400 });
    }
  }
  const botNpub = requestedBotNpub;
  if (!botNpub && actionType !== "cleanup") {
    return Response.json(
      { error: "Choose a Run as identity (botNpub is required)." },
      { status: 400 },
    );
  }
  if (actionType !== "cleanup" && requestedBotNpub && deps.getActiveBotOwnerNpub?.(requestedBotNpub) !== userNpub) {
    return Response.json({ error: "botNpub must be an active bot identity owned by the scheduler owner" }, { status: 400 });
  }

  const context = parseScheduledContext(body.flightdeckContext, actionType, userNpub, botNpub, deps);
  if (context instanceof Response) return context;

  const wrapped = actionType === "cleanup"
    ? { ciphertext: "", nonce: "" }
    : wrapEscrowUuid("wingman-instance", getSessionSecretBytes());

  const job = deps.store.createJob({
    name,
    userNpub,
    flightdeckContext: context,
    agentId: deps.getAgentIdForBotNpub?.(botNpub, userNpub) ?? null,
    botNpub: actionType === "cleanup" ? "" : botNpub,
    wrappedKeyCiphertext: wrapped.ciphertext,
    wrappedKeyNonce: wrapped.nonce,
    agent: actionType === "session" ? agent : "codex",
    model: actionType === "session" ? model : null,
    workingDirectory: actionType === "session" ? workingDirectory : "",
    initialPrompt: actionType === "session" ? initialPrompt : "",
    nightwatchmanEnabled: false,
    triggerType,
    cronExpression,
    timezone,
    watchDirectory: triggerType === "file_watcher" ? watchDirectory : undefined,
    filePattern: triggerType === "file_watcher" ? filePattern : undefined,
    activeStartTime: activeStartTime || undefined,
    activeEndTime: activeEndTime || undefined,
    actionType,
    pipelineDefinitionId: actionType === "pipeline" ? pipelineDefinitionId : null,
    pipelineInputJson: actionType === "pipeline" && pipelineInput.ok ? pipelineInput.json : null,
    pipelineAgent: actionType === "pipeline" ? (pipelineAgent || null) : null,
    wappActivityInstallationId: actionType === "session" ? (wappActivityInstallationId || null) : null,
    enabled: body.enabled === false ? false : true,
  });

  // Schedule it
  deps.engine.scheduleJob(job);

  return Response.json({ job }, { status: 201 });
}

/** PATCH /api/scheduler/jobs/:id */
export async function handleUpdateJob(
  deps: SchedulerApiDependencies,
  userNpub: string,
  jobId: string,
  request: Request,
): Promise<Response> {
  const existing = deps.store.getJob(jobId);
  if (!existing || (existing.userNpub !== userNpub && !deps.isAdmin?.())) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const body = await parseJsonBody(request);
  const update: Record<string, unknown> = {};

  if (typeof body.name === "string") update.name = body.name.trim();
  if ((body.actionType ?? existing.actionType) !== "cleanup" && body.botNpub !== undefined) {
    if (typeof body.botNpub !== "string") return Response.json({ error: "botNpub must be a string" }, { status: 400 });
    const botNpub = body.botNpub.trim();
    if (!botNpub) return Response.json({ error: "botNpub cannot be empty" }, { status: 400 });
    if (deps.getActiveBotOwnerNpub?.(botNpub) !== existing.userNpub) {
      return Response.json({ error: "botNpub must be an active bot identity owned by the scheduler owner" }, { status: 400 });
    }
    update.botNpub = botNpub;
    update.agentId = deps.getAgentIdForBotNpub?.(botNpub, existing.userNpub) ?? null;
  }
  if (body.actionType === "session" || body.actionType === "pipeline" || body.actionType === "cleanup") {
    update.actionType = body.actionType;
  }
  if (typeof body.pipelineDefinitionId === "string") {
    update.pipelineDefinitionId = body.pipelineDefinitionId.trim() || null;
  }
  if (body.pipelineInput !== undefined || body.pipelineInputJson !== undefined) {
    const pipelineInput = parsePipelineInput(body.pipelineInput ?? body.pipelineInputJson);
    if (!pipelineInput.ok) return Response.json({ error: pipelineInput.error }, { status: 400 });
    update.pipelineInputJson = pipelineInput.json;
  }
  if (typeof body.pipelineAgent === "string") {
    const pipelineAgent = body.pipelineAgent.trim();
    if (pipelineAgent) {
      if (!VALID_AGENTS.includes(pipelineAgent as typeof VALID_AGENTS[number])) {
        return Response.json({ error: `pipelineAgent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
      }
      update.pipelineAgent = pipelineAgent;
    } else {
      update.pipelineAgent = null;
    }
  }
  if (body.wappActivityInstallationId === null) {
    update.wappActivityInstallationId = null;
  } else if (typeof body.wappActivityInstallationId === "string") {
    update.wappActivityInstallationId = body.wappActivityInstallationId.trim() || null;
  }
  if (typeof body.agent === "string") {
    if (!VALID_AGENTS.includes(body.agent as typeof VALID_AGENTS[number])) {
      return Response.json({ error: `agent must be one of: ${AGENT_TYPE_LIST}` }, { status: 400 });
    }
    update.agent = body.agent;
  }
  if (body.model === null || typeof body.model === "string") {
    update.model = normaliseModel(body.model);
  }
  if (typeof body.workingDirectory === "string") {
    const wdResult = PathSchema.safeParse(body.workingDirectory.trim());
    if (!wdResult.success) {
      return Response.json({ error: wdResult.error.issues[0]?.message ?? "Invalid workingDirectory" }, { status: 400 });
    }
    update.workingDirectory = body.workingDirectory.trim();
  }
  if (typeof body.initialPrompt === "string") update.initialPrompt = body.initialPrompt.trim();
  if (body.nightwatchmanEnabled !== undefined) update.nightwatchmanEnabled = false;
  if (body.triggerType === "nostr") {
    return Response.json({ error: RELAY_TRIGGER_UNSUPPORTED_REASON }, { status: 400 });
  }
  if (body.triggerType !== undefined && body.triggerType !== "cron" && body.triggerType !== "file_watcher") {
    return Response.json({ error: "triggerType must be cron or file_watcher" }, { status: 400 });
  }
  if (body.triggerType === "cron" || body.triggerType === "file_watcher") {
    update.triggerType = body.triggerType;
  }
  if (typeof body.cronExpression === "string") {
    if (!validateCronExpression(body.cronExpression)) {
      return Response.json({ error: "Invalid cron expression" }, { status: 400 });
    }
    update.cronExpression = body.cronExpression.trim();
  }
  if (typeof body.timezone === "string") update.timezone = body.timezone.trim();
  if (typeof body.watchDirectory === "string") {
    const watchResult = PathSchema.safeParse(body.watchDirectory.trim());
    if (!watchResult.success) {
      return Response.json({ error: watchResult.error.issues[0]?.message ?? "Invalid watchDirectory" }, { status: 400 });
    }
    update.watchDirectory = body.watchDirectory.trim();
  }
  if (typeof body.filePattern === "string") update.filePattern = body.filePattern.trim();
  if (body.activeStartTime !== undefined) {
    if (body.activeStartTime === null || body.activeStartTime === "") {
      update.activeStartTime = null;
    } else if (typeof body.activeStartTime === "string") {
      const timeRe = /^\d{2}:\d{2}$/;
      if (!timeRe.test(body.activeStartTime.trim())) {
        return Response.json({ error: "activeStartTime must be HH:MM format" }, { status: 400 });
      }
      update.activeStartTime = body.activeStartTime.trim();
    }
  }
  if (body.activeEndTime !== undefined) {
    if (body.activeEndTime === null || body.activeEndTime === "") {
      update.activeEndTime = null;
    } else if (typeof body.activeEndTime === "string") {
      const timeRe = /^\d{2}:\d{2}$/;
      if (!timeRe.test(body.activeEndTime.trim())) {
        return Response.json({ error: "activeEndTime must be HH:MM format" }, { status: 400 });
      }
      update.activeEndTime = body.activeEndTime.trim();
    }
  }
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;

  const nextActionType = (update.actionType ?? existing.actionType) as string;
  const nextTriggerType = (update.triggerType ?? existing.triggerType) as string;
  if (nextActionType === "cleanup" && nextTriggerType !== "cron") {
    return Response.json({ error: "cleanup actions only support schedule triggers" }, { status: 400 });
  }

  if (nextActionType === "cleanup") {
    update.botNpub = "";
    update.agentId = null;
  } else if (!existing.botNpub && !update.botNpub) {
    return Response.json({ error: "Choose a Run as identity (botNpub is required)." }, { status: 400 });
  }

  if (body.flightdeckContext !== undefined || (existing.flightdeckContext
    && (body.botNpub !== undefined || body.actionType !== undefined || body.enabled === true))) {
    const context = parseScheduledContext(body.flightdeckContext === undefined ? existing.flightdeckContext : body.flightdeckContext,
      nextActionType, existing.userNpub, String(update.botNpub ?? existing.botNpub), deps);
    if (context instanceof Response) return context;
    update.flightdeckContext = context;
  }

  const job = deps.store.updateJob(jobId, update);
  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  // Reschedule or unschedule based on enabled state
  if (job.enabled) {
    deps.engine.scheduleJob(job);
  } else {
    deps.engine.unscheduleJob(job.id);
  }

  return Response.json({ job });
}

