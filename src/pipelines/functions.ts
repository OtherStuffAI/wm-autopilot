import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FunctionRegistry } from "./declarative";
import type { JsonObject } from "./pipeline-store";
import { deriveNpubSegment } from "../identity/npub-utils";
import { signWithWingmanKey } from "../mcp/wingman-signer";
import { generateSpeechAudio, resolveSpeechExtension } from "../server/audio-speech";
import { userSettingsStore } from "../storage/user-settings-store";
import { indexCorpusSequentially, indexRepositoryForPipeline } from "../code-intelligence/pipeline";

interface MemoryEntity {
  name: string;
  type: string;
  reason: string;
  query: string;
}

interface GraphMemoryMatch {
  id: string;
  entity: string;
  entityType: string;
  title: string;
  source: string;
  score: number;
  excerpt: string;
  labels: string[];
}

const DEFAULT_SETTINGS_SPEECH_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SETTINGS_SPEECH_MODEL = "hexgrad/kokoro-82m";
const DEFAULT_SETTINGS_SPEECH_VOICE = "af_heart";
const DEFAULT_SETTINGS_SPEECH_FORMAT = "mp3";
const DEFAULT_LOCAL_SPEECH_BASE_URL = "http://127.0.0.1:8880/v1";
const DEFAULT_LOCAL_SPEECH_MODEL = "kokoro";
const DEFAULT_LOCAL_SPEECH_VOICE = "am_onyx";
const NO_SPECIFIC_CHANNEL_CONTEXT = "No Specific Channel Context";
const pipelineModuleDirectory = dirname(fileURLToPath(import.meta.url));
const autopilotRoot = normalize(join(pipelineModuleDirectory, "../.."));
const pipelineAttachmentRoot = join(autopilotRoot, "tmp", "uploads", "attachments");

interface DailyNoteItemState {
  title: string;
  status: "completed" | "in_progress" | "blocked" | "planned";
}

interface DailyNotePayload {
  recordId: string | null;
  title: string;
  body: string;
  focus: string;
  noteDate: string;
  status: string;
  recordState: string;
  items: DailyNoteItemState[];
}

interface DailyNoteProgress {
  totalItems: number;
  completed: number;
  inProgress: number;
  blocked: number;
  notStarted: number;
  completionRatio: number;
  hasRecentActivity: boolean;
  reviewStatus: "on_track" | "partial" | "off_track";
}

function parseDailyNoteStatus(value: unknown): "completed" | "in_progress" | "blocked" | "planned" {
  const status = getText(value)?.toLowerCase() ?? "planned";
  if (["done", "completed", "complete", "finished"].includes(status)) return "completed";
  if (["in_progress", "inprogress", "working", "started", "active"].includes(status)) return "in_progress";
  if (["blocked", "stalled", "stuck", "waiting", "paused"].includes(status)) return "blocked";
  return "planned";
}

function normaliseDailyNoteItem(item: unknown): DailyNoteItemState | null {
  if (!item || typeof item !== "object") {
    if (typeof item === "string") {
      const title = item.trim();
      if (!title) return null;
      return { title, status: "planned" };
    }
    return null;
  }
  const next = objectValue(item);
  const title = getText(next.title ?? next.name ?? next.task ?? next.body ?? "");
  if (!title) return null;
  return {
    title,
    status: parseDailyNoteStatus(next.status ?? next.state ?? next.progress),
  };
}

function normaliseDailyNote(value: unknown): DailyNotePayload {
  const record = objectValue(value);
  const bodyPayload = objectValue(record.payload ?? record.data ?? {});
  const data = {
    ...record,
    ...objectValue(bodyPayload.data ?? bodyPayload),
  };
  const noteDate = getText(data.note_date ?? data.date ?? record.note_date ?? record.date)
    ?? new Date().toISOString().slice(0, 10);
  const items = Array.isArray(data.items)
    ? data.items.map(normaliseDailyNoteItem).filter(Boolean) as DailyNoteItemState[]
    : [];
  return {
    recordId: getText(record.record_id ?? record.recordId ?? record.id) || null,
    title: getText(record.title ?? data.title) ?? "Daily note",
    body: getText(record.body ?? data.body) ?? "",
    focus: getText(record.focus ?? data.focus) ?? "",
    noteDate,
    status: getText(record.status ?? data.status) ?? "active",
    recordState: getText(record.record_state ?? data.record_state) ?? "active",
    items,
  };
}

function evaluateDailyNoteProgress(note: DailyNotePayload, recentTaskChanges: unknown[]): DailyNoteProgress {
  const tasks = Array.isArray(recentTaskChanges) ? recentTaskChanges : [];
  const totalItems = note.items.length;
  const completed = note.items.filter((item) => item.status === "completed").length;
  const inProgress = note.items.filter((item) => item.status === "in_progress").length;
  const blocked = note.items.filter((item) => item.status === "blocked").length;
  const notStarted = Math.max(0, totalItems - completed - inProgress - blocked);
  const completionRatio = totalItems > 0 ? completed / Math.max(1, totalItems) : 0;

  const noteTokens = (note.items.length > 0 ? note.items.map((item) => item.title.toLowerCase()) : [])
    .concat([note.focus.toLowerCase(), note.title.toLowerCase(), note.body.toLowerCase()])
    .filter(Boolean);

  const normalizedTaskText = tasks
    .map((task) => {
      const row = objectValue(task);
      return [
        getText(row.title),
        getText(row.description),
        getText(row.body),
      ].filter(Boolean).join(" ").toLowerCase();
    })
    .filter(Boolean);

  const hasRecentActivity = tasks.some((task) => {
    const row = objectValue(task);
    const state = getText(row.state ?? row.status ?? "");
    const updatedAt = getText(row.updated_at ?? row.updatedAt);
    if (state === "deleted" || row.record_state === "deleted") return false;
    if (!updatedAt) return false;
    return true;
  }) && (noteTokens.length === 0 || normalizedTaskText.some((taskText) => noteTokens.some((noteToken) => taskText.includes(noteToken))));

  let reviewStatus: "on_track" | "partial" | "off_track";
  if (completionRatio >= 1 || (totalItems === 0 && hasRecentActivity)) {
    reviewStatus = "on_track";
  } else if (completionRatio >= 0.6 && hasRecentActivity) {
    reviewStatus = "partial";
  } else if (completionRatio >= 0.35 && totalItems > 0 && hasRecentActivity) {
    reviewStatus = "partial";
  } else {
    reviewStatus = "off_track";
  }

  return {
    totalItems,
    completed,
    inProgress,
    blocked,
    notStarted,
    completionRatio,
    hasRecentActivity,
    reviewStatus,
  };
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function pipelineRequirementIdFor(input: {
  pipelineDefinitionId: string;
  workPlan: Record<string, unknown>;
  index: number;
}): string {
  const explicit = getText(input.workPlan.requirementId ?? input.workPlan.id ?? input.workPlan.name);
  if (explicit) return explicit;
  const workdir = getText(input.workPlan.workdir ?? input.workPlan.workingDirectory) ?? "no-workdir";
  const summary = getText(input.workPlan.taskSummary ?? input.workPlan.title ?? input.workPlan.instructions) ?? `requirement-${input.index + 1}`;
  return createHash("sha1")
    .update(JSON.stringify({ pipelineDefinitionId: input.pipelineDefinitionId, workdir, summary }))
    .digest("hex")
    .slice(0, 12);
}

function normalisePipelineRequirement(input: {
  item: unknown;
  index: number;
  fallback: {
    pipelineDefinitionId: string | null;
    taskSummary: string;
    workdir: string | null;
    instructions: string | null;
    targetSurface: Record<string, unknown>;
    designDocumentUrl: string | null;
    designDocument: Record<string, unknown>;
    acceptanceCriteria: string[];
    executionPlan: string[];
    managerChecklist: string[];
    assignerNpub: string | null;
    reviewerNpub: string | null;
    maxReviewIterations: number;
    originalPrompt: string | null;
    channelContext: Record<string, unknown>;
    originThread: unknown[];
    referencedRecords: unknown[];
    visualReferences: unknown[];
    origin: Record<string, unknown>;
    reporting: Record<string, unknown>;
  };
}): {
  requirementId: string;
  pipelineDefinitionId: string | null;
  workPlan: Record<string, unknown>;
  missing: string[];
} {
  const item = objectValue(input.item);
  const payload = objectValue(item.payload ?? item.workPlan);
  const pipelineDefinitionId = getText(
    item.pipeline
      ?? item.pipelineId
      ?? item.pipelineDefinitionId
      ?? item.name
      ?? payload.pipeline
      ?? payload.pipelineId
      ?? payload.pipelineDefinitionId
      ?? payload.childPipelineDefinitionId,
  ) ?? input.fallback.pipelineDefinitionId;
  const softwarePipeline = isSoftwareImplementationPipelineIdentifier(pipelineDefinitionId);
  const workdir = getText(payload.workdir ?? payload.workingDirectory ?? item.workdir ?? item.workingDirectory)
    ?? (softwarePipeline ? null : input.fallback.workdir);
  const instructions = getText(payload.instructions ?? payload.implementationPrompt ?? item.instructions ?? item.prompt)
    ?? input.fallback.instructions;
  const targetSurface = objectValue(payload.targetSurface ?? item.targetSurface);
  const effectiveTargetSurface = Object.keys(targetSurface).length > 0 ? targetSurface : input.fallback.targetSurface;
  const designDocument = objectValue(payload.designDocument ?? item.designDocument);
  const effectiveDesignDocument = Object.keys(designDocument).length > 0 ? designDocument : input.fallback.designDocument;
  const designDocumentUrl = getText(
    payload.designDocumentUrl
      ?? payload.workingDoc
      ?? payload.workingDocument
      ?? payload.documentUrl
      ?? item.designDocumentUrl
      ?? item.workingDoc
      ?? item.workingDocument,
  ) ?? input.fallback.designDocumentUrl;
  const acceptanceCriteria = getStringArray(payload.acceptanceCriteria ?? item.acceptanceCriteria);
  const executionPlan = getStringArray(payload.executionPlan ?? item.executionPlan);
  const managerChecklist = getStringArray(payload.managerChecklist ?? item.managerChecklist);
  const visualReferences = Array.isArray(payload.visualReferences)
    ? payload.visualReferences
    : Array.isArray(item.visualReferences)
      ? item.visualReferences
      : input.fallback.visualReferences;
  const maxReviewIterations = clampReviewIterations(payload.maxReviewIterations ?? item.maxReviewIterations ?? input.fallback.maxReviewIterations);
  const workPlan = {
    ...payload,
    requirementId: getText(item.requirementId ?? payload.requirementId),
    childPipelineDefinitionId: pipelineDefinitionId,
    pipelineDefinitionId,
    taskSummary: getText(payload.taskSummary ?? payload.title ?? item.taskSummary ?? item.title) ?? input.fallback.taskSummary,
    instructions: instructions ?? "",
    acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : input.fallback.acceptanceCriteria,
    executionPlan: executionPlan.length > 0 ? executionPlan : input.fallback.executionPlan,
    managerChecklist: managerChecklist.length > 0 ? managerChecklist : input.fallback.managerChecklist,
    workdir,
    assignerNpub: getText(payload.assignerNpub ?? item.assignerNpub) ?? input.fallback.assignerNpub,
    reviewerNpub: getText(payload.reviewerNpub ?? item.reviewerNpub) ?? input.fallback.reviewerNpub,
    maxReviewIterations,
    originalPrompt: getText(payload.originalPrompt ?? item.originalPrompt) ?? input.fallback.originalPrompt,
    channelContext: objectValue(payload.channelContext ?? item.channelContext),
    originThread: Array.isArray(payload.originThread) ? payload.originThread : input.fallback.originThread,
    referencedRecords: Array.isArray(payload.referencedRecords) ? payload.referencedRecords : input.fallback.referencedRecords,
    ...(Object.keys(effectiveTargetSurface).length > 0 ? { targetSurface: effectiveTargetSurface } : {}),
    ...(visualReferences.length > 0 ? { visualReferences: visualReferences.slice(0, 8) } : {}),
    ...(designDocumentUrl ? { designDocumentUrl } : {}),
    ...(Object.keys(effectiveDesignDocument).length > 0 ? { designDocument: effectiveDesignDocument } : {}),
    origin: {
      ...input.fallback.origin,
      ...objectValue(payload.origin ?? item.origin),
    },
    reporting: {
      ...input.fallback.reporting,
      ...objectValue(payload.reporting ?? item.reporting),
    },
  };
  const requirementId = pipelineRequirementIdFor({
    pipelineDefinitionId: pipelineDefinitionId ?? "missing-pipeline",
    workPlan,
    index: input.index,
  });
  workPlan.requirementId = requirementId;
  const missing = [
    !pipelineDefinitionId ? `pipelines[${input.index}].pipeline` : "",
    isDispatchPipelineIdentifier(pipelineDefinitionId) ? `pipelines[${input.index}].pipeline downstream work pipeline` : "",
    softwarePipeline && Object.keys(effectiveTargetSurface).length === 0 ? `pipelines[${input.index}].targetSurface` : "",
    softwarePipeline && isPlaceholderSoftwareWorkdir(workdir) ? `pipelines[${input.index}].non-placeholder workdir` : "",
    !softwarePipeline && !isDocumentDiscussionPipelineIdentifier(pipelineDefinitionId) && !workdir ? `pipelines[${input.index}].workdir` : "",
    !instructions ? `pipelines[${input.index}].instructions` : "",
  ].filter(Boolean);
  return {
    requirementId,
    pipelineDefinitionId,
    workPlan,
    missing,
  };
}

function resolveChatThreadDesignReference(input: JsonObject, workPlan: Record<string, unknown>): string | null {
  const origin = objectValue(workPlan.origin ?? input.origin);
  const chat = objectValue(input.chat);
  const record = objectValue(input.record);
  const routing = objectValue(input.routing);
  const payload = objectValue(record.payload);
  const threadId = getText(origin.threadId ?? chat.threadId ?? routing.threadId ?? payload.thread_id);
  const messageId = getText(origin.messageId ?? record.recordId ?? record.record_id ?? payload.record_id);
  if (!threadId) return null;
  return `flightdeck-chat-thread://${threadId}${messageId ? `#${messageId}` : ""}`;
}

function extractTaskIdFromMention(value: unknown): string | null {
  const text = getText(value);
  if (!text) return null;
  const match = text.match(/mention:task:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

function normaliseDispatchWorkPlanContext(
  input: JsonObject,
  options: {
    operation: string;
    defaultTaskSummary: string;
    directReason: string;
    taskBackedReason: string;
  },
): JsonObject {
  const createdTask = objectValue(input.createdTask);
  const suppliedWorkPlan = objectValue(input.workPlan ?? createdTask.workPlan);
  const taskId = getText(suppliedWorkPlan.taskId ?? input.taskId ?? createdTask.taskId)
    ?? extractTaskIdFromMention(suppliedWorkPlan.taskMention ?? input.taskMention);
  const taskTitle = getText(input.taskTitle ?? createdTask.title ?? suppliedWorkPlan.taskTitle ?? suppliedWorkPlan.taskSummary);
  const reporting = objectValue(suppliedWorkPlan.reporting ?? input.reporting ?? input.reportTarget);
  const hasFlightDeckDispatchContext = Object.keys(objectValue(input.dispatch)).length > 0
    || Object.keys(objectValue(input.workspace)).length > 0
    || Object.keys(objectValue(input.record)).length > 0
    || Object.keys(objectValue(input.routing)).length > 0
    || Object.keys(objectValue(input.runtime)).length > 0;
  const rawReportingMode = getText(reporting.mode ?? reporting.type);
  const origin = objectValue(suppliedWorkPlan.origin ?? input.origin);
  const originKind = getText(origin.kind)
    ?? (getText(origin.triggerKind) === "chat" ? "chat_thread" : hasFlightDeckDispatchContext ? "flightdeck_task" : "direct");
  const reportingMode = originKind === "chat_thread"
    ? (rawReportingMode ?? "chat_thread")
    : hasFlightDeckDispatchContext
    && (!rawReportingMode || rawReportingMode === "pipeline_result" || rawReportingMode === "pipeline-result")
    ? "flightdeck_task"
    : rawReportingMode ?? (hasFlightDeckDispatchContext ? "flightdeck_task" : "pipeline_result");
  const explicitDesignDocumentUrl = getText(suppliedWorkPlan.designDocumentUrl ?? input.designDocumentUrl);
  const designDocumentUrl = explicitDesignDocumentUrl
    ?? (originKind === "chat_thread" ? resolveChatThreadDesignReference(input, suppliedWorkPlan) : null);
  const workPlan = {
    ...suppliedWorkPlan,
    ...(taskId ? { taskId } : {}),
    ...(taskTitle ? { taskTitle } : {}),
    taskSummary: getText(suppliedWorkPlan.taskSummary ?? taskTitle) ?? options.defaultTaskSummary,
    origin: {
      ...origin,
      kind: originKind,
    },
    workdir: getText(suppliedWorkPlan.workdir ?? suppliedWorkPlan.workingDirectory ?? input.workingDirectory ?? input.workdir)
      ?? suppliedWorkPlan.workdir,
    instructions: getText(suppliedWorkPlan.instructions ?? input.implementationPrompt ?? input.instructions)
      ?? suppliedWorkPlan.instructions,
    ...(designDocumentUrl ? { designDocumentUrl } : {}),
    designDocumentUnavailableReason: getText(suppliedWorkPlan.designDocumentUnavailableReason ?? input.designDocumentUnavailableReason)
      ?? suppliedWorkPlan.designDocumentUnavailableReason,
    designDocument: suppliedWorkPlan.designDocument ?? input.designDocument ?? null,
    designDocumentAccessInstructions: getText(suppliedWorkPlan.designDocumentAccessInstructions ?? input.designDocumentAccessInstructions)
      ?? suppliedWorkPlan.designDocumentAccessInstructions,
    targetSurface: objectValue(suppliedWorkPlan.targetSurface ?? input.targetSurface),
    visualReferences: Array.isArray(suppliedWorkPlan.visualReferences)
      ? suppliedWorkPlan.visualReferences
      : Array.isArray(input.visualReferences)
        ? input.visualReferences
        : [],
    reporting: {
      ...reporting,
      mode: reportingMode,
    },
  };
  const maxReviewIterations = clampReviewIterations(
    suppliedWorkPlan.maxReviewIterations
      ?? input.maxReviewIterations
      ?? createdTask.maxReviewIterations,
  );
  return {
    published: false,
    status: hasFlightDeckDispatchContext ? "not_configured" : "ready",
    operation: options.operation,
    reason: hasFlightDeckDispatchContext ? options.taskBackedReason : options.directReason,
    taskId: taskId ?? null,
    title: taskTitle ?? null,
    createdTask: {
      ...createdTask,
      ...(taskId ? { taskId } : {}),
      ...(taskTitle ? { title: taskTitle } : {}),
      workPlan,
    },
    workPlan,
    reporting: workPlan.reporting,
    taskBacked: hasFlightDeckDispatchContext,
    maxReviewIterations,
    reviewLoop: {
      iteration: 1,
      index: 0,
      completed: 0,
      total: maxReviewIterations,
      done: false,
    },
  };
}

function resolvePipelineSpeechSettings(input: JsonObject): {
  provider?: "openrouter" | "local";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: string;
} | null {
  const explicit = objectValue(input.speechSettings ?? input.settings);
  const settingsNpub = getText(input.settingsNpub ?? input.npub ?? input.ownerNpub);
  const stored = settingsNpub ? userSettingsStore.getAll(settingsNpub) : {};
  const provider = explicit.provider === "local" || stored.speech_provider === "local" ? "local" : "openrouter";
  const speechApiKey = getText(explicit.apiKey ?? explicit.speech_api_key) ?? stored.speech_api_key ?? "";
  const apiKey = provider === "local"
    ? ""
    : speechApiKey || stored.openrouter_api_key || stored.openai_api_key || "";
  const baseUrl = getText(explicit.baseUrl ?? explicit.speech_base_url) ||
    stored.speech_base_url ||
    (provider === "local" ? DEFAULT_LOCAL_SPEECH_BASE_URL : DEFAULT_SETTINGS_SPEECH_BASE_URL);
  const model = getText(explicit.model ?? explicit.speech_model) ||
    stored.speech_model ||
    (provider === "local" ? DEFAULT_LOCAL_SPEECH_MODEL : DEFAULT_SETTINGS_SPEECH_MODEL);
  const voice = getText(input.voice) ||
    getText(explicit.voice ?? explicit.speech_voice) ||
    stored.speech_voice ||
    (provider === "local" ? DEFAULT_LOCAL_SPEECH_VOICE : DEFAULT_SETTINGS_SPEECH_VOICE);
  const format = getText(explicit.format ?? explicit.speech_format) ||
    stored.speech_format ||
    DEFAULT_SETTINGS_SPEECH_FORMAT;
  return {
    provider,
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    model,
    voice,
    format,
  };
}

function cleanArtifactReferenceCandidate(value: unknown): string | null {
  const text = getText(value);
  if (!text) return null;
  const markdownLink = text.match(/\[[^\]]+\]\(([^)\s]+)\)/);
  const candidate = (markdownLink?.[1] ?? text)
    .trim()
    .replace(/^[`<]+/, "")
    .replace(/[>`]+$/, "")
    .replace(/[),.;]+$/, "");
  const inlineReference = candidate.match(/(?:storage:\/\/\S+|https?:\/\/\S+|\/Users\/\S+|~\/\S+|\.\.?\/\S+)/);
  return (inlineReference?.[0] ?? candidate).trim().replace(/[),.;]+$/, "") || null;
}

function extractArtifactReferenceFromText(value: unknown): string | null {
  const text = getText(value);
  if (!text) return null;
  const linePattern = /^\s*(?:[-*]\s*)?(?:primary\s+(?:design\/ticket\s+)?artifact|primary\s+design\s+artifact|design\s+document|design|ticket|artifact|document)\s*:\s*(.+?)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(text)) !== null) {
    const reference = cleanArtifactReferenceCandidate(match[1]);
    if (reference) return reference;
  }
  return null;
}

function extractStructuredArtifactReference(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const reference = extractStructuredArtifactReference(item, depth + 1);
      if (reference) return reference;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const directKeys = [
    "designDocumentUrl",
    "design_document_url",
    "designUrl",
    "design_url",
    "documentUrl",
    "document_url",
    "ticketUrl",
    "ticket_url",
    "ticketPath",
    "ticket_path",
    "artifactUrl",
    "artifact_url",
    "artifactPath",
    "artifact_path",
    "primaryArtifact",
    "primary_artifact",
    "designArtifact",
    "design_artifact",
    "path",
    "url",
  ];
  for (const key of directKeys) {
    const reference = cleanArtifactReferenceCandidate(record[key]);
    if (reference) return reference;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (!/(artifact|document|ticket|reference|link)/i.test(key)) continue;
    const reference = extractStructuredArtifactReference(nested, depth + 1);
    if (reference) return reference;
  }
  return null;
}

function resolveDesignDocumentReference(input: Record<string, unknown>, response: Record<string, unknown>, record: Record<string, unknown>, payload: Record<string, unknown>, payloadData: Record<string, unknown>): {
  designDocumentUrl: string;
  designDocumentSource: string;
  designDocumentUnavailableReason?: string;
} {
  const directReference = [
    response.designDocumentUrl,
    response.documentUrl,
    response.ticketUrl,
    response.ticketPath,
    response.artifactUrl,
    response.artifactPath,
    input.designDocumentUrl,
    input.documentUrl,
    input.ticketUrl,
    input.ticketPath,
    input.artifactUrl,
    input.artifactPath,
    payloadData.designDocumentUrl,
    payloadData.documentUrl,
    payloadData.ticketUrl,
    payloadData.ticketPath,
    payloadData.artifactUrl,
    payloadData.artifactPath,
    payload.designDocumentUrl,
    payload.documentUrl,
    payload.ticketUrl,
    payload.ticketPath,
    payload.artifactUrl,
    payload.artifactPath,
  ].map(cleanArtifactReferenceCandidate).find(Boolean);
  if (directReference) {
    return {
      designDocumentUrl: directReference,
      designDocumentSource: "explicit_field",
    };
  }

  const structuredReference = [
    response.references,
    response.artifacts,
    response.documents,
    response.links,
    payloadData.references,
    payloadData.artifacts,
    payloadData.documents,
    payloadData.links,
    payload.references,
    payload.artifacts,
    payload.documents,
    payload.links,
    record.references,
    record.artifacts,
  ].map((candidate) => extractStructuredArtifactReference(candidate)).find(Boolean);
  if (structuredReference) {
    return {
      designDocumentUrl: structuredReference,
      designDocumentSource: "structured_reference",
    };
  }

  const textReference = [
    payloadData.description,
    payload.description,
    response.description,
    response.instructions,
    response.taskSummary,
  ].map(extractArtifactReferenceFromText).find(Boolean);
  if (textReference) {
    return {
      designDocumentUrl: textReference,
      designDocumentSource: "task_description",
    };
  }

  const taskId = getText(payload.task_id ?? payloadData.task_id ?? payload.id ?? payloadData.id ?? record.recordId ?? input.taskId)
    ?? "current-task";
  return {
    designDocumentUrl: `flightdeck-task://${taskId}`,
    designDocumentSource: "task_context_fallback",
    designDocumentUnavailableReason: "no_separate_design_or_ticket_artifact",
  };
}

function mention(type: string, id: string, label: string): string {
  const safeLabel = label.replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim() || type;
  return `@[${safeLabel}](mention:${type}:${id})`;
}

function isDispatchPipelineIdentifier(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "agent-dispatch-chat"
    || normalized === "fd-agent-dispatch-chat"
    || normalized.startsWith("agent-dispatch-")
    || normalized.startsWith("fd-agent-dispatch-")
    || normalized.startsWith("demo-agent-dispatch-")
    || normalized.includes("agent-dispatch-")
    || normalized.includes("/agent-dispatch-chat.json")
    || normalized.includes("/agent-dispatch-")
    || normalized.includes("/fd-agent-dispatch-")
    || normalized.includes("/demo-agent-dispatch-");
}

function isDiscussionPipelineIdentifier(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "discussion-chat-response"
    || normalized.startsWith("discussion-chat-response.v")
    || normalized.includes("/discussion-chat-response")
    || isDocumentDiscussionPipelineIdentifier(value);
}

function isDocumentDiscussionPipelineIdentifier(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "document-discussion"
    || normalized.startsWith("document-discussion.v")
    || normalized.includes("/document-discussion");
}

function isSoftwareImplementationPipelineIdentifier(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "software-implementation-review-loop"
    || normalized.startsWith("software-implementation-review-loop.v")
    || normalized.includes("/software-implementation-review-loop");
}

function isPlaceholderSoftwareWorkdir(value: string | null): boolean {
  if (!value) return true;
  return value === "/workspace"
    || value.includes("/data/agent-chat-workspaces/")
    || /\/wingmen\/wingman\d+(?:\/|$)/.test(value);
}

function extractRepoWorkdirFromText(value: string | null): string | null {
  if (!value) return null;
  const patterns = [
    /(?:^|[\s(:])(~\/code\/[A-Za-z0-9._~/-]+)/,
    /(?:^|[\s(:])(\/[A-Za-z0-9._~/-]+\/code\/[A-Za-z0-9._~/-]+)/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const raw = match?.[1]?.replace(/[).,;:]+$/, "");
    if (!raw) continue;
    const expanded = raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw;
    if (!isPlaceholderSoftwareWorkdir(expanded)) return expanded;
  }
  return null;
}

const localRepoSearchRoots = (process.env.WINGMAN_REPOSITORY_ROOTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function resolveRepoWorkdirFromHighSignalText(...values: Array<string | null>): string | null {
  const text = values.filter(Boolean).join("\n");
  const explicit = extractRepoWorkdirFromText(text);
  if (explicit) return explicit;
  return findSingleLocalRepoMatch(text);
}

function findSingleLocalRepoMatch(text: string): string | null {
  const normalizedText = normalizeMatchText(text);
  if (!normalizedText) return null;
  const matches: Array<{ path: string; score: number }> = [];
  for (const root of localRepoSearchRoots) {
    for (const dir of listImmediateDirectories(root)) {
      if (!isLikelyRepoDirectory(dir)) continue;
      const basename = dir.split("/").filter(Boolean).at(-1) ?? "";
      const normalizedName = normalizeMatchText(basename);
      if (!normalizedName) continue;
      let score = 0;
      if (normalizedText.includes(normalizedName)) score += 4;
      const nameTokens = normalizedName.split(" ").filter((token) => token.length >= 3);
      const matchingTokens = nameTokens.filter((token) => normalizedText.includes(token));
      if (nameTokens.length > 0 && matchingTokens.length === nameTokens.length) score += 3;
      if (matchingTokens.length > 0) score += matchingTokens.length;
      if (score >= 4) matches.push({ path: dir, score });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const topScore = matches[0]?.score ?? 0;
  const topMatches = matches.filter((match) => match.score === topScore);
  return topMatches.length === 1 ? topMatches[0]!.path : null;
}

function listImmediateDirectories(root: string): string[] {
  try {
    return readdirSync(root)
      .map((entry) => join(root, entry))
      .filter((entry) => {
        try {
          return statSync(entry).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function isLikelyRepoDirectory(value: string | null): boolean {
  if (!value || isPlaceholderSoftwareWorkdir(value)) return false;
  return existsSync(join(value, ".git")) || existsSync(join(value, "package.json")) || existsSync(join(value, "AGENTS.md"));
}

function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function clampReviewIterations(value: unknown, fallback = 3): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(256, Math.floor(numeric)));
}

const coreChatChildPipelineSlugs = new Set([
  "do-and-review",
  "software-implementation-review-loop",
  "research-and-report",
]);

const chatOnlyIntents = new Set([
  "answer_now",
  "think_then_answer",
]);

const createTaskIntents = new Set([
  "create_task",
]);

const promissoryActionPattern = /\b(?:i(?:'ll| will| am going to)|i\u2019ll)\b[\s\S]{0,160}\b(?:review|investigate|inspect|check|read|look into|trace|research|summari[sz]e|analy[sz]e|gather|audit)\b/i;
const operationalReviewRequestPattern = /\b(?:review|investigate|inspect|check|summari[sz]e|analy[sz]e|audit)\b[\s\S]{0,120}\b(?:sessions?|logs?|runs?|pipelines?|projects?|status|where we'?re at)\b/i;

function shouldPromoteThinkThenAnswerToTask(responseDraft: string | null, originalPrompt: string | null): boolean {
  const response = responseDraft ?? "";
  const prompt = originalPrompt ?? "";
  return promissoryActionPattern.test(response) || operationalReviewRequestPattern.test(prompt);
}

function buildPromotedChatTaskDraft(originalPrompt: string | null): {
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  executionPlan: string[];
  managerChecklist: string[];
} {
  const prompt = originalPrompt ?? "Investigate the originating chat request and report back.";
  const title = /\bautopilot\b/i.test(prompt) && /\bsessions?\b/i.test(prompt)
    ? "Review today's Autopilot sessions and project status"
    : "Investigate chat request and report back";
  return {
    title,
    instructions: [
      "Investigate the originating Flight Deck chat request and provide the requested answer back in that same thread.",
      "",
      `Original request: ${prompt}`,
      "",
      "Treat this as task-backed work because the first-stage chat classifier only produced a future-action acknowledgement rather than a complete answer.",
    ].join("\n"),
    acceptanceCriteria: [
      "The relevant current session, pipeline, task, or project state has been inspected directly rather than inferred from the initial chat prompt.",
      "The final update answers the originating chat request in the original thread.",
      "The task includes concise evidence of what was checked and any important limitations or follow-up work.",
    ],
    executionPlan: [
      "Read the originating chat thread and identify the requested scope.",
      "Inspect the relevant Autopilot session, pipeline, task, and project state for the requested date or topic.",
      "Summarize findings and post the update to the originating Flight Deck thread.",
    ],
    managerChecklist: [
      "Verify the worker did not stop at an acknowledgement.",
      "Confirm the final reply was posted to the originating chat thread.",
      "Confirm evidence and limitations are recorded on the task before review.",
    ],
  };
}

function compactText(value: unknown, maxLength: number): string | null {
  const text = getText(value);
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function tokenizeForMatch(value: unknown): Set<string> {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  const ignored = new Set([
    "about", "after", "again", "also", "and", "are", "can", "for", "from", "has", "into", "please", "report", "run", "runs",
    "send", "that", "the", "this", "was", "will", "with", "work", "you",
  ]);
  return new Set(
    text
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !ignored.has(token)),
  );
}

function scorePipelineRelevance(pipeline: Record<string, unknown>, promptTokens: Set<string>): number {
  if (promptTokens.size === 0) return 0;
  const text = [
    getText(pipeline.slug),
    getText(pipeline.name),
    getText(pipeline.description),
  ].filter(Boolean).join(" ");
  const pipelineTokens = tokenizeForMatch(text);
  let score = 0;
  for (const token of promptTokens) {
    if (pipelineTokens.has(token)) score += 1;
  }
  return score;
}

function compactPipelineDefinition(value: unknown, promptTokens: Set<string>): JsonObject | null {
  const pipeline = objectValue(value);
  const id = getText(pipeline.id);
  const slug = getText(pipeline.slug);
  const name = getText(pipeline.name);
  if (isDispatchPipelineIdentifier(id) || isDispatchPipelineIdentifier(slug) || isDispatchPipelineIdentifier(name)) {
    return null;
  }
  const normalizedSlug = slug?.toLowerCase() ?? "";
  const relevance = scorePipelineRelevance(pipeline, promptTokens);
  const isCorePipeline = coreChatChildPipelineSlugs.has(normalizedSlug);
  if (!isCorePipeline && relevance < 2) {
    return null;
  }
  return {
    id,
    slug,
    name,
    scope: getText(pipeline.scope),
    description: compactText(pipeline.description, isCorePipeline ? 220 : 160),
  };
}

function compactScope(value: unknown): JsonObject {
  const scope = objectValue(value);
  return {
    id: getText(scope.record_id ?? scope.id),
    title: getText(scope.title),
    level: getText(scope.level),
    parentId: getText(scope.parent_id),
  };
}

function extractScopeRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  const candidates = [
    object.scopes,
    object.records,
    object.items,
    object.data,
    object.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  const nestedData = objectValue(object.data);
  const nestedCandidates = [
    nestedData.scopes,
    nestedData.records,
    nestedData.items,
    nestedData.results,
  ];
  for (const candidate of nestedCandidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function compactThreadMessage(value: unknown): JsonObject {
  const message = objectValue(value);
  return {
    messageId: getText(message.message_id ?? message.record_id ?? message.messageId),
    parentMessageId: getText(message.parent_message_id ?? message.parentMessageId),
    senderNpub: getText(message.sender_npub ?? message.senderNpub),
    body: compactText(message.body ?? message.messageText, 3000) ?? "",
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    updatedAt: getText(message.updated_at ?? message.updatedAt),
  };
}

function compactTriggerChatMessage(record: Record<string, unknown>, chat: Record<string, unknown>): JsonObject | null {
  const payload = objectValue(record.payload);
  const messageId = getText(record.recordId ?? record.record_id ?? payload.record_id ?? chat.messageId);
  const body = compactText(payload.body ?? chat.messageText ?? chat.body, 3000);
  if (!messageId && !body) return null;
  return {
    messageId,
    parentMessageId: getText(payload.parent_message_id ?? chat.parentMessageId),
    senderNpub: getText(chat.senderNpub ?? payload.sender_npub ?? record.updaterNpub),
    body: body ?? "",
    attachments: Array.isArray(payload.attachments)
      ? payload.attachments
      : Array.isArray(chat.attachments)
        ? chat.attachments
        : [],
    updatedAt: getText(payload.updated_at ?? payload.updatedAt ?? record.updatedAt),
  };
}

function collectVisualReferencesFromThread(messages: unknown[]): JsonObject[] {
  const references: JsonObject[] = [];
  for (const message of messages) {
    const compact = compactThreadMessage(message);
    const messageId = getText(compact.messageId);
    const attachments = Array.isArray(compact.attachments) ? compact.attachments : [];
    for (const attachment of attachments) {
      const record = objectValue(attachment);
      const mediaType = getText(record.mediaType ?? record.contentType ?? record.mimeType ?? record.type) ?? "";
      const fileName = getText(record.fileName ?? record.filename ?? record.name ?? record.label);
      const url = getText(record.url ?? record.href ?? record.storageUrl ?? record.downloadUrl);
      const localPath = getText(record.localPath ?? record.path ?? record.filePath);
      const looksVisual = /^image\//i.test(mediaType)
        || /\.(png|jpe?g|gif|webp|avif)$/i.test(fileName ?? "")
        || /\.(png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i.test(url ?? localPath ?? "");
      if (!looksVisual && !localPath && !url) continue;
      references.push({
        source: "thread_attachment",
        messageId,
        label: fileName ?? (mediaType || "attachment"),
        mediaType: mediaType || null,
        url: url ?? null,
        localPath: localPath ?? null,
        attachment: record,
      });
    }
  }
  return references.slice(0, 8);
}

function latestThreadWithTrigger(chatContext: Record<string, unknown>, record: Record<string, unknown>, chat: Record<string, unknown>): JsonObject[] {
  const latestThread = getThreadMessages(chatContext).slice(-8).map(compactThreadMessage);
  const trigger = compactTriggerChatMessage(record, chat);
  const triggerId = getText(trigger?.messageId);
  if (!trigger || (triggerId && latestThread.some((message) => getText(message.messageId) === triggerId))) {
    return latestThread;
  }
  return [...latestThread.slice(-7), trigger];
}

function compactReferencedRecord(value: unknown): JsonObject {
  const record = objectValue(value);
  const payload = objectValue(record.payload);
  const data = objectValue(payload.data);
  return {
    id: getText(record.id ?? record.record_id ?? record.recordId ?? payload.record_id),
    recordId: getText(record.record_id ?? record.recordId ?? record.id ?? payload.record_id),
    type: getText(record.type ?? record.record_type ?? record.recordType ?? payload.type),
    family: getText(record.record_family ?? record.recordFamily ?? record.family ?? payload.family),
    state: getText(record.state ?? record.record_state ?? record.recordState ?? payload.state ?? payload.record_state),
    title: compactText(record.title ?? payload.title ?? data.title, 240),
    summary: compactText(record.summary ?? payload.summary ?? data.summary ?? payload.description ?? data.description ?? payload.body, 900),
    url: getText(record.url ?? payload.url ?? data.url),
    updatedAt: getText(record.updated_at ?? record.updatedAt ?? payload.updated_at),
  };
}

function resolveFlightDeckChannelContext(...sources: unknown[]): JsonObject {
  for (const source of sources) {
    const sourceObject = objectValue(source);
    const channel = objectValue(sourceObject.channel ?? sourceObject.channelContext);
    const contextPrompt = getText(channel.contextPrompt ?? sourceObject.contextPrompt);
    const hasSpecificContext = Boolean(contextPrompt && contextPrompt !== NO_SPECIFIC_CHANNEL_CONTEXT);
    if (
      getText(channel.id ?? channel.channelId ?? sourceObject.channelId)
      || getText(channel.name ?? sourceObject.name ?? sourceObject.channelName)
      || contextPrompt
    ) {
      return {
        channelId: getText(channel.id ?? channel.channelId ?? sourceObject.channelId),
        scopeId: getText(channel.scopeId ?? sourceObject.scopeId),
        name: getText(channel.name ?? sourceObject.name ?? sourceObject.channelName),
        contextPrompt: contextPrompt ?? NO_SPECIFIC_CHANNEL_CONTEXT,
        hasSpecificContext,
      };
    }
  }
  return {
    channelId: null,
    scopeId: null,
    name: null,
    contextPrompt: NO_SPECIFIC_CHANNEL_CONTEXT,
    hasSpecificContext: false,
  };
}

function getThreadMessages(chatContext: Record<string, unknown>): unknown[] {
  const thread = objectValue(chatContext.thread);
  return Array.isArray(thread.recent_messages)
    ? thread.recent_messages
    : Array.isArray(thread.recentMessages)
      ? thread.recentMessages
      : Array.isArray(thread.messages)
        ? thread.messages
        : [];
}

function isDiscussionIntent(rawIntent: string | null, text: string): boolean {
  const intent = (rawIntent ?? "").toLowerCase();
  if (
    ["discussion", "discuss", "planning", "plan", "design_discussion", "design", "reasoning", "clarification"].includes(intent)
    || /\b(discuss|discussion|planning|plan|design|reasoning|clarif(y|ication))\b/.test(intent)
  ) {
    return true;
  }
  return /\b(can we|could we|let'?s|i'?d like to|help me)\s+(discuss|plan|think through|reason about|talk through|design)\b/i.test(text)
    || /\b(clarify|pin down)\s+(terms|terminology)\b/i.test(text)
    || /\bdiscussion pipeline\b/i.test(text)
    || /\bgraph (is getting updated|gets updated|update|memory)\b/i.test(text)
    || /\bbefore we (build|implement|code|ship),?\s+let'?s\b/i.test(text);
}

function isSimpleDirectChatText(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (/^(hi|hello|hey|yo|ping|test|testing|gm|good morning|good afternoon|good evening)[!.?]*$/.test(normalized)) {
    return true;
  }
  return /\b(can you hear me|can you see this|are you there|you there|can you respond|please respond|respond here)\b/i.test(text);
}

function isDocumentDiscussionIntent(rawIntent: string | null, text: string): boolean {
  const intent = (rawIntent ?? "").toLowerCase();
  return [
    "document_discussion",
    "document-discussion",
    "document_comment",
    "document-comment",
    "design_discussion",
    "design",
    "planning",
    "plan",
  ].includes(intent)
    || /\b(document|doc|design|plan|planning|proposal|spec|brief)\b/i.test(text)
    || /\b(comment|comments|inline comment|review note|accepted plan)\b/i.test(text);
}

function isDocumentDiscussionChannelContext(value: unknown): boolean {
  const channelContext = objectValue(value);
  if (channelContext.hasSpecificContext === false) return false;
  const text = getText(channelContext.contextPrompt) ?? "";
  return /\b(feature|design|planning|discussion|discussing features)\b/i.test(text)
    && /\b(doc|document|definition|comments?)\b/i.test(text)
    && /\b(not trying to build|not build|before implementing|before implementation|iterate)\b/i.test(text);
}

function isImplementationRequestText(text: string): boolean {
  return /\b(implement|build|code|fix|ship|deploy|migrate|wire up|integrate|add tests?|update the repo|make the change|make code changes?)\b/i.test(text);
}

function resolveDiscussionPipelineId(
  input: Record<string, unknown>,
  raw: Record<string, unknown>,
  decision: Record<string, unknown>,
  latestText = "",
  rawIntent: string | null = null,
): string {
  const requested = getText(
    raw.recommendedPipelineId
      ?? raw.recommendedPipelineDefinitionId
      ?? raw.pipelineDefinitionId
      ?? raw.recommendedPipeline
      ?? decision.discussionPipelineDefinitionId
      ?? decision.pipelineDefinitionId,
  );
  const runtime = objectValue(input.runtime);
  const chatContext = objectValue(input.chatContext);
  const pipelines = Array.isArray(runtime.availablePipelines)
    ? runtime.availablePipelines
    : Array.isArray(chatContext.availablePipelines)
      ? chatContext.availablePipelines
      : [];
  const wantsDocumentDiscussion = isDocumentDiscussionPipelineIdentifier(requested)
    || isDocumentDiscussionIntent(rawIntent, latestText);
  if (wantsDocumentDiscussion) {
    for (const pipelineValue of pipelines) {
      const pipeline = objectValue(pipelineValue);
      const id = getText(pipeline.id);
      const name = getText(pipeline.name);
      const slug = getText(pipeline.slug);
      if (isDocumentDiscussionPipelineIdentifier(id) || isDocumentDiscussionPipelineIdentifier(name) || isDocumentDiscussionPipelineIdentifier(slug)) {
        return id ?? name ?? slug ?? "document-discussion";
      }
    }
    return requested ?? "document-discussion";
  }
  for (const pipelineValue of pipelines) {
    const pipeline = objectValue(pipelineValue);
    const id = getText(pipeline.id);
    const name = getText(pipeline.name);
    const slug = getText(pipeline.slug);
    if (
      (isDiscussionPipelineIdentifier(id) || isDiscussionPipelineIdentifier(name) || isDiscussionPipelineIdentifier(slug))
      && (!requested || requested === id || requested === name || requested === slug)
    ) {
      return id ?? name ?? slug ?? "discussion-chat-response";
    }
  }
  return requested ?? "discussion-chat-response";
}

function isTaskInReview(value: unknown): boolean {
  const record = objectValue(value);
  const payload = objectValue(record.payload);
  const state = getText(record.state ?? record.recordState ?? record.record_state ?? payload.state ?? payload.record_state)?.toLowerCase();
  const family = getText(record.family ?? record.recordFamily ?? record.record_family ?? payload.family)?.toLowerCase();
  return (family === "task" || Boolean(getText(record.recordId ?? record.record_id ?? payload.task_id))) && state === "review";
}

function isDocumentReference(value: unknown): boolean {
  const record = objectValue(value);
  const payload = objectValue(record.payload);
  const family = getText(record.type ?? record.family ?? record.recordFamily ?? record.record_family ?? payload.type ?? payload.family)?.toLowerCase();
  return family === "doc" || family === "document" || family === "documents";
}

function isApprovalText(value: string): boolean {
  return /\b(looks good|lgtm|approved|approve|ship it|done|complete|all good|good to go|that works|this works)\b/i.test(value);
}

function latestThreadText(chatContext: Record<string, unknown>, fallback: unknown): string {
  const messages = getThreadMessages(chatContext).map(compactThreadMessage);
  const latest = messages[messages.length - 1] ?? {};
  return getText(latest.body) ?? getText(fallback) ?? "";
}

export const builtinPipelineFunctions: FunctionRegistry = {
  async "codeIntelligence.indexRepository"(input) {
    return await indexRepositoryForPipeline(input as unknown as Parameters<typeof indexRepositoryForPipeline>[0]) as unknown as JsonObject;
  },

  async "codeIntelligence.indexCorpusSequentially"(input) {
    return await indexCorpusSequentially(input as unknown as Parameters<typeof indexCorpusSequentially>[0]) as unknown as JsonObject;
  },
  async "system.restartAndResume"(input) {
    const autopilotUrl = getText(input.autopilotUrl ?? input.baseUrl ?? input.url);
    if (!autopilotUrl) {
      return { status: "failed", scheduled: false, error: "autopilot_url_required" };
    }
    try {
      const requestUrl = new URL("/api/system/restart-and-resume", autopilotUrl).toString();
      const { token } = await signWithWingmanKey(requestUrl, "POST");
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { authorization: token },
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      return {
        status: response.ok ? "scheduled" : "failed",
        scheduled: response.ok,
        statusCode: response.status,
        sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
        error: response.ok ? null : getText(payload.error) ?? response.statusText,
        blockers: Array.isArray(payload.blockers) ? payload.blockers : [],
      };
    } catch (error) {
      return {
        status: "failed",
        scheduled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async "text.normalise"(input) {
    const text = String(input.text ?? "").trim();
    return {
      text,
      words: wordCount(text),
      allowedKinds: ["decision", "clarification", "summary"],
    };
  },

  async "text.paragraphs"(input) {
    const text = String(input.text ?? "").trim();
    const targetParagraphNumber = Math.max(1, Math.floor(Number(input.targetParagraphNumber ?? 2) || 2));
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((paragraph, index) => ({
        number: index + 1,
        text: paragraph,
        words: wordCount(paragraph),
      }));
    const selectedParagraph = paragraphs[targetParagraphNumber - 1] ?? null;
    return {
      paragraphCount: paragraphs.length,
      targetParagraphNumber,
      paragraphs,
      selectedParagraph,
    };
  },

  async "text.features"(input) {
    const text = String(input.text ?? "");
    const lower = text.toLowerCase();
    return {
      words: Number(input.words ?? 0),
      mentionsJson: lower.includes("json"),
      mentionsPipeline: lower.includes("pipeline"),
      asksForStructure: lower.includes("declarative") || lower.includes("object"),
    };
  },

  async "audio.generateSpeech"(input) {
    const text = getText(input.text ?? input.narration ?? input.summary);
    if (!text) {
      return {
        status: "skipped",
        reason: "text_required",
      };
    }

    const ownerNpub = getText(input.ownerNpub ?? input.settingsNpub ?? input.npub);
    const ownerSegment = deriveNpubSegment(ownerNpub);
    const agent = getText(input.agent) ?? "wingman-gm";
    const speechSummary = text.replace(/\s+/g, " ").trim().slice(0, 500);

    try {
      const generated = await generateSpeechAudio({
        text,
        voice: getText(input.voice),
        config: resolvePipelineSpeechSettings(input),
      });
      const filename = `pipeline-speech-${Date.now()}-${randomUUID()}${resolveSpeechExtension(generated.format)}`;
      const relativePath = normalize(join(ownerSegment, agent, "speech", filename)).replace(/\\/g, "/");
      const directory = join(pipelineAttachmentRoot, ownerSegment, agent, "speech");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, filename), generated.audio);

      return {
        status: "ok",
        publicPath: `/uploads/files/${relativePath}`,
        relativePath,
        mimeType: generated.mimeType,
        voice: generated.voice,
        model: generated.model,
        format: generated.format,
        summary: speechSummary,
        createdAt: new Date().toISOString(),
        sizeBytes: generated.audio.byteLength,
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async "http.postJson"(input) {
    const url = getText(input.url);
    if (!url) {
      return {
        status: "failed",
        error: "url_required",
      };
    }
    const body = objectValue(input.body);
    const headersInput = objectValue(input.headers);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    for (const [key, value] of Object.entries(headersInput)) {
      if (typeof value === "string" && key.trim()) {
        headers[key] = value;
      }
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const responseText = await response.text().catch(() => "");
      let responseJson: unknown = null;
      if (responseText.trim()) {
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          responseJson = null;
        }
      }
      return {
        status: response.ok ? "ok" : "failed",
        ok: response.ok,
        statusCode: response.status,
        response: responseJson && typeof responseJson === "object" && !Array.isArray(responseJson)
          ? responseJson as JsonObject
          : {},
        responseText: responseJson ? "" : responseText.slice(0, 2000),
      };
    } catch (error) {
      return {
        status: "failed",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async "wingmanGm.deliverWebhook"(input) {
    const webhook = objectValue(input.webhook);
    const url = getText(input.url ?? webhook.url);
    const token = getText(input.token ?? webhook.token);
    const authHeader = getText(input.authHeader ?? webhook.authHeader) ?? "x-wingman-gm-token";
    const gmResponse = objectValue(input.gmResponse ?? input.response);
    if (!url) {
      return { status: "failed", error: "webhook_url_required" };
    }
    if (!token) {
      return { status: "failed", error: "webhook_token_required" };
    }
    const speech = objectValue(input.speech);
    const response = {
      ...gmResponse,
      speech: Object.keys(speech).length > 0 ? speech : gmResponse.speech ?? null,
    };
    const body = {
      runId: getText(input.runId) ?? getText(input.pipelineRunId) ?? null,
      campaignId: getText(input.campaignId),
      turnId: getText(input.turnId),
      status: "ok",
      response,
      metadata: {
        source: "wingman-gm-pipeline",
        deliveredAt: new Date().toISOString(),
      },
    };
    const posted = await builtinPipelineFunctions["http.postJson"]!({
      url,
      headers: { [authHeader]: token },
      body,
    });
    return {
      ...posted,
      delivered: posted.status === "ok",
      campaignId: body.campaignId,
      turnId: body.turnId,
    };
  },

  async "agent.parseClassification"(input) {
    const raw = objectValue(input.raw);
    const allowedKinds = Array.isArray(input.allowedKinds) ? input.allowedKinds.map(String) : [];
    const kind = typeof raw.kind === "string" && allowedKinds.includes(raw.kind) ? raw.kind : "summary";
    return {
      kind,
      reason: typeof raw.reason === "string" ? raw.reason : "No reason supplied.",
      confidence: clampConfidence(raw.confidence),
      parsedAt: new Date().toISOString(),
    };
  },

  async "agent.parseParagraphAnalysis"(input) {
    const raw = objectValue(input.raw);
    const paragraph = objectValue(input.paragraph);
    const keyPoints = Array.isArray(raw.keyPoints)
      ? raw.keyPoints.map(String).filter(Boolean)
      : [];
    return {
      paragraphNumber: Number(paragraph.number ?? input.paragraphNumber ?? 2),
      paragraphText: typeof paragraph.text === "string" ? paragraph.text : "",
      summary: typeof raw.summary === "string" ? raw.summary : "No summary supplied.",
      sentiment: typeof raw.sentiment === "string" ? raw.sentiment : "unknown",
      keyPoints,
      actionRequired: Boolean(raw.actionRequired),
      confidence: clampConfidence(raw.confidence),
      parsedAt: new Date().toISOString(),
    };
  },

  async "route.byKind"(input) {
    const kind = String(input.kind ?? "");
    return {
      routedTo: kind === "clarification" ? "ask-user" : "continue",
      priority: kind === "decision" ? "normal" : "low",
    };
  },

  async "daily.fetchTowerPgContext"(input) {
    const towerBaseUrl = getText(input.towerBaseUrl ?? input.baseUrl ?? input.towerUrl);
    const workspaceId = getText(input.workspaceId ?? input.workspace_id);
    if (!towerBaseUrl || !workspaceId) {
      return {
        fetched: false,
        reason: "towerBaseUrl and workspaceId are required to fetch Tower PG daily note context.",
        dailyNotes: Array.isArray(input.dailyNotes) ? input.dailyNotes : [],
        dailyNote: input.dailyNote ?? null,
        recentTaskChanges: Array.isArray(input.recentTaskChanges) ? input.recentTaskChanges : [],
      };
    }

    const appNpub = getText(input.appNpub ?? input.app_npub);
    const noteDate = getText(input.noteDate ?? input.note_date) ?? new Date().toISOString().slice(0, 10);
    const params = new URLSearchParams({ note_date: noteDate, limit: String(positiveInteger(input.dailyNoteLimit, 5, 50)) });
    const dailyNotesPayload = await fetchTowerPgJson(
      towerBaseUrl,
      `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/daily-notes?${params.toString()}`,
      appNpub,
    );
    const dailyNotes = Array.isArray(dailyNotesPayload.daily_notes) ? dailyNotesPayload.daily_notes : [];

    const taskLimit = positiveInteger(input.taskLimit, 50, 200);
    const taskPayloads: unknown[] = [];
    const channelIds = getStringArray(input.channelIds ?? input.channel_ids);
    const scopeIds = getStringArray(input.scopeIds ?? input.scope_ids);
    for (const channelId of channelIds.slice(0, 8)) {
      const payload = await fetchTowerPgJson(
        towerBaseUrl,
        `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/tasks?limit=${taskLimit}`,
        appNpub,
      );
      taskPayloads.push(...(Array.isArray(payload.tasks) ? payload.tasks : []));
    }
    for (const scopeId of scopeIds.slice(0, 8)) {
      const payload = await fetchTowerPgJson(
        towerBaseUrl,
        `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/scopes/${encodeURIComponent(scopeId)}/tasks?limit=${taskLimit}`,
        appNpub,
      );
      taskPayloads.push(...(Array.isArray(payload.tasks) ? payload.tasks : []));
    }

    const recentTaskChanges = taskPayloads.length > 0
      ? Array.from(new Map(taskPayloads.map((task) => {
        const row = objectValue(task);
        return [getText(row.id ?? row.record_id) ?? JSON.stringify(row), row];
      })).values())
      : (Array.isArray(input.recentTaskChanges) ? input.recentTaskChanges : []);

    return {
      fetched: true,
      noteDate,
      dailyNotes,
      dailyNote: dailyNotes[0] ?? input.dailyNote ?? null,
      recentTaskChanges,
      source: {
        towerBaseUrl,
        workspaceId,
        appNpub,
        channelIds,
        scopeIds,
      },
    };
  },

  async "daily.extractMorningScope"(input) {
    const transcript = getText(input.transcript ?? input.text ?? input.note) ?? "";
    const existing = objectValue(input.existingDailyScope ?? input.existing_daily_scope ?? input.dailyNote);
    const existingItems = Array.isArray(existing.items) ? existing.items.map((item) => objectValue(item)) : [];
    const completed = existingItems
      .filter((item) => item.completed === true && getText(item.text))
      .map((item) => ({
        id: getText(item.id) ?? crypto.randomUUID(),
        text: getText(item.text)!,
        completed: true,
        source: getText(item.source) ?? "manual",
      }));
    const candidates = transcript
      .split(/\n|[.;]/)
      .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((line) => line.length > 6)
      .filter((line) => /\b(ship|finish|call|review|write|send|deploy|decide|plan|fix|meet|follow up|prepare|publish|test)\b/i.test(line))
      .slice(0, 8);
    const newItems = candidates.map((text) => ({
      id: crypto.randomUUID(),
      text: truncateText(text, 140),
      completed: false,
      source: "agent",
    }));
    const byText = new Map<string, Record<string, unknown>>();
    for (const item of [...completed, ...newItems]) {
      const key = String(item.text).toLowerCase();
      if (!byText.has(key)) byText.set(key, item);
    }
    const items = Array.from(byText.values()).slice(0, 5);
    return {
      ownerNpub: getText(input.ownerNpub ?? input.owner_npub) ?? null,
      noteDate: getText(input.noteDate ?? input.note_date) ?? new Date().toISOString().slice(0, 10),
      body: transcript ? truncateText(transcript.replace(/\s+/g, " ").trim(), 2000) : getText(existing.body) ?? "",
      items,
      confidence: transcript ? 0.62 : 0.2,
      parkedItems: candidates.slice(5),
    };
  },

  async "daily.upsertTowerPgScope"(input) {
    const towerBaseUrl = getText(input.towerBaseUrl ?? input.baseUrl ?? input.towerUrl);
    const workspaceId = getText(input.workspaceId ?? input.workspace_id);
    if (!towerBaseUrl || !workspaceId) {
      return { status: "failed", error: "towerBaseUrl and workspaceId are required" };
    }
    const appNpub = getText(input.appNpub ?? input.app_npub);
    const noteDate = getText(input.noteDate ?? input.note_date) ?? new Date().toISOString().slice(0, 10);
    const body = {
      note_date: noteDate,
      title: getText(input.title) ?? "Daily Scope",
      body: getText(input.body ?? input.narrative) ?? "",
      focus: getText(input.focus) ?? "",
      items: Array.isArray(input.items) ? input.items.slice(0, 5) : [],
      status: "active",
      ...(getText(input.ownerActorId ?? input.owner_actor_id) ? { owner_actor_id: getText(input.ownerActorId ?? input.owner_actor_id) } : {}),
      ...(getText(input.ownerNpub ?? input.owner_npub) ? { owner_npub: getText(input.ownerNpub ?? input.owner_npub) } : {}),
      metadata: {
        source: "agent",
        autopilot_pipeline_daily_scope: true,
        ...objectValue(input.metadata),
      },
    };
    const payload = await postTowerPgJson(
      towerBaseUrl,
      `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/daily-notes`,
      body,
      appNpub,
    );
    return {
      status: "ok",
      dailyNote: payload.daily_note ?? null,
      noteDate,
    };
  },

  async "daily.evaluateProgress"(input) {
    const candidateNotes = Array.isArray(input.dailyNotes) ? input.dailyNotes : [];
    const noteDate = getText(input.noteDate);
    const selectedByDate = noteDate && candidateNotes.length > 0
      ? candidateNotes.find((noteCandidate) => {
        const candidate = normaliseDailyNote(noteCandidate);
        return candidate.noteDate === noteDate;
      })
      : null;
    const dailyNoteInput = input.dailyNote
      ?? input.daily_note
      ?? input.note
      ?? input.record
      ?? selectedByDate
      ?? candidateNotes[0]
      ?? null;
    const note = normaliseDailyNote(dailyNoteInput);
    const taskChangesInput = input.recentTaskChanges ?? input.taskChanges;
    const recentTaskChanges: unknown[] = Array.isArray(taskChangesInput) ? taskChangesInput : [];
    const progress = evaluateDailyNoteProgress(note, recentTaskChanges);
    const recentActivitySummary = recentTaskChanges
      .slice(0, 8)
      .map((task) => {
        const row = objectValue(task);
        const title = getText(row.title);
        const state = getText(row.state ?? row.status);
        return { task: title || getText(row.record_id), state: state || "new" };
      })
      .filter((entry) => entry.task);

    const needsReminder = progress.reviewStatus !== "on_track" || (progress.totalItems > 0 && progress.completed < Math.max(1, progress.totalItems));
    const focus = note.focus || note.title || "Today’s focus";
    const completedPct = `${Math.round(progress.completionRatio * 100)}%`;
    const gentleReminder = needsReminder
      ? `Gentle reminder for ${focus}: progress is at ${completedPct} with ${progress.completed}/${progress.totalItems} items complete.`
      : "";

    return {
      assessedAt: new Date().toISOString(),
      note: {
        recordId: note.recordId,
        noteDate: note.noteDate,
        title: note.title,
        focus,
        status: note.status,
        recordState: note.recordState,
      },
      progress,
      recentActivity: {
        count: recentTaskChanges.length,
        updates: recentActivitySummary,
      },
      needsReminder,
      gentleReminder: gentleReminder || null,
      summary: {
        status: progress.reviewStatus,
        completedPct,
        hasRecentActivity: progress.hasRecentActivity,
      },
      confidence: clampConfidence(
        note.recordState === "deleted" ? 0.95 : 0.8
      ),
    };
  },

  async "dispatch.publishFlightDeckResponse"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "flightdeck_publish",
      reason: "This function only publishes when the pipeline is launched by a Wingman dispatch route.",
      agentResponse: input.agentResponse ?? null,
    };
  },

  async "dispatch.hydrateChatContext"(input) {
    return {
      hydrated: false,
      status: "not_configured",
      operation: "chat.hydrate-context",
      reason: "This function only hydrates chat context when the pipeline is launched by a Wingman dispatch route.",
      chat: input.chat ?? null,
    };
  },

  async "dispatch.reloadChatThread"(input) {
    return {
      hydrated: false,
      status: "not_configured",
      operation: "chat.reload-thread",
      reason: "This function only re-reads chat context when the pipeline is launched by a Wingman dispatch route.",
      chatContext: input.chatContext ?? null,
    };
  },

  async "dispatch.setResponseActivity"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "chat.set-response-activity",
      reason: "This function only updates Flight Deck response activity when the pipeline is launched by a Wingman dispatch route.",
      activity: {
        status: input.status ?? null,
        label: input.label ?? null,
        expiresInSeconds: input.expiresInSeconds ?? null,
      },
    };
  },

  async "dispatch.ensureDiscussionDocument"(input) {
    return {
      ensured: false,
      status: "not_configured",
      operation: "docs.ensure-discussion-document",
      reason: "This function only creates or reuses discussion documents when the pipeline is launched by a Wingman dispatch route.",
      documentContext: input.documentContext ?? null,
    };
  },

  async "dispatch.prepareDocumentInvocationContext"(input) {
    return {
      status: "not_configured",
      operation: "docs.prepare-document-invocation",
      reason: "This function only prepares document invocation context when the pipeline is launched by a Wingman dispatch route.",
      invocation: objectValue(objectValue(input.record).payload),
    };
  },

  async "dispatch.publishDocumentInvocationSummary"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "docs.publish-document-invocation-summary",
      reason: "This function only publishes document invocation summaries when the pipeline is launched by a Wingman dispatch route.",
      agentResult: input.agentResult ?? null,
    };
  },

  async "dispatch.prepareTaskInvocationContext"(input) {
    return {
      status: "not_configured",
      operation: "tasks.prepare-task-invocation",
      reason: "This function only prepares task invocation context when the pipeline is launched by a Wingman dispatch route.",
      invocation: objectValue(objectValue(input.record).payload),
    };
  },

  async "dispatch.normaliseTaskInvocationPlan"(input) {
    const context = objectValue(input.invocationContext);
    const task = objectValue(context.task);
    const invocation = objectValue(context.invocation);
    const location = objectValue(context.location);
    const response = objectValue(input.agentResponse ?? input.decision ?? input);
    const taskId = getText(task.taskId ?? response.taskId);
    const taskTitle = getText(task.title ?? response.taskTitle) ?? "Flight Deck task";
    const prompt = getText(invocation.prompt) ?? "";
    const rawAction = getText(response.action ?? response.intent ?? response.classification)?.toLowerCase();
    const requestedStyle = getText(response.workStyle ?? response.pipelineStyle ?? response.recommendedPipeline)?.toLowerCase() ?? "";
    const requestedPipeline = getText(response.childPipelineDefinitionId ?? response.pipelineDefinitionId ?? response.recommendedPipelineId);
    const directAction = rawAction === "direct_response"
      || rawAction === "answer_on_task"
      || rawAction === "comment_on_task"
      || rawAction === "needs_input"
      || rawAction === "ignore";
    const workStyle = requestedStyle.includes("software") || requestedStyle.includes("implementation") || /software|implementation|code|bug|fix|repo|build|deploy|ui|api|database/.test(requestedStyle)
      ? "software_implementation"
      : requestedStyle.includes("research") || requestedStyle.includes("report")
        ? "research_and_report"
        : requestedStyle.includes("generic") || requestedStyle.includes("do")
          ? "do_and_review"
          : requestedPipeline
            ? "custom_pipeline"
            : null;
    const childPipelineDefinitionId = requestedPipeline
      ?? (workStyle === "software_implementation"
        ? "software-implementation-review-loop"
        : workStyle === "research_and_report"
          ? "research-and-report"
          : workStyle === "do_and_review"
            ? "do-and-review"
            : null);
    const action = directAction
      ? (rawAction === "needs_input" ? "needs_input" : rawAction === "ignore" ? "ignore" : "direct_response")
      : childPipelineDefinitionId
        ? "start_pipeline"
        : "direct_response";
    const taskSummary = getText(response.taskSummary ?? response.summary)
      ?? `Task invocation for ${taskTitle}`;
    const instructions = getText(response.instructions ?? response.implementationPrompt ?? response.taskInstructions)
      ?? prompt
      ?? taskSummary;
    const workdir = getText(response.workdir ?? response.workingDirectory);
    const workPlan = {
      taskId,
      taskTitle,
      taskSummary,
      instructions,
      originalPrompt: prompt,
      acceptanceCriteria: getStringArray(response.acceptanceCriteria),
      executionPlan: getStringArray(response.executionPlan),
      managerChecklist: getStringArray(response.managerChecklist),
      initialFindings: getStringArray(response.initialFindings),
      workStyle: workStyle ?? getText(response.workStyle),
      childPipelineDefinitionId,
      pipelineDefinitionId: childPipelineDefinitionId,
      scopeId: getText(location.scopeId),
      workdir,
      targetSurface: objectValue(response.targetSurface),
      visualReferences: Array.isArray(response.visualReferences) ? response.visualReferences.slice(0, 8) : [],
      designDocumentUrl: getText(response.designDocumentUrl ?? response.referenceDocumentUrl),
      designDocumentUnavailableReason: getText(response.designDocumentUnavailableReason),
      assignerNpub: getText(invocation.requesterNpub),
      reviewerNpub: getText(invocation.requesterNpub),
      origin: {
        kind: "flightdeck_task",
        triggerKind: "task",
        taskId,
        channelId: getText(location.channelId),
        messageId: getText(invocation.invocationId),
      },
      reporting: {
        mode: "flightdeck_task",
      },
      invocation: {
        invocationId: getText(invocation.invocationId),
        prompt,
      },
    };
    return {
      accepted: response.accepted !== false,
      status: response.accepted === false ? "rejected" : "ok",
      action,
      shouldStartChild: action === "start_pipeline" && Boolean(childPipelineDefinitionId),
      shouldComment: action !== "ignore",
      taskId,
      taskTitle,
      taskSummary,
      workStyle,
      childPipelineDefinitionId,
      pipelineDefinitionId: childPipelineDefinitionId,
      workPlan,
      taskComment: getText(response.taskComment ?? response.responseDraft ?? response.replyDraft ?? response.commentDraft ?? response.summary),
      summary: taskSummary,
      blockers: getStringArray(response.blockers),
      openQuestions: getStringArray(response.openQuestions ?? response.questions),
      confidence: clampConfidence(response.confidence),
    };
  },

  async "dispatch.publishTaskInvocationResponse"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.publish-task-invocation-response",
      reason: "This function only comments on task invocations when the pipeline is launched by a Wingman dispatch route.",
      plan: input.plan ?? null,
    };
  },

  async "dispatch.prepareChatIntentInput"(input) {
    const dispatch = objectValue(input.dispatch);
    const workspace = objectValue(input.workspace);
    const agent = objectValue(input.agent);
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const routing = objectValue(input.routing);
    const runtime = objectValue(input.runtime);
    const chatContext = objectValue(input.chatContext);
    const latestThread = latestThreadWithTrigger(chatContext, record, chat);
    const channelContext = resolveFlightDeckChannelContext(chatContext.channelContext, input.flightDeckContext);
    const scopes = extractScopeRecords(chatContext.scopes)
      .map(compactScope)
      .filter((scope) => Boolean(scope.id));
    const referencedRecords = Array.isArray(chatContext.referencedRecords)
      ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
      : [];
    const requesterNpub = getText(chat.senderNpub)
      ?? getText(objectValue(record.payload).sender_npub)
      ?? getText(record.updaterNpub);
    const workroomContext = objectValue(input.workroomContext);
    const isWorkroom = workroomContext.isWorkroom === true;
    const participant = objectValue(workroomContext.participant);
    const role = getText(participant.role);
    const workroomInstruction = isWorkroom
      ? `Workroom mode is strict. The participant role is ${role ?? "unassigned"}. Follow only that role: integration coordinates PRs, integration branch, app targets, approvals, and deploy/restart requests; contributor creates scoped work, PRs, validation, preview links, and PR-ready events; reviewer inspects PRs, tests, preview links, and writes review evidence; approver focuses on approval decisions and does not implement; observer answers only when directly asked or mentioned.`
      : null;

    return {
      objective: "Classify the latest chat request and decide whether to start a downstream work pipeline.",
      source: {
        routeId: getText(dispatch.routeId),
        triggerKind: getText(dispatch.triggerKind) ?? "chat",
        channelId: getText(chat.channelId ?? routing.channelId ?? chatContext.channelId),
        threadId: getText(chat.threadId ?? routing.threadId ?? chatContext.threadId),
        messageId: getText(record.recordId),
        requesterNpub,
      },
      selfCheck: {
        shouldProceed: chatContext.shouldProceed !== false,
        selfAuthored: chatContext.selfAuthored === true,
        suppressionReason: getText(chatContext.suppressionReason),
        matchedSelfNpub: getText(chatContext.matchedSelfNpub),
        botNpub: getText(agent.botNpub),
        workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub),
        sourceAppNpub: getText(workspace.sourceAppNpub),
      },
      defaults: {
        workdir: getText(agent.workingDirectory),
        defaultAgent: getText(agent.defaultAgent),
        assignerNpub: requesterNpub,
        reviewerNpub: requesterNpub,
      },
      latestThread,
      channelContext,
      referencedRecords,
      scopes,
      ...(isWorkroom ? { workroomContext, workroomInstruction } : {}),
      notes: [
        "Use latestThread as the authoritative current conversation.",
        "Use channelContext.contextPrompt as channel-specific instructions for how this work should be handled.",
        "Use referencedRecords only as supporting Flight Deck context.",
        "Classify only as answer_now, think_then_answer, create_task, or ignore.",
        "Use answer_now only when chatResponse.body is the complete final reply.",
        "Use think_then_answer when the final output is still a chat answer but needs reasoning, context loading, lookup, or multiple internal steps.",
        "Use create_task only for durable output such as code, docs, files, WApp changes, migrations, configuration, or other concrete artifacts.",
        "For create_task, provide a compact taskDraft with title, instructions, acceptanceCriteria, executionPlan, and managerChecklist when enough information is available.",
        "Do not choose a child pipeline in this stage.",
        ...(workroomInstruction ? [workroomInstruction, "Use typed workroom fields for role, room, repo, branches, app targets, runbooks, recent events/links, and approvals; do not infer missing authority from prose."] : []),
      ],
    };
  },

  async "workroom.prepareParticipantMetadata"(input) {
    const workroomContext = objectValue(input.workroomContext);
    if (workroomContext.isWorkroom !== true) {
      return { isWorkroom: false, metadata: null, status: "not_applicable" };
    }
    const agent = objectValue(input.agent);
    const runtime = objectValue(input.runtime);
    const workspace = objectValue(input.workspace);
    const participant = objectValue(workroomContext.participant);
    const metadata = {
      repoPath: getText(agent.workingDirectory),
      defaultBranch: getText(agent.defaultBranch) ?? "main",
      capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.filter((item): item is string => typeof item === "string") : [],
      localApps: Array.isArray(agent.localApps) ? agent.localApps : [],
      constraints: objectValue(agent.constraints),
      canRunTests: Boolean(agent.canRunTests ?? true),
      runtime: getText(runtime.mode),
    };
    const result = {
      isWorkroom: true,
      metadata,
      status: "structured",
      workroomId: getText(objectValue(workroomContext.workroom).id),
    };
    if (input.persist !== true || participant.metadataStatus === "valid" || !result.workroomId) return result;
    const towerBaseUrl = getText(workspace.backendBaseUrl ?? workspace.towerBaseUrl ?? workspace.baseUrl);
    const workspaceId = getText(workspace.workspaceId ?? workspace.workspace_id);
    const appNpub = getText(workspace.sourceAppNpub ?? workspace.appNpub ?? workspace.app_npub);
    if (!towerBaseUrl || !workspaceId || !appNpub) {
      return { ...result, status: "structured_not_persisted", persistence: { status: "missing_connection" } };
    }
    try {
      const persisted = await patchTowerPgJson(
        towerBaseUrl,
        `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(result.workroomId)}/participant`,
        { metadata },
        appNpub,
      );
      return { ...result, status: "persisted", persistence: { status: "ok", response: persisted } };
    } catch (error) {
      const status = error instanceof Error && /\(404\)|\(405\)|\(501\)/.test(error.message) ? "endpoint_unavailable" : "failed";
      return { ...result, status: "structured_not_persisted", persistence: { status, reason: error instanceof Error ? error.message : String(error) } };
    }
  },

  async "dispatch.prepareShortLookupAnswer"(input) {
    const workspace = objectValue(input.workspace);
    const packet = objectValue(input.chatDispatchInput);
    const latestThread = Array.isArray(packet.latestThread)
      ? packet.latestThread.map((message) => objectValue(message))
      : [];
    const latestMessage = objectValue(latestThread.at(-1));
    const latestText = getText(latestMessage.body ?? latestMessage.text ?? latestMessage.messageText) ?? "";
    const normalized = latestText.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

    if (/^(hey|hi|hello|yo|hiya|gm|good morning|good afternoon|good evening)$/.test(normalized)) {
      return {
        skipAgent: true,
        intent: "answer_now",
        dispatchTask: false,
        recommendedPipelineId: null,
        taskDraft: null,
        chatResponse: { body: "Hello." },
        clarifyingQuestion: null,
        confidence: 0.99,
        shortLookup: { kind: "greeting" },
      };
    }

    const focusLookup = /\b(focus|priority|priorities|daily scope|what should (i|we) work on|what are we working on|where should (i|we) focus|what'?s next|what is next)\b/.test(normalized)
      && /\b(today|now|current|this morning|this afternoon|right now|next)\b/.test(normalized);
    const statusLookup = /\b(where are we at|where are we up to|current status|status today|what'?s our status)\b/.test(normalized);
    if (!focusLookup && !statusLookup) {
      return {
        skipAgent: false,
        intent: "needs_classification",
        dispatchTask: false,
        chatResponse: { body: "" },
        confidence: 0.5,
      };
    }

    const towerBaseUrl = getText(workspace.backendBaseUrl ?? workspace.towerBaseUrl ?? workspace.baseUrl);
    const workspaceId = getText(workspace.workspaceId ?? workspace.workspace_id);
    const appNpub = getText(workspace.sourceAppNpub ?? workspace.appNpub ?? workspace.app_npub);
    if (!towerBaseUrl || !workspaceId) {
      return {
        skipAgent: true,
        intent: "answer_now",
        dispatchTask: false,
        recommendedPipelineId: null,
        taskDraft: null,
        chatResponse: {
          body: "I can answer that from Daily Scope, but I do not have the Flight Deck PG workspace connection details in this dispatch context.",
        },
        clarifyingQuestion: null,
        confidence: 0.8,
        shortLookup: { kind: "daily_focus", fetched: false, reason: "missing_workspace_context" },
      };
    }

    const noteDate = new Date().toISOString().slice(0, 10);
    try {
      const params = new URLSearchParams({ note_date: noteDate, limit: "1" });
      const payload = await fetchTowerPgJson(
        towerBaseUrl,
        `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/daily-notes?${params.toString()}`,
        appNpub,
      );
      const notes = Array.isArray(payload.daily_notes) ? payload.daily_notes : [];
      const note = normaliseDailyNote(notes[0] ?? null);
      if (!note.recordId && !note.focus && !note.title && !note.body) {
        return {
          skipAgent: true,
          intent: "answer_now",
          dispatchTask: false,
          recommendedPipelineId: null,
          taskDraft: null,
          chatResponse: {
            body: `I do not see a Daily Scope for ${noteDate} yet, so I do not have a reliable focus signal from Flight Deck.`,
          },
          clarifyingQuestion: null,
          confidence: 0.78,
          shortLookup: { kind: "daily_focus", fetched: true, noteDate, found: false },
        };
      }

      const openItems = note.items
        .filter((item) => item.status !== "completed")
        .slice(0, 4)
        .map((item) => item.title)
        .filter(Boolean);
      const completedItems = note.items.filter((item) => item.status === "completed").length;
      const focus = note.focus || note.title || "today's Daily Scope";
      const itemLine = openItems.length > 0
        ? `\n\nOpen items I can see:\n${openItems.map((item) => `- ${item}`).join("\n")}`
        : "";
      const progressLine = note.items.length > 0
        ? `\n\nProgress: ${completedItems}/${note.items.length} Daily Scope items complete.`
        : "";
      const body = `Today's focus is: ${focus}.${itemLine}${progressLine}`;
      return {
        skipAgent: true,
        intent: "answer_now",
        dispatchTask: false,
        recommendedPipelineId: null,
        taskDraft: null,
        chatResponse: { body },
        clarifyingQuestion: null,
        confidence: 0.9,
        shortLookup: {
          kind: "daily_focus",
          fetched: true,
          noteDate,
          found: true,
          dailyNoteId: note.recordId,
        },
      };
    } catch (error) {
      return {
        skipAgent: true,
        intent: "answer_now",
        dispatchTask: false,
        recommendedPipelineId: null,
        taskDraft: null,
        chatResponse: {
          body: `I tried to read today's Daily Scope, but Flight Deck returned an error: ${truncateText(error instanceof Error ? error.message : String(error), 220)}`,
        },
        clarifyingQuestion: null,
        confidence: 0.72,
        shortLookup: {
          kind: "daily_focus",
          fetched: false,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },

  async "dispatch.prepareChatTaskPipelineInput"(input) {
    const dispatch = objectValue(input.dispatch);
    const workspace = objectValue(input.workspace);
    const agent = objectValue(input.agent);
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const runtime = objectValue(input.runtime);
    const chatContext = objectValue(input.chatContext);
    const decision = objectValue(input.decision);
    const latestThread = latestThreadWithTrigger(chatContext, record, chat);
    const channelContext = resolveFlightDeckChannelContext(chatContext.channelContext, input.flightDeckContext);
    const channelWorkdir = resolveRepoWorkdirFromHighSignalText(getText(channelContext.contextPrompt));
    const defaultWorkdir = channelWorkdir ?? getText(agent.workingDirectory);
    const promptTokens = tokenizeForMatch([
      latestThread.map((message) => getText(message.body)).filter(Boolean).join(" "),
      getText(objectValue(decision.taskDraft).title),
      getText(objectValue(decision.taskDraft).instructions),
    ].filter(Boolean).join(" "));
    const rawPipelines = Array.isArray(runtime.availablePipelines)
      ? runtime.availablePipelines
      : Array.isArray(chatContext.availablePipelines)
        ? chatContext.availablePipelines
        : [];
    const validChildPipelines = rawPipelines
      .map((pipeline) => compactPipelineDefinition(pipeline, promptTokens))
      .filter((pipeline): pipeline is JsonObject => Boolean(pipeline))
      .sort((a, b) => {
        const aSlug = getText(a.slug)?.toLowerCase() ?? "";
        const bSlug = getText(b.slug)?.toLowerCase() ?? "";
        const aCore = coreChatChildPipelineSlugs.has(aSlug) ? 0 : 1;
        const bCore = coreChatChildPipelineSlugs.has(bSlug) ? 0 : 1;
        return aCore - bCore || aSlug.localeCompare(bSlug);
      })
      .slice(0, 8);

    return {
      objective: "Select the downstream task pipeline for a durable chat request.",
      source: {
        routeId: getText(dispatch.routeId),
        triggerKind: getText(dispatch.triggerKind) ?? "chat",
        channelId: getText(chat.channelId),
        threadId: getText(chat.threadId),
        messageId: getText(record.recordId),
      },
      workspace: {
        workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub),
        sourceAppNpub: getText(workspace.sourceAppNpub),
      },
      defaults: {
        workdir: isPlaceholderSoftwareWorkdir(defaultWorkdir) ? null : defaultWorkdir,
        defaultAgent: getText(agent.defaultAgent),
      },
      intent: getText(decision.intent) ?? "create_task",
      taskDraft: objectValue(decision.taskDraft),
      latestThread,
      channelContext,
      referencedRecords: Array.isArray(chatContext.referencedRecords)
        ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
        : [],
      validChildPipelines,
      notes: [
        "Choose only a task-capable pipeline listed in validChildPipelines.",
        "Use channelContext.contextPrompt as channel-specific instructions for how this work should be handled.",
        "Use software-implementation-review-loop for code, repository, build, test, deployment, or implementation work.",
        "For software-implementation-review-loop, return targetSurface with the exact repo/workdir, route or surface, existing files/selectors to modify, forbidden surfaces, and visualReferences from thread attachments or linked Flight Deck files when present.",
        "Use research-and-report when the requested durable output is explicitly research with a report or document.",
        "Use do-and-review for generic durable work when no specialised task pipeline fits.",
        "Do not choose any agent-dispatch, intake, discussion, or chat-only pipeline.",
      ],
    };
  },

  async "dispatch.prepareDocumentDiscussionContext"(input) {
    const dispatch = objectValue(input.dispatch);
    const workspace = objectValue(input.workspace);
    const agent = objectValue(input.agent);
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const routing = objectValue(input.routing);
    const runtime = objectValue(input.runtime);
    const chatContext = objectValue(input.chatContext);
    const originalChatContext = objectValue(input.originalChatContext);
    const decision = objectValue(input.decision);
    const workPlan = objectValue(input.workPlan ?? decision.discussionWorkPlan);
    const parentDispatch = objectValue(input.parentDispatch);
    const latestThread = latestThreadWithTrigger(chatContext, record, chat);
    const channelContext = resolveFlightDeckChannelContext(chatContext.channelContext, originalChatContext.channelContext, input.flightDeckContext);
    const referencedRecords = Array.isArray(chatContext.referencedRecords)
      ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
      : Array.isArray(originalChatContext.referencedRecords)
        ? originalChatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
        : [];
    const scopes = extractScopeRecords(chatContext.scopes)
      .map(compactScope)
      .filter((scope) => Boolean(scope.id));
    const payload = objectValue(record.payload);
    const requesterNpub = getText(chat.senderNpub ?? payload.sender_npub ?? record.updaterNpub);
    const source = {
      routeId: getText(dispatch.routeId),
      triggerKind: getText(dispatch.triggerKind) ?? "chat",
      channelId: getText(chat.channelId ?? routing.channelId ?? chatContext.channelId),
      threadId: getText(chat.threadId ?? routing.threadId ?? chatContext.threadId),
      messageId: getText(record.recordId ?? record.record_id ?? payload.record_id),
      requesterNpub,
    };
    return {
      objective: "Iterate a Flight Deck document from the latest chat thread without creating a task.",
      source,
      workspace: {
        workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub),
        humanWorkspaceOwnerNpub: getText(workspace.humanWorkspaceOwnerNpub),
        workspaceId: getText(workspace.workspaceId),
        sourceAppNpub: getText(workspace.sourceAppNpub),
        backendBaseUrl: getText(workspace.backendBaseUrl),
      },
      agent: {
        botNpub: getText(agent.botNpub),
        workdir: getText(agent.workingDirectory),
        defaultAgent: getText(agent.defaultAgent),
      },
      runtime: {
        mode: getText(runtime.mode),
        error: getText(runtime.error),
      },
      selfCheck: {
        shouldProceed: chatContext.shouldProceed !== false,
        selfAuthored: chatContext.selfAuthored === true,
        suppressionReason: getText(chatContext.suppressionReason),
        matchedSelfNpub: getText(chatContext.matchedSelfNpub),
      },
      latestThread,
      channelContext,
      referencedRecords,
      scopes,
      decision: {
        intent: getText(decision.intent),
        recommendedPipelineId: getText(decision.recommendedPipelineId),
        responseDraft: compactText(decision.responseDraft ?? objectValue(decision.chatResponse).body, 1000),
        confidence: typeof decision.confidence === "number" ? decision.confidence : null,
      },
      workPlan: {
        title: compactText(workPlan.title ?? workPlan.taskSummary, 240),
        taskSummary: compactText(workPlan.taskSummary ?? workPlan.title, 500),
        originalPrompt: compactText(workPlan.originalPrompt, 3000),
        scopeId: getText(workPlan.scopeId),
        channelId: getText(workPlan.channelId ?? objectValue(workPlan.origin).channelId ?? source.channelId),
        threadId: getText(workPlan.threadId ?? objectValue(workPlan.origin).threadId ?? source.threadId),
        messageId: getText(workPlan.messageId ?? objectValue(workPlan.origin).messageId ?? source.messageId),
        documentReference: objectValue(workPlan.documentReference),
        referencedRecords: Array.isArray(workPlan.referencedRecords)
          ? workPlan.referencedRecords.slice(0, 12).map(compactReferencedRecord)
          : referencedRecords,
        acceptanceCriteria: Array.isArray(workPlan.acceptanceCriteria) ? workPlan.acceptanceCriteria.slice(0, 8).map((item) => compactText(item, 500)) : [],
        executionPlan: Array.isArray(workPlan.executionPlan) ? workPlan.executionPlan.slice(0, 8).map((item) => compactText(item, 500)) : [],
      },
      parentDispatch: {
        pipelineRunId: getText(parentDispatch.pipelineRunId ?? parentDispatch.runId),
        pipelineName: getText(parentDispatch.pipelineName ?? parentDispatch.name),
      },
      notes: [
        "Use latestThread as the authoritative current conversation.",
        "Use channelContext.contextPrompt as the channel-specific instruction.",
        "Use referencedRecords and document mentions to find the working Flight Deck document.",
        "Do not create a task. Use current Flight Deck PG helpers for Flight Deck work.",
      ],
    };
  },

  async "dispatch.detectChatReviewApproval"(input) {
    const chatContext = objectValue(input.chatContext);
    const text = latestThreadText(chatContext, objectValue(input.chat).messageText ?? objectValue(objectValue(input.record).payload).body);
    const candidates = Array.isArray(chatContext.referencedRecords)
      ? chatContext.referencedRecords.filter(isTaskInReview).map(compactReferencedRecord)
      : [];
    if (!isApprovalText(text)) {
      return {
        shouldComplete: false,
        status: "not_approval",
        reason: "Latest chat message is not a review approval.",
        candidateTaskCount: candidates.length,
      };
    }
    if (candidates.length !== 1) {
      return {
        shouldComplete: false,
        status: candidates.length === 0 ? "no_review_task" : "ambiguous_review_task",
        reason: candidates.length === 0
          ? "Approval text found, but no linked review task was available."
          : "Approval text found, but multiple linked review tasks were available.",
        candidateTaskCount: candidates.length,
        candidates,
        responseDraft: candidates.length > 1
          ? "Which review task should I mark done?"
          : null,
      };
    }
    const task = candidates[0]!;
    return {
      shouldComplete: true,
      status: "approval_detected",
      reason: "Latest chat message approves the single linked review task.",
      taskId: getText(task.recordId),
      taskTitle: getText(task.title) ?? "review task",
      responseDraft: `Done, I'll mark ${mention("task", getText(task.recordId) ?? "task", getText(task.title) ?? "review task")} complete.`,
      evidence: text,
    };
  },

  async "dispatch.completeReviewTaskFromChat"(input) {
    return {
      completed: false,
      status: "not_configured",
      operation: "tasks.complete-review-from-chat",
      reason: "This function only completes review tasks when the pipeline is launched by a Wingman dispatch route.",
      reviewApproval: input.reviewApproval ?? null,
    };
  },

  async "dispatch.routeDiscussionChat"(input) {
    const decision = objectValue(input.decision);
    const raw = objectValue(input.agentDecision);
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const routing = objectValue(input.routing);
    const workspace = objectValue(input.workspace);
    const agent = objectValue(input.agent);
    const chatContext = objectValue(input.chatContext);
    const chatDispatchInput = objectValue(input.chatDispatchInput);
    const channelContext = resolveFlightDeckChannelContext(chatDispatchInput.channelContext, chatContext.channelContext, input.flightDeckContext);
    const payload = objectValue(record.payload);
    const thread = Array.isArray(chatDispatchInput.latestThread) && chatDispatchInput.latestThread.length > 0
      ? chatDispatchInput.latestThread.slice(-12).map(compactThreadMessage)
      : getThreadMessages(chatContext).slice(-12).map(compactThreadMessage);
    const latest = thread[thread.length - 1] ?? {};
    const latestText = getText(latest.body) ?? getText(chat.messageText) ?? getText(payload.body) ?? "";
    const taskDraftInstructions = getText(objectValue(raw.taskDraft).instructions) ?? "";
    const taskLikeDecisionPending = decision.requestedDispatchTask === true
      || decision.taskRoutingPending === true
      || decision.dispatchTask === true;
    const missing = Array.isArray(decision.missing) ? decision.missing : [];
    if (decision.intent === "clarify" || getText(decision.clarifyingQuestion) || missing.length > 0) {
      return decision;
    }
    if (taskLikeDecisionPending && isImplementationRequestText(`${latestText} ${taskDraftInstructions}`)) {
      return decision;
    }
    const rawIntent = getText(raw.intent ?? raw.classification ?? raw.action);
    const rawIntentKey = (rawIntent ?? "").toLowerCase();
    const chatResponseBody = getText(objectValue(raw.chatResponse).body)
      ?? getText(raw.responseDraft)
      ?? getText(raw.replyDraft)
      ?? getText(raw.answer);
    const directChatResponse = Boolean(chatResponseBody)
      && ["direct_chat_response", "direct_chat", "chat_response", "chat", "answer", "reply"].includes(rawIntentKey);
    const selectedPipelineId = getText(
      raw.recommendedPipelineId
        ?? raw.recommendedPipelineDefinitionId
        ?? raw.pipelineDefinitionId
        ?? raw.recommendedPipeline
        ?? decision.pipelineDefinitionId,
    );
    const selectedDiscussionPipeline = isDiscussionPipelineIdentifier(selectedPipelineId);
    const documentDiscussion = isDocumentDiscussionPipelineIdentifier(selectedPipelineId)
      || isDocumentDiscussionIntent(rawIntent, latestText)
      || (isDocumentDiscussionChannelContext(channelContext) && isDocumentDiscussionIntent(rawIntent, `${latestText} ${taskDraftInstructions}`));
    const simpleDirectResponse = Boolean(chatResponseBody)
      && raw.dispatchTask !== true
      && !selectedPipelineId
      && !documentDiscussion
      && isSimpleDirectChatText(latestText);
    if (simpleDirectResponse) {
      return {
        ...decision,
        intent: rawIntent ?? "direct_chat_response",
        dispatchTask: false,
        requestedDispatchTask: false,
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        dispatchDiscussion: false,
        shouldRespond: true,
        responseDraft: chatResponseBody,
        reasoningSummary: "Preserved simple direct chat reply without launching a discussion pipeline.",
      };
    }
    const discussion = (selectedDiscussionPipeline && !directChatResponse)
      || isDiscussionIntent(rawIntent, latestText)
      || documentDiscussion;

    if (!discussion || decision.suppressed === true || chatContext.shouldProceed === false) {
      return decision;
    }

    const source = objectValue(chatDispatchInput.source);
    const channelId = getText(chat.channelId ?? routing.channelId ?? source.channelId);
    const threadId = getText(chat.threadId ?? routing.threadId ?? source.threadId);
    const messageId = getText(record.recordId ?? source.messageId);
    const requesterNpub = getText(chat.senderNpub ?? payload.sender_npub ?? record.updaterNpub ?? source.requesterNpub);
    const pipelineDefinitionId = resolveDiscussionPipelineId(input, raw, decision, latestText, rawIntent);
    const documentBoundDiscussion = isDocumentDiscussionPipelineIdentifier(pipelineDefinitionId);
    const title = documentBoundDiscussion ? "Document discussion" : "Discussion response";
    const taskSummary = documentBoundDiscussion ? "Document-bound discussion response" : "Discussion response";
    const referencedRecords = Array.isArray(chatDispatchInput.referencedRecords)
      ? chatDispatchInput.referencedRecords.slice(0, 12).map(compactReferencedRecord)
      : Array.isArray(chatContext.referencedRecords)
        ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
        : [];
    const documentReference = documentBoundDiscussion
      ? referencedRecords.find(isDocumentReference) ?? null
      : null;
    const responseDraft = documentBoundDiscussion
      ? "Let's discuss that. Give me a minute and I'll pull together a doc so we can work on it together."
      : "Let's discuss that. Give me a minute to pull the context together and I'll reply here.";

    return {
      ...decision,
      intent: "discussion",
      dispatchTask: false,
      dispatchPipeline: true,
      dispatchSingleTaskPipeline: false,
      dispatchSingleDirectPipeline: true,
      pipelinesRequired: false,
      pipelineLaunches: [],
      requestedDispatchTask: false,
      pipelineDefinitionId,
      scopeId: null,
      workdir: null,
      dispatchDiscussion: true,
      discussionPipelineDefinitionId: pipelineDefinitionId,
      taskRoutingPending: false,
      shouldRespond: true,
      responseDraft,
      reasoningSummary: `Starting ${pipelineDefinitionId} without creating a task, while preserving the immediate chat reply.`,
      discussionWorkPlan: {
        pipelineDefinitionId,
        childPipelineDefinitionId: pipelineDefinitionId,
        title,
        taskSummary,
        instructions: documentBoundDiscussion
          ? "Discuss the referenced plan/design/document in chat, inspect thread/document/comment context, update the document when useful, review against the stated goal, and ask the next useful question. Do not create a Flight Deck task."
          : "Discuss, plan, or reason in chat using the latest thread context. Do not create a Flight Deck task.",
        originalPrompt: latestText,
        originThread: thread,
        referencedRecords,
        documentReference,
        origin: {
          triggerKind: "chat",
          channelId,
          threadId,
          messageId,
          requesterNpub,
          workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub),
          sourceAppNpub: getText(workspace.sourceAppNpub),
        },
        workdir: getText(agent.workingDirectory),
      },
      workPlan: {
        pipelineDefinitionId,
        childPipelineDefinitionId: pipelineDefinitionId,
        title,
        taskSummary,
        instructions: documentBoundDiscussion
          ? "Discuss the referenced plan/design/document in chat, inspect thread/document/comment context, update the document when useful, review against the stated goal, and ask the next useful question. Do not create a Flight Deck task."
          : "Discuss, plan, or reason in chat using the latest thread context. Do not create a Flight Deck task.",
        originalPrompt: latestText,
        originThread: thread,
        referencedRecords,
        documentReference,
        origin: {
          triggerKind: "chat",
          channelId,
          threadId,
          messageId,
          requesterNpub,
          workspaceOwnerNpub: getText(workspace.workspaceOwnerNpub),
          sourceAppNpub: getText(workspace.sourceAppNpub),
        },
        workdir: getText(agent.workingDirectory),
      },
      confidence: typeof raw.confidence === "number" ? raw.confidence : decision.confidence ?? 0.7,
    };
  },

  async "dispatch.createChatTask"(input) {
    return {
      created: false,
      status: "not_configured",
      operation: "tasks.create-from-chat",
      reason: "This function only creates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      decision: input.decision ?? null,
    };
  },

  async "dispatch.blockTaskIfPipelineLaunchFailed"(input) {
    return {
      updated: false,
      status: "not_configured",
      operation: "tasks.block-on-pipeline-launch-failure",
      reason: "This function only updates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      childPipeline: input.childPipeline ?? null,
    };
  },

  async "dispatch.publishNeedsInput"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.needs-input",
      reason: "This function only publishes needs-input questions when the pipeline is launched by a Wingman dispatch route.",
      workerResult: input.workerResult ?? input.agentResponse ?? null,
    };
  },

  async "dispatch.markTaskInProgress"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-in-progress",
      reason: "This function only updates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      taskId: input.taskId ?? null,
    };
  },

  async "dispatch.markTaskReadyForReview"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-review",
      reason: "This function only updates Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      taskId: input.taskId ?? null,
    };
  },

  async "dispatch.ensureImplementationReviewTask"(input) {
    return normaliseDispatchWorkPlanContext(input, {
      operation: "implementation-review-context.normalise",
      defaultTaskSummary: "Software implementation",
      taskBackedReason: "Flight Deck task mutation is handled by dispatch route bindings; preserving the supplied implementation work plan for the review loop.",
      directReason: "Direct pipeline launch; no Flight Deck task mutation required.",
    });
  },

  async "dispatch.normaliseWorkPlanContext"(input) {
    return normaliseDispatchWorkPlanContext(input, {
      operation: "work-plan-context.normalise",
      defaultTaskSummary: "Pipeline work",
      taskBackedReason: "Flight Deck task reporting is available; preserving the supplied work plan and enabling Flight Deck closeout.",
      directReason: "Direct pipeline launch; no Flight Deck task reporting required.",
    });
  },

  async "dispatch.validateImplementationContract"(input) {
    const createdTask = objectValue(input.createdTask);
    const workPlan = objectValue(input.workPlan ?? createdTask.workPlan);
    const taskId = getText(input.taskId ?? createdTask.taskId ?? workPlan.taskId);
    const workdir = getText(workPlan.workdir ?? workPlan.workingDirectory ?? input.workingDirectory);
    const instructions = getText(workPlan.instructions ?? input.implementationPrompt);
    const designDocumentUrl = getText(workPlan.designDocumentUrl ?? input.designDocumentUrl);
    const targetSurface = objectValue(workPlan.targetSurface ?? input.targetSurface);
    const targetSurfaceKeys = Object.keys(targetSurface);
    const visualReferences = Array.isArray(workPlan.visualReferences)
      ? workPlan.visualReferences
      : Array.isArray(input.visualReferences)
        ? input.visualReferences
        : [];
    const route = getText(targetSurface.route ?? targetSurface.url ?? targetSurface.path);
    const surfaceAliases = getStringArray(targetSurface.surfaces ?? targetSurface.sections ?? targetSurface.pages);
    const surface = getText(targetSurface.surface ?? targetSurface.section ?? targetSurface.name ?? targetSurface.page)
      ?? surfaceAliases[0]
      ?? getText(targetSurface.behavior ?? targetSurface.feature ?? targetSurface.repo ?? targetSurface.localPath)
      ?? getStringArray(targetSurface.behaviors ?? targetSurface.features)[0]
      ?? null;
    const existingFiles = [
      ...getStringArray(targetSurface.existingFiles ?? targetSurface.files),
      ...getStringArray(targetSurface.likelyFilesOrAreas ?? targetSurface.likelyFiles ?? targetSurface.fileAreas),
      ...getStringArray(targetSurface.primaryFiles ?? targetSurface.primaryFilePaths ?? targetSurface.paths),
    ];
    const allowedFiles = getStringArray(targetSurface.allowedFiles);
    const forbidden = getStringArray(targetSurface.forbidden ?? targetSurface.forbiddenSurfaces);
    const contractWarnings = [
      targetSurfaceKeys.length > 0 && !route && !surface && existingFiles.length === 0 && allowedFiles.length === 0
        ? "targetSurface did not contain canonical route/surface/files fields; worker must treat it as loose context and inspect the repo before editing."
        : "",
      !designDocumentUrl || designDocumentUrl === "~/code/wingmen/docs/example-design.md"
        ? "designDocumentUrl was not supplied; worker must treat implementationPrompt/instructions and origin context as the source of truth."
        : "",
    ].filter(Boolean);
    const missing = [
      !workdir ? "workdir" : "",
      isPlaceholderSoftwareWorkdir(workdir) ? "non-placeholder workdir" : "",
      targetSurfaceKeys.length === 0 ? "targetSurface" : "",
      !instructions ? "instructions" : "",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Implementation contract missing required field(s): ${missing.join(", ")}. Refuse to start worker until the caller supplies a Target Surface Contract.`);
    }
    return {
      ok: true,
      status: "ok",
      operation: "implementation-contract.validate",
      taskId: taskId ?? null,
      workdir,
      targetSurface: {
        ...targetSurface,
        route: route ?? null,
        surface: surface ?? null,
        existingFiles,
        allowedFiles,
        forbidden,
      },
      contractWarnings,
      visualReferences: visualReferences.slice(0, 8),
    };
  },

  async "dispatch.commentImplementationReviewProgress"(input) {
    return {
      published: false,
      status: "not_configured",
      operation: "tasks.comment-implementation-review-progress",
      reason: "This function only comments on Flight Deck tasks when the pipeline is launched by a Wingman dispatch route.",
      taskId: input.taskId ?? null,
    };
  },

  async "dispatch.normaliseTaskWorkPlan"(input) {
    const response = objectValue(input.agentResponse ?? input.workPlan ?? input);
    const record = objectValue(input.record);
    const agent = objectValue(input.agent);
    const channelContext = resolveFlightDeckChannelContext(input.flightDeckContext, input.channelContext);
    const payload = objectValue(record.payload ?? input.payload);
    const payloadData = objectValue(payload.data);
    const title = String(payload.title ?? payloadData.title ?? response.title ?? "").toLowerCase();
    const description = String(payload.description ?? payloadData.description ?? response.description ?? "").toLowerCase();
    const requestedStyle = String(
      response.workStyle
        ?? response.pipelineStyle
        ?? response.recommendedPipeline
        ?? response.childPipelineDefinitionId
        ?? "",
    ).toLowerCase();
    const combined = `${requestedStyle} ${title} ${description}`;
    const softwareLikely = /\b(code|software|implementation|bug|fix|repo|repository|test|typescript|javascript|frontend|backend|api|database|migration|build|deploy|ui|server)\b/.test(combined);
    const researchLikely = /\b(research|report|sources?|citations?|evidence|survey|compare|comparison|market|analysis|investigate)\b/.test(combined);
    const workStyle = requestedStyle.includes("research") || requestedStyle.includes("report")
      ? "research_and_report"
      : requestedStyle.includes("do_and_review") || requestedStyle.includes("generic")
      ? "do_and_review"
      : requestedStyle.includes("software") || requestedStyle.includes("implementation") || softwareLikely
        ? "software_implementation"
        : researchLikely
          ? "research_and_report"
        : "do_and_review";
    const childPipelineDefinitionId = workStyle === "software_implementation"
      ? "software-implementation-review-loop"
      : workStyle === "research_and_report"
        ? "research-and-report"
        : "do-and-review";
    const executionPlan = getStringArray(response.executionPlan);
    const managerChecklist = getStringArray(response.managerChecklist);
    const taskUpdatePlan = getStringArray(response.taskUpdatePlan);
    const designReference = childPipelineDefinitionId === "software-implementation-review-loop"
      ? resolveDesignDocumentReference(input, response, record, payload, payloadData)
      : null;
    const targetSurface = objectValue(response.targetSurface);
    const explicitWorkdir = getText(response.workdir ?? response.workingDirectory);
    const inferredWorkdir = workStyle === "software_implementation"
      ? resolveRepoWorkdirFromHighSignalText(
        getText(channelContext.contextPrompt),
        getText(response.relevantContext),
        getText(response.taskSummary),
        getText(response.summary),
        getText(response.instructions),
      )
      : null;
    const selectedWorkdir = workStyle === "software_implementation"
      ? explicitWorkdir ?? inferredWorkdir
      : explicitWorkdir ?? getText(agent.workingDirectory);
    const workdir = workStyle === "software_implementation" && isPlaceholderSoftwareWorkdir(selectedWorkdir)
      ? null
      : selectedWorkdir;
    const missing = workStyle === "software_implementation"
      ? [
        !workdir ? "non-placeholder workdir" : "",
        Object.keys(targetSurface).length === 0 ? "targetSurface" : "",
      ].filter(Boolean)
      : [];
    const launchable = response.accepted !== false && missing.length === 0 && Boolean(childPipelineDefinitionId);
    return {
      accepted: response.accepted !== false,
      workStyle,
      childPipelineDefinitionId: launchable ? childPipelineDefinitionId : null,
      pipelineDefinitionId: launchable ? childPipelineDefinitionId : null,
      launchable,
      missing,
      launchBlockedReason: missing.length > 0
        ? `Software implementation dispatch requires ${missing.join(", ")} before launching a worker.`
        : null,
      taskSummary: typeof response.taskSummary === "string"
        ? response.taskSummary
        : typeof response.summary === "string"
          ? response.summary
          : String(payload.title ?? "Task accepted for dispatch."),
      initialFindings: getStringArray(response.initialFindings),
      executionPlan: executionPlan.length > 0 ? executionPlan : [
        "Confirm the latest task context and constraints.",
        "Complete the worker pass using the selected child pipeline.",
        "Run manager review against the task requirements and evidence.",
        "Update the task with progress, result, and any remaining blockers.",
      ],
      managerChecklist: managerChecklist.length > 0 ? managerChecklist : [
        "The worker used the full task context.",
        "The result addresses the requested outcome.",
        "Evidence and sources or verification steps are recorded.",
        "The task has been updated at appropriate milestones.",
      ],
      taskUpdatePlan: taskUpdatePlan.length > 0 ? taskUpdatePlan : [
        "Comment when the child pipeline is launched.",
        "Comment after worker completion with evidence.",
        "Move the task to review or done only after manager review.",
      ],
      workdir,
      ...(Object.keys(targetSurface).length > 0 ? { targetSurface } : {}),
      channelContext,
      ...(designReference ? {
        designDocumentUrl: designReference.designDocumentUrl,
        designDocumentSource: designReference.designDocumentSource,
        designDocumentUnavailableReason: designReference.designDocumentUnavailableReason,
      } : {}),
      suggestedStatus: "in_progress",
      confidence: clampConfidence(response.confidence),
    };
  },

  async "dispatch.normaliseChatDispatchDecision"(input) {
    const chatContext = objectValue(input.chatContext);
    if (chatContext.shouldProceed === false) {
      const reason = getText(chatContext.suppressionReason) ?? "chat_dispatch_suppressed";
      return {
        dispatchTask: false,
        requestedDispatchTask: false,
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing: [],
        clarifyingQuestion: null,
        responseDraft: "",
        shouldRespond: false,
        suppressed: true,
        suppressionReason: reason,
        taskDraft: {
          title: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          assignerNpub: null,
          reviewerNpub: null,
        },
        workPlan: {
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
          taskSummary: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          scopeId: null,
          workdir: null,
          assignerNpub: null,
          reviewerNpub: null,
          origin: {
            triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
            channelId: getText(objectValue(input.chat).channelId),
            threadId: getText(objectValue(input.chat).threadId),
            messageId: getText(objectValue(input.record).recordId),
          },
        },
        confidence: 1,
      };
    }
    const raw = objectValue(input.agentDecision ?? input.decision ?? input.agentResponse ?? input);
    const intent = getText(raw.intent ?? raw.classification ?? raw.action)?.toLowerCase();
    if (intent === "ignore") {
      return {
        dispatchTask: false,
        requestedDispatchTask: false,
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing: [],
        clarifyingQuestion: null,
        responseDraft: "",
        shouldRespond: false,
        suppressed: true,
        suppressionReason: "agent_intent_ignore",
        taskDraft: {
          title: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          assignerNpub: null,
          reviewerNpub: null,
        },
        workPlan: {
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
          taskSummary: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          scopeId: null,
          workdir: null,
          assignerNpub: null,
          reviewerNpub: null,
          origin: {
            triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
            channelId: getText(objectValue(input.chat).channelId),
            threadId: getText(objectValue(input.chat).threadId),
            messageId: getText(objectValue(input.record).recordId),
          },
        },
        confidence: clampConfidence(raw.confidence),
      };
    }
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const payload = objectValue(record.payload);
    const agent = objectValue(input.agent);
    const channelContext = resolveFlightDeckChannelContext(chatContext.channelContext, input.flightDeckContext);
    const requestedPipelineId = getText(
      raw.recommendedPipelineId
        ?? raw.recommendedPipelineDefinitionId
        ?? raw.pipelineDefinitionId
        ?? raw.recommendedPipeline,
    );
    const recognisedIntent = intent && (chatOnlyIntents.has(intent) || createTaskIntents.has(intent) || intent === "agent")
      ? intent
      : (raw.dispatchTask === true ? "create_task" : "answer_now");
    const originThread = getThreadMessages(chatContext).slice(-8).map(compactThreadMessage);
    const visualReferences = collectVisualReferencesFromThread(originThread);
    const latestOriginMessage = originThread[originThread.length - 1] ?? {};
    const originalPrompt = getText(latestOriginMessage.body)
      ?? getText(chat.messageText)
      ?? getText(payload.body);
    const referencedRecords = Array.isArray(chatContext.referencedRecords)
      ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
      : [];
    const taskDraft = objectValue(raw.taskDraft);
    const scopeId = getText(raw.scopeId ?? taskDraft.scopeId);
    const workdir = getText(raw.workdir ?? taskDraft.workdir ?? agent.workingDirectory);
    const assignerNpub = getText(raw.assignerNpub ?? taskDraft.assignerNpub ?? chat.senderNpub ?? payload.sender_npub ?? record.updaterNpub);
    const reviewerNpub = getText(raw.reviewerNpub ?? taskDraft.reviewerNpub ?? assignerNpub);
    const chatResponseBody = getText(objectValue(raw.chatResponse).body)
      ?? getText(raw.responseDraft)
      ?? getText(raw.replyDraft)
      ?? getText(raw.answer);
    if (recognisedIntent === "agent" || (recognisedIntent === "think_then_answer" && !chatResponseBody)) {
      return {
        dispatchAgent: true,
        dispatchTask: false,
        dispatchPipeline: false,
        requestedDispatchTask: false,
        intent: recognisedIntent === "agent" ? "agent" : "think_then_answer",
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing: [],
        clarifyingQuestion: null,
        responseDraft: chatResponseBody ?? "I’ll think this through and answer here.",
        shouldRespond: false,
        taskRoutingPending: false,
        taskDraft: {
          title: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          assignerNpub,
          reviewerNpub,
        },
        workPlan: {
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
          taskSummary: "",
          instructions: "",
          acceptanceCriteria: [],
          executionPlan: [],
          managerChecklist: [],
          scopeId: null,
          workdir: null,
          assignerNpub,
          reviewerNpub,
          originalPrompt,
          channelContext,
          originThread,
          referencedRecords,
          origin: {
            triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
            channelId: getText(chat.channelId),
            threadId: getText(chat.threadId),
            messageId: getText(record.recordId),
          },
        },
        confidence: clampConfidence(raw.confidence),
      };
    }
    const promoteThinkThenAnswer = recognisedIntent === "think_then_answer"
      && shouldPromoteThinkThenAnswerToTask(chatResponseBody, originalPrompt);
    const promotedDraft = promoteThinkThenAnswer
      ? buildPromotedChatTaskDraft(originalPrompt)
      : null;
    const effectiveIntent = promoteThinkThenAnswer ? "create_task" : recognisedIntent;
    const dispatchTask = effectiveIntent === "create_task";
    const pipelineDefinitionId = dispatchTask && requestedPipelineId && !isDiscussionPipelineIdentifier(requestedPipelineId)
      ? requestedPipelineId
      : null;
    const title = getText(taskDraft.title ?? raw.title) ?? promotedDraft?.title ?? "Chat-requested Wingman task";
    const instructions = getText(
      taskDraft.instructions
        ?? taskDraft.concreteInstructions
        ?? raw.instructions
        ?? raw.concreteInstructions
        ?? raw.taskInstructions
        ?? raw.messageSummary,
    ) ?? promotedDraft?.instructions;
    const acceptanceCriteria = getStringArray(taskDraft.acceptanceCriteria ?? raw.acceptanceCriteria);
    const executionPlan = getStringArray(taskDraft.executionPlan ?? raw.executionPlan);
    const managerChecklist = getStringArray(taskDraft.managerChecklist ?? raw.managerChecklist);
    const effectiveAcceptanceCriteria = acceptanceCriteria.length > 0 ? acceptanceCriteria : (promotedDraft?.acceptanceCriteria ?? []);
    const effectiveExecutionPlan = executionPlan.length > 0 ? executionPlan : (promotedDraft?.executionPlan ?? []);
    const effectiveManagerChecklist = managerChecklist.length > 0 ? managerChecklist : (promotedDraft?.managerChecklist ?? []);
    const clarifyingQuestion = getText(raw.clarifyingQuestion);
    const selectedDispatchPipeline = isDispatchPipelineIdentifier(pipelineDefinitionId);
    const selectedSoftwareImplementationPipeline = isSoftwareImplementationPipelineIdentifier(pipelineDefinitionId)
      || isSoftwareImplementationPipelineIdentifier(requestedPipelineId)
      || isSoftwareImplementationPipelineIdentifier(getText(taskDraft.pipelineSlug ?? taskDraft.pipelineName));
    const targetSurface = objectValue(raw.targetSurface ?? taskDraft.targetSurface);
    const hasTargetSurface = Object.keys(targetSurface).length > 0;
    const missing = dispatchTask && pipelineDefinitionId
      ? [
          !pipelineDefinitionId ? "pipeline" : "",
          selectedDispatchPipeline ? "downstream work pipeline" : "",
          selectedSoftwareImplementationPipeline && !hasTargetSurface ? "targetSurface" : "",
          selectedSoftwareImplementationPipeline && isPlaceholderSoftwareWorkdir(workdir) ? "non-placeholder workdir" : "",
          !selectedSoftwareImplementationPipeline && !workdir ? "workdir" : "",
          !instructions ? "instructions" : "",
        ].filter(Boolean)
      : [];
    const hasTaskDraft = Boolean(instructions);
    const shouldDispatchTask = dispatchTask && Boolean(pipelineDefinitionId) && missing.length === 0 && !clarifyingQuestion;
    const responseDraft = shouldDispatchTask
      ? (chatResponseBody ?? "I have the request and am starting the right pipeline-backed task now.")
      : clarifyingQuestion
        ?? chatResponseBody
        ?? (missing.length > 0
          ? `I need one clarification before starting work: ${missing.join(", ")}.`
          : dispatchTask
            ? "I have the request and am choosing the right task workflow now."
            : "I can handle this directly in chat.");
    return {
      dispatchTask: shouldDispatchTask,
      requestedDispatchTask: dispatchTask,
      intent: effectiveIntent,
      originalIntent: promoteThinkThenAnswer ? recognisedIntent : undefined,
      pipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
      scopeId: shouldDispatchTask ? scopeId : null,
      workdir: shouldDispatchTask ? workdir : null,
      missing,
      clarifyingQuestion,
      responseDraft,
      taskRoutingPending: dispatchTask && hasTaskDraft && !shouldDispatchTask && !clarifyingQuestion,
      taskDraft: {
        title,
        instructions: instructions ?? "",
        acceptanceCriteria: effectiveAcceptanceCriteria,
        executionPlan: effectiveExecutionPlan,
        managerChecklist: effectiveManagerChecklist,
        assignerNpub,
        reviewerNpub,
        ...(hasTargetSurface ? { targetSurface } : {}),
        ...(visualReferences.length > 0 ? { visualReferences } : {}),
      },
      workPlan: {
        childPipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
        pipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
        taskSummary: title,
        instructions: instructions ?? "",
        acceptanceCriteria: effectiveAcceptanceCriteria,
        executionPlan: effectiveExecutionPlan,
        managerChecklist: effectiveManagerChecklist,
        scopeId: shouldDispatchTask ? scopeId : null,
        workdir: shouldDispatchTask ? workdir : null,
        assignerNpub,
        reviewerNpub,
        originalPrompt,
        channelContext,
        originThread,
        referencedRecords,
        ...(hasTargetSurface ? { targetSurface } : {}),
        ...(visualReferences.length > 0 ? { visualReferences } : {}),
        origin: {
          triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
          channelId: getText(chat.channelId),
          threadId: getText(chat.threadId),
          messageId: getText(record.recordId),
        },
      },
      confidence: clampConfidence(raw.confidence),
    };
  },

  async "dispatch.normaliseChatAgentWorkDecision"(input) {
    const previousDecision = objectValue(input.decision);
    const raw = objectValue(input.agentWorkDecision ?? input.agentDecision ?? input.agentResponse);
    const action = (getText(raw.action ?? raw.intent ?? raw.classification) ?? "reply").toLowerCase();
    const chat = objectValue(input.chat);
    const record = objectValue(input.record);
    const payload = objectValue(record.payload);
    const agent = objectValue(input.agent);
    const chatContext = objectValue(input.chatContext);
    const chatDispatchInput = objectValue(input.chatDispatchInput);
    const channelContext = resolveFlightDeckChannelContext(chatDispatchInput.channelContext, chatContext.channelContext, input.flightDeckContext);
    const originThread = Array.isArray(chatDispatchInput.latestThread) && chatDispatchInput.latestThread.length > 0
      ? chatDispatchInput.latestThread.slice(-8).map(compactThreadMessage)
      : getThreadMessages(chatContext).slice(-8).map(compactThreadMessage);
    const latestOriginMessage = originThread[originThread.length - 1] ?? {};
    const originalPrompt = getText(latestOriginMessage.body)
      ?? getText(chat.messageText)
      ?? getText(payload.body);
    const referencedRecords = Array.isArray(chatDispatchInput.referencedRecords)
      ? chatDispatchInput.referencedRecords.slice(0, 12).map(compactReferencedRecord)
      : Array.isArray(chatContext.referencedRecords)
        ? chatContext.referencedRecords.slice(0, 12).map(compactReferencedRecord)
        : [];
    const visualReferences = collectVisualReferencesFromThread(originThread);
    const workPlanInput = objectValue(raw.workPlan);
    const taskDraftInput = objectValue(raw.taskDraft);
    const requestedPipelineId = getText(
      raw.recommendedPipelineId
        ?? raw.recommendedPipelineDefinitionId
        ?? raw.pipelineDefinitionId
        ?? raw.recommendedPipeline
        ?? workPlanInput.pipelineDefinitionId
        ?? workPlanInput.childPipelineDefinitionId,
    );
    const chatResponseBody = getText(objectValue(raw.chatResponse).body)
      ?? getText(raw.responseDraft)
      ?? getText(raw.replyDraft)
      ?? getText(raw.answer);
    const clarifyingQuestion = getText(raw.clarifyingQuestion);
    const assignerNpub = getText(workPlanInput.assignerNpub ?? taskDraftInput.assignerNpub ?? chat.senderNpub ?? payload.sender_npub ?? record.updaterNpub);
    const reviewerNpub = getText(workPlanInput.reviewerNpub ?? taskDraftInput.reviewerNpub ?? assignerNpub);

    if (action === "ignore") {
      return {
        ...previousDecision,
        dispatchAgent: false,
        dispatchTask: false,
        dispatchPipeline: false,
        requestedDispatchTask: false,
        shouldRespond: false,
        suppressed: true,
        suppressionReason: "agent_work_intent_ignore",
        taskRoutingPending: false,
        confidence: clampConfidence(raw.confidence ?? previousDecision.confidence),
      };
    }

    if (action === "clarify" || clarifyingQuestion) {
      return {
        ...previousDecision,
        dispatchAgent: false,
        dispatchTask: false,
        dispatchPipeline: false,
        requestedDispatchTask: false,
        intent: "clarify",
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing: [],
        clarifyingQuestion,
        responseDraft: clarifyingQuestion ?? chatResponseBody ?? "What would you like me to clarify?",
        shouldRespond: true,
        taskRoutingPending: false,
        confidence: clampConfidence(raw.confidence ?? previousDecision.confidence),
      };
    }

    if (action !== "start_pipeline") {
      return {
        ...previousDecision,
        dispatchAgent: false,
        dispatchTask: false,
        dispatchPipeline: false,
        requestedDispatchTask: false,
        intent: "answer_now",
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing: [],
        clarifyingQuestion: null,
        responseDraft: chatResponseBody ?? "Done.",
        shouldRespond: true,
        taskRoutingPending: false,
        confidence: clampConfidence(raw.confidence ?? previousDecision.confidence),
      };
    }

    const selectedDispatchPipeline = isDispatchPipelineIdentifier(requestedPipelineId);
    const selectedDiscussionPipeline = isDiscussionPipelineIdentifier(requestedPipelineId);
    const selectedDocumentDiscussionPipeline = isDocumentDiscussionPipelineIdentifier(requestedPipelineId);
    const selectedSoftwareImplementationPipeline = isSoftwareImplementationPipelineIdentifier(requestedPipelineId);
    const scopeId = getText(raw.scopeId ?? workPlanInput.scopeId ?? taskDraftInput.scopeId);
    const explicitWorkdir = getText(raw.workdir ?? raw.workingDirectory ?? workPlanInput.workdir ?? workPlanInput.workingDirectory ?? taskDraftInput.workdir);
    const channelWorkdir = resolveRepoWorkdirFromHighSignalText(
      getText(channelContext.contextPrompt),
      getText(workPlanInput.channelContext),
      getText(taskDraftInput.channelContext),
      originalPrompt,
    );
    const fallbackWorkdir = selectedSoftwareImplementationPipeline ? null : getText(agent.workingDirectory);
    const selectedWorkdir = explicitWorkdir ?? channelWorkdir ?? fallbackWorkdir;
    const workdir = selectedSoftwareImplementationPipeline && isPlaceholderSoftwareWorkdir(selectedWorkdir)
      ? null
      : selectedWorkdir;
    const targetSurface = objectValue(raw.targetSurface ?? workPlanInput.targetSurface ?? taskDraftInput.targetSurface);
    const hasTargetSurface = Object.keys(targetSurface).length > 0;
    const instructions = getText(
      raw.instructions
        ?? raw.concreteInstructions
        ?? workPlanInput.instructions
        ?? workPlanInput.implementationPrompt
        ?? taskDraftInput.instructions
        ?? taskDraftInput.concreteInstructions,
    );
    const title = getText(taskDraftInput.title ?? workPlanInput.taskSummary ?? workPlanInput.title ?? raw.title)
      ?? "Chat-requested Wingman task";
    const acceptanceCriteria = getStringArray(taskDraftInput.acceptanceCriteria ?? workPlanInput.acceptanceCriteria ?? raw.acceptanceCriteria);
    const executionPlan = getStringArray(taskDraftInput.executionPlan ?? workPlanInput.executionPlan ?? raw.executionPlan);
    const managerChecklist = getStringArray(taskDraftInput.managerChecklist ?? workPlanInput.managerChecklist ?? raw.managerChecklist);
    const designDocument = objectValue(raw.designDocument ?? workPlanInput.designDocument);
    const explicitDesignDocumentUrl = getText(workPlanInput.designDocumentUrl ?? raw.designDocumentUrl ?? designDocument.localPath ?? designDocument.path ?? designDocument.url);
    const designDocumentUrl = explicitDesignDocumentUrl
      ?? (selectedSoftwareImplementationPipeline
        ? resolveChatThreadDesignReference(input, {
          ...workPlanInput,
          origin: {
            triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
            channelId: getText(chat.channelId),
            threadId: getText(chat.threadId),
            messageId: getText(record.recordId),
          },
        })
        : null);
    const localVisualReferences = Array.isArray(workPlanInput.visualReferences)
      ? workPlanInput.visualReferences
      : Array.isArray(raw.visualReferences)
        ? raw.visualReferences
        : visualReferences;
    const pipelinesRequired = raw.pipelinesRequired === true || raw.requiresPipelines === true;
    const rawPipelines = Array.isArray(raw.pipelines)
      ? raw.pipelines
      : Array.isArray(workPlanInput.pipelines)
        ? workPlanInput.pipelines
        : [];
    const baseOrigin = {
      triggerKind: getText(objectValue(input.dispatch).triggerKind) ?? "chat",
      channelId: getText(chat.channelId),
      threadId: getText(chat.threadId),
      messageId: getText(record.recordId),
      requesterNpub: assignerNpub,
    };
    const baseReporting = raw.createTask === false
      ? { mode: "chat_thread", callbackPipeline: getText(objectValue(workPlanInput.reporting).callbackPipeline) ?? "chat-response" }
      : { mode: "flightdeck_task" };
    const basePipelineFallback = {
      pipelineDefinitionId: requestedPipelineId,
      taskSummary: title,
      workdir,
      instructions,
      targetSurface,
      designDocumentUrl,
      designDocument,
      acceptanceCriteria,
      executionPlan,
      managerChecklist,
      assignerNpub,
      reviewerNpub,
      maxReviewIterations: clampReviewIterations(workPlanInput.maxReviewIterations ?? raw.maxReviewIterations),
      originalPrompt,
      channelContext,
      originThread,
      referencedRecords,
      visualReferences: localVisualReferences,
      origin: baseOrigin,
      reporting: baseReporting,
    };
    const pipelineRequirements = pipelinesRequired || rawPipelines.length > 0
      ? rawPipelines.map((item, index) => normalisePipelineRequirement({
        item,
        index,
        fallback: basePipelineFallback,
      }))
      : [];
    const uniquePipelineRequirements = pipelineRequirements.filter((requirement, index, all) =>
      all.findIndex((candidate) => candidate.requirementId === requirement.requirementId) === index);
    const duplicateRequirementIds = pipelineRequirements
      .filter((requirement, index, all) => all.findIndex((candidate) => candidate.requirementId === requirement.requirementId) !== index)
      .map((requirement) => requirement.requirementId);
    const pipelineRequirementMissing = uniquePipelineRequirements.flatMap((requirement) => requirement.missing);
    const missing = [
      pipelinesRequired && uniquePipelineRequirements.length === 0 ? "pipelines" : "",
      !pipelinesRequired && !requestedPipelineId ? "pipeline" : "",
      !pipelinesRequired && selectedDispatchPipeline ? "downstream work pipeline" : "",
      !pipelinesRequired && selectedSoftwareImplementationPipeline && !hasTargetSurface ? "targetSurface" : "",
      !pipelinesRequired && selectedSoftwareImplementationPipeline && isPlaceholderSoftwareWorkdir(workdir) ? "non-placeholder workdir" : "",
      !pipelinesRequired && !selectedSoftwareImplementationPipeline && !selectedDocumentDiscussionPipeline && !workdir ? "workdir" : "",
      !pipelinesRequired && !instructions ? "instructions" : "",
      ...pipelineRequirementMissing,
    ].filter(Boolean);
    if (missing.length > 0) {
      return {
        ...previousDecision,
        dispatchAgent: false,
        dispatchTask: false,
        dispatchPipeline: false,
        requestedDispatchTask: false,
        intent: "clarify",
        pipelineDefinitionId: null,
        scopeId: null,
        workdir: null,
        missing,
        clarifyingQuestion: clarifyingQuestion ?? `I need one clarification before starting work: ${missing.join(", ")}.`,
        responseDraft: clarifyingQuestion ?? `I need one clarification before starting work: ${missing.join(", ")}.`,
        shouldRespond: true,
        taskRoutingPending: false,
        confidence: clampConfidence(raw.confidence ?? previousDecision.confidence),
      };
    }

    const createTask = selectedDocumentDiscussionPipeline
      ? raw.createTask === true
      : raw.createTask !== false;
    const pipelineDefinitionId = requestedPipelineId ?? uniquePipelineRequirements[0]?.pipelineDefinitionId ?? null;
    const workPlan = {
      ...workPlanInput,
      childPipelineDefinitionId: pipelineDefinitionId,
      pipelineDefinitionId,
      taskSummary: getText(workPlanInput.taskSummary ?? workPlanInput.title) ?? title,
      instructions: instructions ?? "",
      acceptanceCriteria,
      executionPlan,
      managerChecklist,
      scopeId: createTask ? scopeId : scopeId ?? null,
      workdir: workdir ?? null,
      assignerNpub,
      reviewerNpub,
      maxReviewIterations: clampReviewIterations(workPlanInput.maxReviewIterations ?? raw.maxReviewIterations),
      originalPrompt,
      channelContext,
      originThread,
      referencedRecords,
      ...(hasTargetSurface ? { targetSurface } : {}),
      ...(localVisualReferences.length > 0 ? { visualReferences: localVisualReferences.slice(0, 8) } : {}),
      ...(designDocumentUrl ? { designDocumentUrl } : {}),
      ...(Object.keys(designDocument).length > 0 ? { designDocument } : {}),
      ...(uniquePipelineRequirements.length > 0 ? {
        pipelinesRequired: true,
        pipelines: uniquePipelineRequirements.map((requirement) => ({
          requirementId: requirement.requirementId,
          pipeline: requirement.pipelineDefinitionId,
          pipelineDefinitionId: requirement.pipelineDefinitionId,
          payload: requirement.workPlan,
        })),
        skippedDuplicateRequirementIds: duplicateRequirementIds,
      } : {}),
      origin: baseOrigin,
      reporting: createTask
        ? { mode: "flightdeck_task" }
        : baseReporting,
    };

    return {
      ...previousDecision,
      dispatchAgent: false,
      dispatchTask: createTask,
      dispatchPipeline: !createTask,
      pipelinesRequired: uniquePipelineRequirements.length > 0,
      pipelineLaunches: uniquePipelineRequirements.map((requirement) => ({
        requirementId: requirement.requirementId,
        pipelineDefinitionId: requirement.pipelineDefinitionId,
        workPlan: requirement.workPlan,
      })),
      skippedDuplicateRequirementIds: duplicateRequirementIds,
      dispatchSingleTaskPipeline: createTask && uniquePipelineRequirements.length === 0,
      dispatchSingleDirectPipeline: !createTask && uniquePipelineRequirements.length === 0,
      requestedDispatchTask: createTask,
      intent: createTask ? "create_task" : "start_pipeline",
      pipelineDefinitionId,
      scopeId,
      workdir,
      missing: [],
      clarifyingQuestion: null,
      responseDraft: chatResponseBody
        ?? (createTask
          ? "I have the request and am starting the right pipeline-backed task now."
          : "I have the request and am starting the right pipeline now."),
      shouldRespond: true,
      taskRoutingPending: false,
      taskDraft: {
        ...taskDraftInput,
        title,
        instructions: instructions ?? "",
        acceptanceCriteria,
        executionPlan,
        managerChecklist,
        assignerNpub,
        reviewerNpub,
        ...(hasTargetSurface ? { targetSurface } : {}),
        ...(localVisualReferences.length > 0 ? { visualReferences: localVisualReferences.slice(0, 8) } : {}),
      },
      workPlan,
      confidence: clampConfidence(raw.confidence ?? previousDecision.confidence),
    };
  },

  async "dispatch.normaliseChatTaskPipelineSelection"(input) {
    const decision = objectValue(input.decision);
    if (decision.requestedDispatchTask !== true || decision.taskRoutingPending !== true) {
      return decision;
    }

    const raw = objectValue(input.taskPipelineDecision ?? input.agentDecision ?? input.pipelineDecision);
    const requestedPipelineId = getText(
      raw.recommendedPipelineId
        ?? raw.recommendedPipelineDefinitionId
        ?? raw.pipelineDefinitionId
        ?? raw.recommendedPipeline,
    );
    const validChildPipelines = objectValue(input.taskPipelineInput).validChildPipelines;
    const validPipelines = Array.isArray(validChildPipelines)
      ? validChildPipelines.map((pipeline) => objectValue(pipeline))
      : [];
    const selectedPipeline = validPipelines.find((pipeline) => {
      const id = getText(pipeline.id);
      const slug = getText(pipeline.slug);
      const name = getText(pipeline.name);
      return requestedPipelineId === id || requestedPipelineId === slug || requestedPipelineId === name;
    }) ?? null;
    const pipelineDefinitionId = getText(selectedPipeline?.id)
      ?? getText(selectedPipeline?.slug)
      ?? requestedPipelineId;
    const selectedPipelineSlug = getText(selectedPipeline?.slug);
    const selectedPipelineName = getText(selectedPipeline?.name);
    const selectedDispatchPipeline = isDispatchPipelineIdentifier(pipelineDefinitionId)
      || isDispatchPipelineIdentifier(selectedPipelineSlug)
      || isDispatchPipelineIdentifier(selectedPipelineName);
    const selectedDiscussionPipeline = isDiscussionPipelineIdentifier(pipelineDefinitionId)
      || isDiscussionPipelineIdentifier(selectedPipelineSlug)
      || isDiscussionPipelineIdentifier(selectedPipelineName);
    const selectedSoftwareImplementationPipeline = isSoftwareImplementationPipelineIdentifier(pipelineDefinitionId)
      || isSoftwareImplementationPipelineIdentifier(selectedPipelineSlug)
      || isSoftwareImplementationPipelineIdentifier(selectedPipelineName);
    const taskDraft = objectValue(decision.taskDraft);
    const workPlan = objectValue(decision.workPlan);
    const workdir = getText(raw.workdir ?? taskDraft.workdir ?? decision.workdir ?? workPlan.workdir);
    const instructions = getText(taskDraft.instructions ?? raw.instructions);
    const targetSurface = objectValue(raw.targetSurface ?? taskDraft.targetSurface ?? workPlan.targetSurface);
    const hasTargetSurface = Object.keys(targetSurface).length > 0;
    const visualReferences = Array.isArray(raw.visualReferences)
      ? raw.visualReferences.slice(0, 8).map((item) => objectValue(item))
      : Array.isArray(taskDraft.visualReferences)
        ? taskDraft.visualReferences.slice(0, 8).map((item) => objectValue(item))
        : Array.isArray(workPlan.visualReferences)
          ? workPlan.visualReferences.slice(0, 8).map((item) => objectValue(item))
          : [];
    const missing = [
      !pipelineDefinitionId ? "pipeline" : "",
      selectedDispatchPipeline || selectedDiscussionPipeline ? "task-capable downstream pipeline" : "",
      selectedSoftwareImplementationPipeline && !hasTargetSurface ? "targetSurface" : "",
      selectedSoftwareImplementationPipeline && isPlaceholderSoftwareWorkdir(workdir) ? "non-placeholder workdir" : "",
      !selectedSoftwareImplementationPipeline && !workdir ? "workdir" : "",
      !instructions ? "instructions" : "",
    ].filter(Boolean);
    const clarifyingQuestion = getText(raw.clarifyingQuestion ?? decision.clarifyingQuestion);
    const shouldDispatchTask = missing.length === 0 && !clarifyingQuestion;
    const responseDraft = shouldDispatchTask
      ? (getText(objectValue(raw.chatResponse).body)
        ?? getText(raw.responseDraft)
        ?? getText(decision.responseDraft)
        ?? "I have the request and am starting the right pipeline-backed task now.")
      : clarifyingQuestion
        ?? `I need one clarification before starting work: ${missing.join(", ")}.`;

    return {
      ...decision,
      dispatchTask: shouldDispatchTask,
      dispatchPipeline: false,
      pipelinesRequired: false,
      dispatchSingleTaskPipeline: shouldDispatchTask,
      dispatchSingleDirectPipeline: false,
      pipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
      scopeId: shouldDispatchTask ? getText(raw.scopeId ?? decision.scopeId) : null,
      workdir: shouldDispatchTask ? workdir : null,
      missing,
      clarifyingQuestion,
      responseDraft,
      taskRoutingPending: false,
      workPlan: {
        ...workPlan,
        childPipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
        pipelineDefinitionId: shouldDispatchTask ? pipelineDefinitionId : null,
        scopeId: shouldDispatchTask ? getText(raw.scopeId ?? decision.scopeId) : null,
        workdir: shouldDispatchTask ? workdir : null,
        ...(hasTargetSurface ? { targetSurface } : {}),
        ...(visualReferences.length > 0 ? { visualReferences } : {}),
      },
      confidence: clampConfidence(raw.confidence ?? decision.confidence),
    };
  },

  async "dispatch.prepareChatDispatchResponse"(input) {
    const decision = objectValue(input.decision);
    if (decision.shouldRespond === false || decision.suppressed === true) {
      return {
        shouldRespond: false,
        responseDraft: "",
        reasoningSummary: getText(decision.suppressionReason) ?? "Chat dispatch was suppressed.",
        actionsTaken: [],
        confidence: clampConfidence(decision.confidence),
      };
    }
    const createdTask = objectValue(input.createdTask);
    const childPipeline = objectValue(input.childPipeline);
    const childPipelines = objectValue(input.childPipelines);
    const childPipelineItems = Array.isArray(childPipelines.items)
      ? childPipelines.items.map((item) => objectValue(item))
      : [];
    const effectiveChildPipeline = childPipelineItems.length > 0 ? childPipelines : childPipeline;
    const closeoutContext = objectValue(input.closeoutContext);
    const taskId = getText(createdTask.taskId);
    const createdTaskItems = Array.isArray(createdTask.items)
      ? createdTask.items.map((item) => objectValue(item))
      : [];
    const createdTaskMentions = createdTaskItems
      .map((item) => {
        const itemTaskId = getText(item.taskId);
        if (!itemTaskId) return null;
        const itemWorkPlan = objectValue(item.workPlan);
        const itemLabel = getText(itemWorkPlan.taskSummary)
          ?? getText(item.title)
          ?? getText(item.requirementId)
          ?? "created task";
        return mention("task", itemTaskId, itemLabel);
      })
      .filter((item): item is string => Boolean(item));
    const taskCreationFailed = decision.dispatchTask === true && getText(createdTask.status) === "failed";
    const directPipelineRequested = decision.dispatchPipeline === true;
    const createdTaskWorkPlan = objectValue(createdTask.workPlan);
    const taskLabel = getText(createdTaskWorkPlan.taskSummary)
      ?? getText(createdTask.title)
      ?? "created task";
    const taskMention = taskId ? mention("task", taskId, taskLabel) : null;
    const pipelineName = childPipelineItems.length > 0
      ? `${childPipelineItems.length} pipeline requirements`
      : getText(childPipeline.pipelineName) ?? getText(decision.pipelineDefinitionId);
    const pipelineRunId = getText(childPipeline.pipelineRunId);
    const childPipelineStatus = getText(effectiveChildPipeline.status);
    const launchFailed = effectiveChildPipeline.started === false
      || childPipelineStatus === "failed"
      || childPipelineStatus === "error"
      || childPipelineItems.some((item) => item.started === false || getText(item.status) === "failed" || getText(item.status) === "error");
    const needsInput = getText(effectiveChildPipeline.status) === "needs_input"
      || childPipelineItems.some((item) => getText(item.status) === "needs_input");
    const needsInputUpdate = objectValue(effectiveChildPipeline.needsInputUpdate);
    const taskAction = createdTask.reused === true ? "reopened task" : "created task";
    let responseDraft = getText(decision.responseDraft) ?? "Done.";
    if (taskCreationFailed) {
      responseDraft = `I have the request, but I could not create the Flight Deck task yet: ${getText(createdTask.reason) ?? "unknown error"}. I am not dropping the request; please retry or check the Autopilot Flight Deck dispatch connection.`;
    } else if (decision.dispatchTask === true && createdTaskMentions.length > 1) {
      responseDraft = launchFailed
        ? `I created ${createdTaskMentions.length} tasks, but one or more selected pipelines did not start: ${getText(effectiveChildPipeline.reason) ?? "unknown error"}.`
        : `I created ${createdTaskMentions.length} tasks and started ${childPipelineItems.length || createdTaskMentions.length} pipeline requirements: ${createdTaskMentions.join(", ")}. I will hand them back independently as each finishes.`;
    } else if (decision.dispatchTask === true && taskId) {
      responseDraft = needsInput
        ? `I ${taskAction} ${taskMention} and started ${pipelineName ?? "the selected pipeline"}${pipelineRunId ? ` (${pipelineRunId})` : ""}, but it needs input before it can continue.${getText(needsInputUpdate.question) ? `\nQuestion: ${getText(needsInputUpdate.question)}` : ""}`
        : launchFailed
        ? `I ${taskAction} ${taskMention}, but the selected pipeline did not start: ${getText(childPipeline.reason) ?? "unknown error"}. I marked the task blocked for review.`
        : childPipelineItems.length > 0
          ? `I ${taskAction} ${taskMention} and started ${childPipelineItems.length} pipeline requirements. I will hand it back for review when the pipelines finish.`
          : `I ${taskAction} ${taskMention} and started ${pipelineName ?? "the selected pipeline"}${pipelineRunId ? ` (${pipelineRunId})` : ""}. I will hand it back for review when the pipeline finishes.`;
    } else if (directPipelineRequested) {
      responseDraft = launchFailed
        ? `I have the request, but the selected pipeline did not start: ${getText(effectiveChildPipeline.reason) ?? "unknown error"}.`
        : (getText(decision.responseDraft)
          ?? (childPipelineItems.length > 0
            ? `I started ${childPipelineItems.length} pipeline requirements.`
            : `I started ${pipelineName ?? "the selected pipeline"}${pipelineRunId ? ` (${pipelineRunId})` : ""}.`));
    }
    return {
      shouldRespond: !(needsInput && needsInputUpdate.chatNotified === true),
      responseDraft,
      childPipeline: Object.keys(effectiveChildPipeline).length > 0 ? effectiveChildPipeline : null,
      childPipelines: childPipelineItems.length > 0 ? childPipelines : null,
      reasoningSummary: getText(decision.clarifyingQuestion)
        ? "Asked a clarifying question instead of dispatching work."
        : taskCreationFailed
          ? "Task-backed dispatch was requested, but task creation failed; reporting the issue in chat."
        : launchFailed
          ? directPipelineRequested
            ? "Direct child pipeline dispatch failed to start or errored immediately."
            : "Task-backed dispatch created a task, but the selected child pipeline failed to start or errored immediately."
        : needsInput
          ? "The child pipeline needs input; a clarification question was published."
        : decision.dispatchTask === true
          ? createdTask.reused === true
            ? "Reused an existing task and started the selected pipeline."
            : "Created a task and started the selected pipeline."
          : directPipelineRequested
            ? "Started a direct child pipeline without creating a task."
          : "Responded directly without dispatching task-backed work.",
      actionsTaken: [
        ...(taskId ? [`${createdTask.reused === true ? "reused" : "created"} task ${taskId}`] : []),
        ...(createdTaskItems.length > 1 ? [`created ${createdTaskItems.length} task requirement(s)`] : []),
        ...(pipelineRunId ? [`started pipeline run ${pipelineRunId}`] : []),
        ...(childPipelineItems.length > 0 ? [`started ${childPipelineItems.length} pipeline requirement(s)`] : []),
        ...(closeoutContext.hydrated === true ? ["re-read chat thread before replying"] : []),
        ...(taskCreationFailed ? [`task creation failed: ${getText(createdTask.reason) ?? "unknown error"}`] : []),
      ],
      confidence: clampConfidence(decision.confidence),
    };
  },

  async "object.finalise"(input) {
    return {
      text: input.normalised,
      features: input.features,
      agentRaw: input.agentRaw,
      classification: input.classification,
      route: input.route,
    };
  },

  async "object.finaliseParagraphAnalysis"(input) {
    const document = objectValue(input.document);
    return {
      paragraphCount: document.paragraphCount ?? 0,
      selectedParagraph: document.selectedParagraph ?? null,
      analysis: input.analysis ?? null,
    };
  },

  async "review.appendIteration"(input) {
    const existing = Array.isArray(input.history) ? input.history : [];
    const loop = objectValue(input.loop);
    return {
      items: [
        ...existing,
        {
          iteration: Number(loop.iteration ?? existing.length + 1),
          critic: objectValue(input.critic),
          response: objectValue(input.response),
        },
      ],
    };
  },

  async "review.finaliseDesignReview"(input) {
    return {
      documentUrl: typeof input.documentUrl === "string" ? input.documentUrl : "",
      iterations: Number(input.iterations ?? 0),
      reviewHistory: input.reviewHistory,
      finalCriticNotes: input.critic,
      finalResponseNotes: input.response,
      tidyUp: input.tidyUp,
    };
  },

  async "memory.searchEntities"(input) {
    const entities = normaliseMemoryEntities(input.entities).slice(0, positiveInteger(input.maxEntities, 8));
    const topKPerEntity = positiveInteger(input.topKPerEntity, 5);
    const maxMatches = positiveInteger(input.maxMatches, 20);
    const warnings: string[] = [];
    if (entities.length === 0) {
      return {
        matches: [],
        entities,
        warnings: ["No memory entities were provided for graph search."],
        graphMemoryAvailable: false,
      };
    }

    const config = getGraphMemoryConfig(input);
    if (!config.ok) {
      return {
        matches: [],
        entities,
        warnings: [config.warning],
        graphMemoryAvailable: false,
      };
    }

    const settled = await Promise.all(entities.map(async (entity) => {
      try {
        const embedding = await embedGraphMemoryQuery(entity.query || entity.name, config.value);
        return await queryNeo4jVectorMemory({
          embedding,
          entity,
          topK: topKPerEntity,
          ownerNpub: typeof input.ownerNpub === "string" ? input.ownerNpub : null,
          config: config.value,
        });
      } catch (error) {
        warnings.push(`${entity.name}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));

    return {
      matches: dedupeGraphMemoryMatches(settled.flat()).slice(0, maxMatches),
      entities,
      warnings,
      graphMemoryAvailable: true,
      searchedAt: new Date().toISOString(),
    };
  },

  async "tower.searchGraph"(input) {
    const entities = normaliseMemoryEntities(input.entities).slice(0, positiveInteger(input.maxEntities, 8));
    const topKPerEntity = positiveInteger(input.topKPerEntity, 5);
    const maxMatches = positiveInteger(input.maxMatches, 20);
    const warnings: string[] = [];
    if (entities.length === 0) {
      return {
        matches: [],
        entities,
        warnings: ["No memory entities were provided for Tower graph search."],
        graphMemoryAvailable: false,
      };
    }

    const towerBaseUrl = getTowerGraphBaseUrl(input);
    const settled = await Promise.all(entities.map(async (entity) => {
      const requestUrl = buildTowerGraphSearchUrl(towerBaseUrl, entity, input, topKPerEntity);
      try {
        const { token } = await signWithWingmanKey(requestUrl, "GET");
        const response = await fetch(requestUrl, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: token,
          },
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(`Tower graph search failed (HTTP ${response.status})${errorText ? `: ${truncateText(errorText, 240)}` : ""}`);
        }
        const payload = await response.json();
        return normaliseTowerGraphSearchResults(payload, entity);
      } catch (error) {
        warnings.push(`${entity.name}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));

    const matches = dedupeGraphMemoryMatches(settled.flat()).slice(0, maxMatches);
    return {
      matches,
      entities,
      warnings,
      graphMemoryAvailable: warnings.length < entities.length,
      searchedAt: new Date().toISOString(),
      source: "tower-postgres-graph",
      towerBaseUrl,
    };
  },

  async "memory.consolidateGraphContext"(input) {
    const matches = normaliseGraphMemoryMatches(input.matches);
    const entities = normaliseMemoryEntities(input.entities);
    const warnings = Array.isArray(input.warnings) ? input.warnings.map(String).filter(Boolean) : [];
    const maxChars = positiveInteger(input.maxChars, 6000, 50_000);
    const sources = matches.map((match) => ({
      id: match.id,
      entity: match.entity,
      entityType: match.entityType,
      title: match.title,
      source: match.source,
      score: match.score,
      excerpt: match.excerpt,
      labels: match.labels,
    }));
    const header = [
      "graphContext is potential context from long-term memory.",
      "Treat it as a guide, not authoritative truth.",
      "Consider it where relevant, and verify against current files, records, or user input before relying on it.",
    ].join(" ");
    const entityLine = entities.length
      ? `Searched entities: ${entities.map((entity) => `${entity.name} (${entity.type})`).join(", ")}.`
      : "No extracted entities were available.";
    const body = matches.length
      ? matches.map((match, index) => {
        const title = match.title || match.source || match.id;
        const source = match.source ? ` | source: ${match.source}` : "";
        const entity = match.entity ? ` | entity: ${match.entity}` : "";
        return `[${index + 1}] ${title}${entity}${source} | score: ${match.score.toFixed(3)}\n${match.excerpt}`;
      }).join("\n\n")
      : "No graph memory matches were found.";
    const warningText = warnings.length ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
    return {
      graphContext: truncateText(`${header}\n\n${entityLine}\n\n${body}${warningText}`, maxChars),
      graphContextSources: sources,
      graphContextEntities: entities,
      graphContextWarnings: warnings,
      graphContextAvailable: matches.length > 0,
    };
  },
};

function positiveInteger(value: unknown, fallback: number, max = 100): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function normaliseMemoryEntities(value: unknown): MemoryEntity[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => objectValue(item))
    .map((item) => {
      const name = String(item.name ?? "").trim();
      const query = String(item.query ?? name).trim();
      if (!name && !query) return null;
      return {
        name: name || query,
        type: String(item.type ?? "other").trim() || "other",
        reason: String(item.reason ?? "").trim(),
        query: query || name,
      };
    })
    .filter((item): item is MemoryEntity => Boolean(item));
}

function normaliseGraphMemoryMatches(value: unknown): GraphMemoryMatch[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => objectValue(item))
    .map((item) => ({
      id: String(item.id ?? item.source ?? item.title ?? crypto.randomUUID()),
      entity: String(item.entity ?? ""),
      entityType: String(item.entityType ?? "other"),
      title: String(item.title ?? ""),
      source: String(item.source ?? ""),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
      excerpt: String(item.excerpt ?? item.text ?? ""),
      labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
    }))
    .filter((item) => item.excerpt || item.title || item.source);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

async function fetchTowerPgJson(baseUrl: string, path: string, appNpub: string | null = null): Promise<Record<string, unknown>> {
  const url = joinUrl(baseUrl, path);
  const { token } = await signWithWingmanKey(url, "GET");
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: token,
  };
  if (appNpub) headers["x-flightdeck-pg-app-npub"] = appNpub;
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Tower PG request failed (${response.status}) ${path}${text ? `: ${truncateText(text, 240)}` : ""}`);
  }
  const payload = await response.json();
  return objectValue(payload);
}

async function postTowerPgJson(baseUrl: string, path: string, body: Record<string, unknown>, appNpub: string | null = null): Promise<Record<string, unknown>> {
  const url = joinUrl(baseUrl, path);
  const serialized = JSON.stringify(body);
  const bodyHash = createHash("sha256").update(serialized, "utf8").digest("hex");
  const { token } = await signWithWingmanKey(url, "POST", bodyHash);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: token,
    "content-type": "application/json",
  };
  if (appNpub) headers["x-flightdeck-pg-app-npub"] = appNpub;
  const response = await fetch(url, { method: "POST", headers, body: serialized });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const forbidden = response.status === 403 ? " daily_scope_forbidden: human must enable Daily Scope access for this agent." : "";
    throw new Error(`Tower PG request failed (${response.status}) ${path}${forbidden}${text ? `: ${truncateText(text, 240)}` : ""}`);
  }
  const payload = await response.json();
  return objectValue(payload);
}

async function patchTowerPgJson(baseUrl: string, path: string, body: Record<string, unknown>, appNpub: string | null = null): Promise<Record<string, unknown>> {
  const url = joinUrl(baseUrl, path);
  const serialized = JSON.stringify(body);
  const bodyHash = createHash("sha256").update(serialized, "utf8").digest("hex");
  const { token } = await signWithWingmanKey(url, "PATCH", bodyHash);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: token,
    "content-type": "application/json",
  };
  if (appNpub) headers["x-flightdeck-pg-app-npub"] = appNpub;
  const response = await fetch(url, { method: "PATCH", headers, body: serialized });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Tower PG request failed (${response.status}) ${path}${text ? `: ${truncateText(text, 240)}` : ""}`);
  }
  const payload = await response.json();
  return objectValue(payload);
}

function dedupeGraphMemoryMatches(matches: GraphMemoryMatch[]): GraphMemoryMatch[] {
  const byKey = new Map<string, GraphMemoryMatch>();
  for (const match of matches.sort((a, b) => b.score - a.score)) {
    const key = match.id || `${match.source}:${match.title}:${match.excerpt.slice(0, 80)}`;
    if (!byKey.has(key)) byKey.set(key, match);
  }
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
}

function getTowerGraphBaseUrl(input: JsonObject): string {
  const configured = typeof input.towerUrl === "string" && input.towerUrl.trim()
    ? input.towerUrl.trim()
    : envString("PIPELINE_TOWER_URL") || envString("TOWER_URL") || envString("WINGMAN_TOWER_URL") || "http://127.0.0.1:3100";
  return configured.replace(/\/+$/, "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function addTowerGraphQueryParam(params: URLSearchParams, name: string, value: unknown): void {
  const text = optionalString(value);
  if (text) params.set(name, text);
}

function firstOptionalString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return null;
}

function buildTowerGraphSearchUrl(
  towerBaseUrl: string,
  entity: MemoryEntity,
  input: JsonObject,
  limit: number,
): string {
  const url = new URL("/api/v4/graph/search", towerBaseUrl);
  url.searchParams.set("q", entity.query || entity.name);
  url.searchParams.set("limit", String(limit));
  addTowerGraphQueryParam(url.searchParams, "workspace_owner_npub", firstOptionalString(
    input.workspaceOwnerNpub,
    input.workspace_owner_npub,
    input.ownerNpub,
  ));
  addTowerGraphQueryParam(url.searchParams, "owner_npub", firstOptionalString(
    input.graphOwnerNpub,
    input.graph_owner_npub,
    input.memoryOwnerNpub,
    input.memory_owner_npub,
  ));
  addTowerGraphQueryParam(url.searchParams, "actor_npub", firstOptionalString(input.actorNpub, input.actor_npub));
  addTowerGraphQueryParam(url.searchParams, "visibility", input.visibility);
  addTowerGraphQueryParam(url.searchParams, "source_app_npub", firstOptionalString(input.sourceAppNpub, input.source_app_npub));
  addTowerGraphQueryParam(url.searchParams, "group_id", firstOptionalString(input.groupId, input.group_id));
  addTowerGraphQueryParam(url.searchParams, "source", input.source);
  addTowerGraphQueryParam(url.searchParams, "label", input.label);
  addTowerGraphQueryParam(url.searchParams, "relationship_type", firstOptionalString(input.relationshipType, input.relationship_type));
  return url.toString();
}

function normaliseTowerGraphSearchResults(payload: unknown, entity: MemoryEntity): GraphMemoryMatch[] {
  const results = objectValue(payload).results;
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => objectValue(item))
    .map((item) => {
      const properties = objectValue(item.properties);
      const kind = optionalString(item.kind) || "graph";
      const relationshipType = optionalString(item.relationship_type);
      const from = optionalString(item.from_external_id);
      const to = optionalString(item.to_external_id);
      const edgeSummary = relationshipType && from && to ? `${from} -[${relationshipType}]-> ${to}` : "";
      const title = firstOptionalString(
        item.title,
        properties.title,
        properties.name,
        item.external_id,
        relationshipType,
        item.memory_type,
        item.id,
      ) || "";
      const excerpt = firstOptionalString(
        item.summary,
        properties.summary,
        properties.description,
        properties.content,
        properties.text,
        edgeSummary,
        title,
      ) || "";
      const labels = Array.isArray(item.labels) ? item.labels.map(String).filter(Boolean) : [];
      const typedLabels = [
        kind,
        ...labels,
        optionalString(item.memory_type),
        relationshipType,
      ].filter((value): value is string => Boolean(value));
      return {
        id: String(item.id ?? item.external_id ?? title),
        entity: entity.name,
        entityType: entity.type,
        title,
        source: firstOptionalString(item.source, properties.source, properties.path, properties.url, properties.file) || "",
        score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
        excerpt,
        labels: Array.from(new Set(typedLabels)),
      };
    })
    .filter((item) => item.excerpt || item.title || item.source);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n\n[truncated]`;
}

type GraphMemoryConfig =
  | { ok: true; value: {
      neo4jHttpUrl: string;
      neo4jDatabase: string;
      neo4jUsername: string;
      neo4jPassword: string;
      neo4jVectorIndex: string;
      embeddingBaseUrl: string;
      embeddingApiKey: string;
      embeddingModel: string;
    } }
  | { ok: false; warning: string };

function getGraphMemoryConfig(input: JsonObject): GraphMemoryConfig {
  const neo4jHttpUrl = envString("PIPELINE_MEMORY_NEO4J_HTTP_URL")
    || envString("NEO4J_HTTP_URL")
    || neo4jUriAsHttp(envString("NEO4J_URI"));
  const neo4jUsername = envString("PIPELINE_MEMORY_NEO4J_USERNAME") || envString("NEO4J_USERNAME");
  const neo4jPassword = envString("PIPELINE_MEMORY_NEO4J_PASSWORD") || envString("NEO4J_PASSWORD");
  const neo4jVectorIndex = typeof input.index === "string" && input.index.trim()
    ? input.index.trim()
    : envString("PIPELINE_MEMORY_NEO4J_VECTOR_INDEX") || envString("NEO4J_VECTOR_INDEX") || "wingmen_context_embedding";
  const embeddingApiKey = envString("PIPELINE_MEMORY_EMBEDDING_API_KEY") || envString("OPENAI_API_KEY");
  if (!neo4jHttpUrl || !neo4jUsername || !neo4jPassword) {
    return { ok: false, warning: "Neo4j graph memory is not configured. Set NEO4J_HTTP_URL, NEO4J_USERNAME, and NEO4J_PASSWORD." };
  }
  if (!embeddingApiKey) {
    return { ok: false, warning: "Graph memory embeddings are not configured. Set OPENAI_API_KEY or PIPELINE_MEMORY_EMBEDDING_API_KEY." };
  }
  return {
    ok: true,
    value: {
      neo4jHttpUrl,
      neo4jDatabase: envString("PIPELINE_MEMORY_NEO4J_DATABASE") || envString("NEO4J_DATABASE") || "neo4j",
      neo4jUsername,
      neo4jPassword,
      neo4jVectorIndex,
      embeddingBaseUrl: envString("PIPELINE_MEMORY_EMBEDDING_BASE_URL") || envString("OPENAI_BASE_URL") || "https://api.openai.com/v1",
      embeddingApiKey,
      embeddingModel: envString("PIPELINE_MEMORY_EMBEDDING_MODEL") || "text-embedding-3-small",
    },
  };
}

function envString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function neo4jUriAsHttp(uri: string | null): string | null {
  if (!uri) return null;
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  return null;
}

async function embedGraphMemoryQuery(query: string, config: Extract<GraphMemoryConfig, { ok: true }>["value"]): Promise<number[]> {
  const response = await fetch(`${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: query,
    }),
  });
  if (!response.ok) {
    throw new Error(`embedding request failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
    throw new Error("embedding response did not include a numeric embedding");
  }
  return embedding as number[];
}

async function queryNeo4jVectorMemory(input: {
  embedding: number[];
  entity: MemoryEntity;
  topK: number;
  ownerNpub: string | null;
  config: Extract<GraphMemoryConfig, { ok: true }>["value"];
}): Promise<GraphMemoryMatch[]> {
  const statement = `
CALL db.index.vector.queryNodes($index, $topK, $embedding)
YIELD node, score
WITH node, score
WHERE $ownerNpub IS NULL OR node.owner_npub = $ownerNpub OR node.ownerNpub = $ownerNpub
RETURN
  elementId(node) AS id,
  labels(node) AS labels,
  coalesce(node.title, node.name, node.path, node.source, "") AS title,
  coalesce(node.source, node.path, node.url, node.file, "") AS source,
  coalesce(node.text, node.content, node.summary, node.description, "") AS excerpt,
  score
ORDER BY score DESC
`;
  const response = await fetch(`${input.config.neo4jHttpUrl.replace(/\/$/, "")}/db/${encodeURIComponent(input.config.neo4jDatabase)}/tx/commit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${btoa(`${input.config.neo4jUsername}:${input.config.neo4jPassword}`)}`,
    },
    body: JSON.stringify({
      statements: [{
        statement,
        parameters: {
          index: input.config.neo4jVectorIndex,
          topK: input.topK,
          embedding: input.embedding,
          ownerNpub: input.ownerNpub,
        },
      }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Neo4j vector query failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    errors?: Array<{ message?: string }>;
    results?: Array<{ data?: Array<{ row?: unknown[] }> }>;
  };
  const error = payload.errors?.find((item) => item.message);
  if (error?.message) throw new Error(`Neo4j vector query failed: ${error.message}`);
  const rows = payload.results?.[0]?.data ?? [];
  return rows.map((row) => {
    const values = Array.isArray(row.row) ? row.row : [];
    return {
      id: String(values[0] ?? ""),
      labels: Array.isArray(values[1]) ? values[1].map(String) : [],
      title: String(values[2] ?? ""),
      source: String(values[3] ?? ""),
      excerpt: truncateText(String(values[4] ?? ""), 1200),
      score: Number.isFinite(Number(values[5])) ? Number(values[5]) : 0,
      entity: input.entity.name,
      entityType: input.entity.type,
    };
  }).filter((match) => match.id || match.excerpt || match.title);
}
