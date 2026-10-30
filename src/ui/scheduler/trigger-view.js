/**
 * Pure view helpers for the trigger list and form: validation, plain-language
 * summaries and list filtering. No DOM, Alpine or network access.
 */

import { describeCron, describeSchedule, isValidTimezone } from "./schedule-helpers.js";

export const STATUS_FILTERS = Object.freeze([
  ["all", "All statuses"],
  ["enabled", "Enabled"],
  ["disabled", "Disabled"],
  ["unsupported", "Unsupported"],
]);

export const TYPE_FILTERS = Object.freeze([
  ["all", "All trigger types"],
  ["cron", "Schedule"],
  ["file_watcher", "File watcher"],
]);

/** Field keys in on-screen order, used to focus the first invalid field. */
export const FIELD_ORDER = Object.freeze([
  "name", "triggerType", "timezone", "watchDirectory", "actionType",
  "pipelineDefinitionId", "pipelineInput", "workingDirectory", "initialPrompt",
  "botNpub", "activeWindow",
]);

export const FIELD_LABELS = Object.freeze({
  name: "Name", timezone: "Timezone", watchDirectory: "Folder to watch", workingDirectory: "Working directory",
  initialPrompt: "Prompt", pipelineDefinitionId: "Pipeline", pipelineInput: "Pipeline input",
  botNpub: "Run as identity", activeWindow: "Active window",
});

export function triggerKindLabel(triggerType) {
  if (triggerType === "file_watcher") return "File watcher";
  if (triggerType === "unsupported") return "Unsupported";
  return "Schedule";
}

export function actionKindLabel(actionType) {
  if (actionType === "pipeline") return "Pipeline";
  if (actionType === "cleanup") return "Cleanup";
  return "Agent session";
}

export function jobStatus(job) {
  if (job.triggerType === "unsupported") return { key: "unsupported", label: "Unsupported" };
  return job.enabled ? { key: "enabled", label: "Enabled" } : { key: "disabled", label: "Disabled" };
}

/** One-line "when" text for a saved job, with timezone and active window. */
export function describeJobWhen(job) {
  if (job.triggerType === "unsupported") return "Unsupported trigger";
  if (job.triggerType === "file_watcher") {
    const pattern = job.filePattern && job.filePattern !== "*" ? ` matching ${job.filePattern}` : " (any file)";
    return `When files change in ${job.watchDirectory || "—"}${pattern}`;
  }
  return describeSchedule(job.cronExpression, job.timezone);
}

export function describeActiveWindow(start, end, timezone) {
  if (!start || !end) return "";
  return `Only between ${start} and ${end}${timezone ? ` (${timezone})` : ""}`;
}

/** "what" text for a saved job: the action and its target. */
export function describeJobWhat(job, pipelineName = (id) => id) {
  const action = job.actionType || "session";
  if (action === "pipeline") return `Pipeline: ${pipelineName(job.pipelineDefinitionId) || "—"}`;
  if (action === "cleanup") return "Cleanup: stops finished or stale automatic sessions";
  const engine = String(job.agent || "").trim();
  return `Agent session${engine ? ` (${engine})` : ""} in ${job.workingDirectory || "—"}`;
}

function parsePipelineObject(text) {
  if (!String(text ?? "").trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? null
      : "Pipeline input must be a JSON object, for example {}.";
  } catch (err) {
    return `Pipeline input is not valid JSON (${err.message}).`;
  }
}

/**
 * Validate form values before submit. Returns { field: message }; empty means
 * valid. The server remains authoritative; these checks mirror its rules so the
 * reason is shown next to the field instead of a disabled button.
 */
export function validateTriggerForm({ actionType, triggerType, form, identityMessage = "" }) {
  const errors = {};
  if (!String(form.name ?? "").trim()) errors.name = "Give the trigger a name so you can recognise it later.";
  if (identityMessage) errors.botNpub = identityMessage;

  if (actionType === "session") {
    if (!String(form.workingDirectory ?? "").trim()) errors.workingDirectory = "Choose the directory the agent should work in.";
    if (!String(form.initialPrompt ?? "").trim()) errors.initialPrompt = "Tell the agent what to do.";
  } else if (actionType === "pipeline") {
    if (!form.pipelineDefinitionId) errors.pipelineDefinitionId = "Choose which pipeline to run.";
    const inputError = parsePipelineObject(form.pipelineInput);
    if (inputError) errors.pipelineInput = inputError;
  }

  if (triggerType === "file_watcher" && !String(form.watchDirectory ?? "").trim()) {
    errors.watchDirectory = "Choose the directory to watch.";
  }
  if (triggerType === "cron" || (form.activeStartTime && form.activeEndTime)) {
    if (!isValidTimezone(form.timezone)) errors.timezone = "Enter a valid timezone name such as Europe/London or UTC.";
  }
  if (Boolean(form.activeStartTime) !== Boolean(form.activeEndTime)) {
    errors.activeWindow = "Set both a start and an end time, or clear both.";
  }
  return errors;
}

export function firstInvalidField(errors) {
  return FIELD_ORDER.find((key) => errors[key]) || Object.keys(errors)[0] || "";
}

/** Live summary shown at the bottom of the form. */
export function describeDraft({ actionType, triggerType, form, cronExpression, identityName = "" }) {
  const when = actionType !== "cleanup" && triggerType === "file_watcher"
    ? (form.watchDirectory ? `When files change in ${form.watchDirectory}${form.filePattern && form.filePattern !== "*" ? ` matching ${form.filePattern}` : ""}` : "When files change in a directory you choose")
    : describeSchedule(cronExpression, form.timezone);
  const what = actionType === "pipeline"
    ? "run the selected pipeline"
    : actionType === "cleanup" ? "stop finished or stale automatic sessions" : "start an agent session";
  const identity = actionType !== "cleanup" && identityName ? ` as ${identityName}` : "";
  const window = describeActiveWindow(form.activeStartTime, form.activeEndTime, form.timezone);
  return `${when} → ${what}${identity}.${window ? ` ${window}.` : ""}`;
}

function includesQuery(job, query, extra) {
  const haystack = [
    job.name, job.workingDirectory, job.watchDirectory, job.agent, job.initialPrompt,
    job.cronExpression, describeCron(job.cronExpression), extra,
  ].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes(query);
}

/** Filter jobs by free text, status and trigger type. `lookup(job)` adds searchable text. */
export function filterJobs(jobs, { query = "", status = "all", type = "all" } = {}, lookup = () => "") {
  const needle = String(query).trim().toLowerCase();
  return jobs.filter((job) => {
    if (status !== "all" && jobStatus(job).key !== status) return false;
    if (type !== "all" && job.triggerType !== type) return false;
    return !needle || includesQuery(job, needle, lookup(job));
  });
}

export function countJobs(jobs) {
  const counts = { total: jobs.length, enabled: 0, disabled: 0, unsupported: 0 };
  for (const job of jobs) counts[jobStatus(job).key] += 1;
  return counts;
}
