import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DeclarativeFunction, DeclarativePipeline, DeclarativeStep } from '../../pipelines/declarative';
import type { JsonObject } from '../../pipelines/pipeline-store';
import { generateSpeechAudio, normalizeSpeechText, resolveSpeechExtension } from '../../server/audio-speech';
import { generateSpeechSummary } from '../../server/speech-summary';
import type { SessionApiContext } from '../../server/session-api-routes';
import type { AgentDefinitionRecord, RuntimeBotIdentity } from '../types';
import { buildDirectChatRoutingKey } from '../direct-chat-contract';
import type { DuplicateCallbackPublicationFilter } from '../duplicate-callback-publication-filter';
import {
  acquireFlightDeckPgEditLease,
  assignFlightDeckPgTask,
  createFlightDeckPgAudioNote,
  createFlightDeckPgChannelDocument,
  createFlightDeckPgChannelMessage,
  createFlightDeckPgChannelTask,
  createFlightDeckPgReaction,
  createFlightDeckPgTaskComment,
  decodeFlightDeckPgDocumentBody,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgDocument,
  fetchFlightDeckPgDocumentComments,
  fetchFlightDeckPgTask,
  fetchFlightDeckPgTaskComments,
  fetchFlightDeckPgWorkspaceMembers,
  listFlightDeckPgChannelDocs,
  uploadFlightDeckPgStorageObject,
  upsertFlightDeckPgResponseActivity,
  updateFlightDeckPgTaskState,
  type FlightDeckPgMessage,
} from '../tower-client';
import type { DispatchPipelineEventInput } from './runtime';

export interface DispatchPipelineFlightDeckRuntime {
  mode: 'flightdeck_pg' | 'unavailable';
  yokeStateDir: string | null;
  commandPrefix: string | null;
  commands: Record<string, string>;
  error: string | null;
}

export interface DispatchPipelineFlightDeckPublisherContext {
  eventInput: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
  botIdentity: RuntimeBotIdentity | null;
  runtime: DispatchPipelineFlightDeckRuntime;
  userSettingsStore?: SessionApiContext['userSettingsStore'] | null;
  publicationFilter?: DuplicateCallbackPublicationFilter;
}

function dispatchChatPublicationIdentity(
  context: DispatchPipelineFlightDeckPublisherContext,
  channelId: string,
  threadId: string,
): { decisionId: string; routingKey: string; subscriptionId: string; agentNpub: string } | null {
  const workspaceId = getText(context.eventInput.subscription.workspaceId);
  const agentNpub = context.botIdentity?.botNpub;
  if (!workspaceId || !agentNpub) return null;
  const towerServiceNpub = getText(context.eventInput.subscription.towerServiceNpub)
    ?? context.eventInput.subscription.backendBaseUrl;
  return {
    decisionId: [
      'dispatch-chat',
      context.eventInput.subscription.subscriptionId,
      context.eventInput.recordId,
      String(context.eventInput.recordVersion ?? 0),
      channelId,
      threadId,
      agentNpub,
    ].join(':'),
    routingKey: buildDirectChatRoutingKey({ towerServiceNpub, workspaceId, channelId, threadId, agentNpub }),
    subscriptionId: context.eventInput.subscription.subscriptionId,
    agentNpub,
  };
}

const KNOWN_TASK_STATES = new Set([
  'new',
  'ready',
  'in_progress',
  'review',
  'done',
  'blocked',
  'cancelled',
]);

const CHAT_REPLY_TTS_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const CHAT_REPLY_TTS_DEFAULT_MODEL = 'hexgrad/kokoro-82m';
const CHAT_REPLY_TTS_DEFAULT_VOICE = 'af_heart';
const CHAT_REPLY_TTS_DEFAULT_FORMAT = 'mp3';
const CHAT_REPLY_TTS_DEFAULT_SUMMARY_MODEL = 'openai/gpt-4o-mini';
const CHAT_REPLY_TTS_MAX_TEXT_LENGTH = 8000;
const IMPLEMENTATION_REVIEW_DOC_SNAPSHOT_FALLBACK_DIR = join(tmpdir(), 'wingman', 'implementation-review-docs');

function isPrivateAgentSoftwareWorkdir(value: string | null | undefined): boolean {
  const workdir = getText(value);
  return !workdir
    || workdir.includes('/data/agent-chat-workspaces/')
    || /\/wingmen\/wingman\d+(?:\/|$)/.test(workdir);
}

function resolveImplementationReviewWorkdir(
  input: JsonObject,
  workPlan: JsonObject,
  context: DispatchPipelineFlightDeckPublisherContext,
): string {
  const explicitWorkdir = getText(workPlan.workdir ?? workPlan.workingDirectory)
    ?? getText(input.workingDirectory);
  if (explicitWorkdir) {
    return explicitWorkdir;
  }
  const agentWorkdir = context.agent?.workingDirectory;
  if (isPrivateAgentSoftwareWorkdir(agentWorkdir)) {
    throw new Error('Software implementation review workdir is required; refusing to use private agent workspace as the target repo.');
  }
  return agentWorkdir!;
}

export function pipelineNeedsFlightDeckPublisher(pipeline: DeclarativePipeline): boolean {
  return pipeline.steps.some(stepNeedsFlightDeckPublisher);
}

function isFlightDeckPgDispatch(input: DispatchPipelineEventInput): boolean {
  return Boolean(input.subscription.workspaceId);
}

function isFlightDeckPgPublisherContext(context: DispatchPipelineFlightDeckPublisherContext): boolean {
  return context.runtime.mode === 'flightdeck_pg' && isFlightDeckPgDispatch(context.eventInput);
}

function canUseFlightDeckRuntime(context: DispatchPipelineFlightDeckPublisherContext): boolean {
  if (!context.botIdentity) {
    return false;
  }
  return isFlightDeckPgPublisherContext(context);
}

function normaliseSpeechTranscript(value: string): string {
  return normalizeSpeechText(value).slice(0, CHAT_REPLY_TTS_MAX_TEXT_LENGTH);
}

function speechPreview(value: string): string {
  return normaliseSpeechTranscript(value).split(/\s+/).slice(0, 18).join(' ');
}

function getFlightDeckPublishSpeechSettings(context: DispatchPipelineFlightDeckPublisherContext): {
  enabled: boolean;
  mode: 'summary' | 'full';
  provider: 'openrouter' | 'local';
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  format: string;
  summaryBaseUrl: string;
  summaryModel: string;
} | null {
  const settingsNpub = context.eventInput.subscription.workspaceOwnerNpub?.trim()
    || context.eventInput.subscription.managedByNpub?.trim()
    || context.eventInput.updaterNpub?.trim()
    || null;
  if (!settingsNpub || typeof context.userSettingsStore?.getAll !== 'function') {
    return null;
  }
  const settings = context.userSettingsStore.getAll(settingsNpub);
  const enabled = settings.speech_chat_replies_enabled === 'true';
  if (!enabled) return null;
  const provider = settings.speech_provider === 'local' ? 'local' : 'openrouter';
  const apiKey = provider === 'local'
    ? ''
    : settings.speech_api_key?.trim()
      || settings.openrouter_api_key?.trim()
      || settings.openai_api_key?.trim()
      || '';
  if (!apiKey && provider !== 'local') {
    return null;
  }
  const baseUrl = settings.speech_base_url?.trim()
    || (provider === 'local' ? 'http://127.0.0.1:8880/v1' : CHAT_REPLY_TTS_DEFAULT_BASE_URL);
  return {
    enabled,
    mode: settings.speech_chat_replies_mode === 'full' ? 'full' : 'summary',
    provider,
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    model: settings.speech_model?.trim()
      || (provider === 'local' ? 'kokoro' : CHAT_REPLY_TTS_DEFAULT_MODEL),
    voice: settings.speech_voice?.trim()
      || (provider === 'local' ? 'af_heart' : CHAT_REPLY_TTS_DEFAULT_VOICE),
    format: settings.speech_format?.trim() || CHAT_REPLY_TTS_DEFAULT_FORMAT,
    summaryBaseUrl: settings.speech_summary_base_url?.trim()
      || (provider === 'local' ? 'http://127.0.0.1:11434/v1' : CHAT_REPLY_TTS_DEFAULT_BASE_URL),
    summaryModel: settings.speech_summary_model?.trim()
      || (provider === 'local' ? 'gemma3:4b' : CHAT_REPLY_TTS_DEFAULT_SUMMARY_MODEL),
  };
}

async function generateFlightDeckPublishSpeech(context: DispatchPipelineFlightDeckPublisherContext, input: {
  body: string;
  userPrompt?: string | null;
}): Promise<{
  audio: Uint8Array;
  mimeType: string;
  model: string;
  voice: string;
  format: string;
  transcript: string;
  summary: string;
} | null> {
  const settings = getFlightDeckPublishSpeechSettings(context);
  if (!settings) return null;

  let transcript = normaliseSpeechTranscript(input.body);
  if (!transcript) return null;
  if (settings.mode === 'summary') {
    try {
      transcript = await generateSpeechSummary({
        userPrompt: input.userPrompt ?? '',
        agentResponse: input.body,
        config: {
          apiKey: settings.apiKey,
          baseUrl: settings.summaryBaseUrl,
          model: settings.summaryModel,
        },
      });
    } catch (error) {
      console.warn('[dispatch-publisher] chat reply TTS summary failed; using full reply text', error);
    }
  }

  const generated = await generateSpeechAudio({
    text: transcript,
    config: {
      provider: settings.provider,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      voice: settings.voice,
      format: settings.format,
    },
  });
  return {
    ...generated,
    transcript,
    summary: transcript,
  };
}

function getPublishedPgMessageId(result: unknown): string | null {
  const message = objectValue(objectValue(result)?.message);
  return getText(message.id) ?? getText(objectValue(result)?.message_id) ?? null;
}

function getPublishedPgTaskCommentId(result: unknown): string | null {
  const comment = objectValue(objectValue(result)?.comment);
  return getText(comment.id) ?? getText(objectValue(result)?.comment_id) ?? null;
}

function resolveFlightDeckPgChannelId(context: DispatchPipelineFlightDeckPublisherContext, fallback?: string | null): string | null {
  return getText(fallback)
    ?? context.eventInput.channelId
    ?? getText(context.eventInput.payload.channel_id)
    ?? getText(context.eventInput.payload.pg_channel_id)
    ?? getText(objectValue(context.eventInput.record).channel_id)
    ?? getText(objectValue(objectValue(context.eventInput.record).payload).channel_id)
    ?? null;
}

function getFlightDeckPgPublishContext(context: DispatchPipelineFlightDeckPublisherContext): {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
} {
  if (!context.botIdentity) {
    throw new Error('No runtime bot identity was available.');
  }
  const workspaceId = getText(context.eventInput.subscription.workspaceId);
  if (!workspaceId) {
    throw new Error('Flight Deck PG publish requires a workspace id.');
  }
  return {
    backendBaseUrl: context.eventInput.subscription.backendBaseUrl,
    workspaceId,
    appNpub: context.eventInput.subscription.sourceAppNpub,
    botIdentity: context.botIdentity,
  };
}

async function attachFlightDeckPgSpeechToTarget(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    channelId?: string | null;
    threadId?: string | null;
    targetType: 'message' | 'task_comment' | 'task';
    targetId?: string | null;
    body: string;
    title: string;
    filePrefix: string;
    userPrompt?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<JsonObject> {
  const targetId = getText(input.targetId);
  if (!targetId) {
    return {
      status: 'skipped',
      reason: 'target_id_missing',
    };
  }
  const channelId = resolveFlightDeckPgChannelId(context, input.channelId);
  if (!channelId) {
    return {
      status: 'skipped',
      reason: 'channel_id_missing',
    };
  }
  try {
    const pg = getFlightDeckPgPublishContext(context);
    const speech = await generateFlightDeckPublishSpeech(context, {
      body: input.body,
      userPrompt: input.userPrompt,
    });
    if (!speech) {
      return {
        status: 'skipped',
        reason: 'speech_not_configured',
      };
    }
    const storage = await uploadFlightDeckPgStorageObject({
      backendBaseUrl: pg.backendBaseUrl,
      workspaceId: pg.workspaceId,
      appNpub: pg.appNpub,
      botIdentity: pg.botIdentity,
      fileName: `${input.filePrefix}-${targetId}${resolveSpeechExtension(speech.format)}`,
      contentType: speech.mimeType,
      content: speech.audio,
    });
    const audioNote = await createFlightDeckPgAudioNote({
      backendBaseUrl: pg.backendBaseUrl,
      workspaceId: pg.workspaceId,
      channelId,
      appNpub: pg.appNpub,
      botIdentity: pg.botIdentity,
      storageObjectId: storage.object_id,
      mimeType: speech.mimeType,
      title: input.title,
      targetType: input.targetType,
      targetId,
      threadId: input.threadId ?? context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id),
      sizeBytes: speech.audio.byteLength,
      transcriptPreview: speechPreview(speech.transcript),
      transcriptText: speech.transcript,
      transcriptStatus: 'done',
      summary: speech.summary,
      metadata: {
        autopilot_dispatch_tts: true,
        target_type: input.targetType,
        model: speech.model,
        voice: speech.voice,
        format: speech.format,
        ...(input.metadata ?? {}),
      },
    });
    return {
      status: 'ok',
      storageObjectId: storage.object_id,
      audioNoteId: getText(objectValue(audioNote.audio_note)?.id),
    };
  } catch (error) {
    console.warn('[dispatch-publisher] Flight Deck PG speech attachment failed', error);
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createFlightDeckPgChannelMessageFromContext(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    channelId: string;
    body: string;
    threadId?: string | null;
    createThread?: boolean;
    metadata?: Record<string, unknown> | null;
    speechTitle?: string;
    speechFilePrefix?: string;
    speechMode?: 'await' | 'background' | 'disabled';
    userPrompt?: string | null;
  },
): Promise<JsonObject> {
  const pg = getFlightDeckPgPublishContext(context);
  const result = await createFlightDeckPgChannelMessage({
    backendBaseUrl: pg.backendBaseUrl,
    workspaceId: pg.workspaceId,
    channelId: input.channelId,
    appNpub: pg.appNpub,
    botIdentity: pg.botIdentity,
    body: input.body,
    threadId: input.threadId,
    createThread: input.createThread,
    metadata: input.metadata ?? null,
  });
  const messageId = getPublishedPgMessageId(result);
  const speechInput = {
    channelId: input.channelId,
    threadId: input.threadId,
    targetType: 'message',
    targetId: messageId,
    body: input.body,
    title: input.speechTitle ?? 'Spoken message summary',
    filePrefix: input.speechFilePrefix ?? 'flightdeck-message-tts',
    userPrompt: input.userPrompt,
  } as const;
  const speechMode = input.speechMode ?? 'await';
  if (speechMode === 'disabled') {
    return {
      ...objectValue(result),
      speech: {
        status: 'skipped',
        reason: 'speech_disabled',
      },
    };
  }
  if (speechMode === 'background') {
    void attachFlightDeckPgSpeechToTarget(context, speechInput).then((speech) => {
      if (speech.status === 'failed') {
        console.warn('[dispatch-publisher] background Flight Deck PG speech attachment failed', speech);
      }
    }).catch((error) => {
      console.warn('[dispatch-publisher] background Flight Deck PG speech attachment crashed', error);
    });
    return {
      ...objectValue(result),
      speech: {
        status: 'queued',
        targetType: 'message',
        targetId: messageId,
      },
    };
  }
  const speech = await attachFlightDeckPgSpeechToTarget(context, speechInput);
  return {
    ...objectValue(result),
    speech,
  };
}

async function setFlightDeckPgThreadResponseActivity(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    status: 'queued' | 'thinking' | 'drafting' | 'publishing' | 'failed' | 'cleared';
    label?: string | null;
    message?: string | null;
    severity?: 'info' | 'warning' | 'error';
    expiresInSeconds?: number;
    pipelineRunId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<JsonObject> {
  if (!canUseFlightDeckRuntime(context)) {
    return {
      updated: false,
      status: 'skipped',
      operation: 'response-activity.set',
      reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
    };
  }
  const threadId = context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id);
  if (!threadId) {
    return {
      updated: false,
      status: 'skipped',
      operation: 'response-activity.set',
      reason: 'missing_thread_id',
    };
  }
  const pg = getFlightDeckPgPublishContext(context);
  const result = await upsertFlightDeckPgResponseActivity({
    ...pg,
    targetType: 'chat_thread',
    targetId: threadId,
    status: input.status,
    severity: input.severity ?? (input.status === 'failed' ? 'error' : 'info'),
    label: input.label ?? null,
    message: input.message ?? null,
    pipelineRunId: input.pipelineRunId ?? null,
    sourceMessageId: context.eventInput.recordId,
    activityType: 'agent_response',
    expiresInSeconds: input.expiresInSeconds ?? (input.status === 'failed' ? 300 : 90),
    metadata: {
      autopilot_dispatch: true,
      trigger_kind: context.eventInput.triggerKind,
      subscription_id: context.eventInput.subscription.subscriptionId,
      ...(input.metadata ?? {}),
    },
  });
  return {
    updated: true,
    status: input.status,
    operation: 'response-activity.set',
    targetType: 'chat_thread',
    targetId: threadId,
    result,
  };
}

export function createDispatchResponseActivityPublisher(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    const status = getText(input.status) as 'queued' | 'thinking' | 'drafting' | 'publishing' | 'failed' | 'cleared' | null;
    const allowed = new Set(['queued', 'thinking', 'drafting', 'publishing', 'failed', 'cleared']);
    if (!status || !allowed.has(status)) {
      return {
        updated: false,
        status: 'skipped',
        operation: 'response-activity.set',
        reason: 'status must be queued, thinking, drafting, publishing, failed, or cleared',
      };
    }
    return await setFlightDeckPgThreadResponseActivity(context, {
      status,
      label: getText(input.label),
      message: getText(input.message),
      severity: getText(input.severity) as 'info' | 'warning' | 'error' | undefined,
      expiresInSeconds: Number(input.expiresInSeconds ?? input.expires_in_seconds) || undefined,
      pipelineRunId: getText(input.pipelineRunId ?? input.pipeline_run_id),
      metadata: objectValue(input.metadata),
    });
  };
}

async function createFlightDeckPgTaskFromContext(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    title: string;
    description?: string | null;
    state: 'new' | 'in_progress' | 'review' | 'done' | 'blocked' | 'cancelled';
    metadata?: Record<string, unknown> | null;
  },
): Promise<JsonObject> {
  const pg = getFlightDeckPgPublishContext(context);
  const channelId = context.eventInput.channelId ?? getText(context.eventInput.payload.channel_id);
  if (!channelId) {
    throw new Error('Flight Deck PG task creation requires a channel id.');
  }
  return await createFlightDeckPgChannelTask({
    backendBaseUrl: pg.backendBaseUrl,
    workspaceId: pg.workspaceId,
    channelId,
    appNpub: pg.appNpub,
    botIdentity: pg.botIdentity,
    title: input.title,
    description: input.description ?? null,
    state: input.state,
    priority: 'sand',
    threadId: context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id),
    metadata: input.metadata ?? null,
  }) as JsonObject;
}

async function resolveFlightDeckPgActorIdByNpub(
  context: DispatchPipelineFlightDeckPublisherContext,
  actorNpub: string | null,
): Promise<string | null> {
  if (!actorNpub) return null;
  const pg = getFlightDeckPgPublishContext(context);
  const result = await fetchFlightDeckPgWorkspaceMembers({
    backendBaseUrl: pg.backendBaseUrl,
    workspaceId: pg.workspaceId,
    appNpub: pg.appNpub,
    botIdentity: pg.botIdentity,
  });
  for (const member of result.members) {
    const actor = objectValue(member.actor);
    if (getText(actor.npub) === actorNpub) {
      return getText(actor.actor_id) ?? getText(actor.id);
    }
  }
  return null;
}

async function assignFlightDeckPgTaskToNpub(
  context: DispatchPipelineFlightDeckPublisherContext,
  taskId: string,
  assigneeNpub: string | null,
): Promise<{
  status: 'skipped' | 'ok' | 'not_found' | 'failed';
  assigneeNpub: string | null;
  actorId: string | null;
  result: unknown;
  error: string | null;
}> {
  if (!assigneeNpub) {
    return { status: 'skipped', assigneeNpub, actorId: null, result: null, error: 'missing_assignee_npub' };
  }
  try {
    const actorId = await resolveFlightDeckPgActorIdByNpub(context, assigneeNpub);
    if (!actorId) {
      return { status: 'not_found', assigneeNpub, actorId: null, result: null, error: 'assignee_not_workspace_member' };
    }
    const pg = getFlightDeckPgPublishContext(context);
    const result = await assignFlightDeckPgTask({
      backendBaseUrl: pg.backendBaseUrl,
      workspaceId: pg.workspaceId,
      taskId,
      appNpub: pg.appNpub,
      botIdentity: pg.botIdentity,
      actorId,
    });
    return { status: 'ok', assigneeNpub, actorId, result, error: null };
  } catch (error) {
    return {
      status: 'failed',
      assigneeNpub,
      actorId: null,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createFlightDeckPgTaskCommentFromContext(
  context: DispatchPipelineFlightDeckPublisherContext,
  taskId: string,
  body: string,
  metadata?: Record<string, unknown> | null,
): Promise<JsonObject> {
  const pg = getFlightDeckPgPublishContext(context);
  const result = await createFlightDeckPgTaskComment({
    backendBaseUrl: pg.backendBaseUrl,
    workspaceId: pg.workspaceId,
    taskId,
    appNpub: pg.appNpub,
    botIdentity: pg.botIdentity,
    body,
    threadId: context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id),
    metadata: {
      ...(metadata ?? {}),
      source_message_id: context.eventInput.recordId,
      subscription_id: context.eventInput.subscription.subscriptionId,
    },
  });
  const commentId = getPublishedPgTaskCommentId(result);
  let channelId = resolveFlightDeckPgChannelId(context);
  let threadId = context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id);
  if (!channelId) {
    try {
      const task = await fetchFlightDeckPgTask({
        backendBaseUrl: pg.backendBaseUrl,
        workspaceId: pg.workspaceId,
        taskId,
        appNpub: pg.appNpub,
        botIdentity: pg.botIdentity,
      });
      const taskRow = objectValue(task.task);
      channelId = getText(taskRow.channel_id);
      threadId = threadId ?? getText(taskRow.thread_id);
    } catch (error) {
      console.warn('[dispatch-publisher] could not resolve Flight Deck PG task channel for speech attachment', error);
    }
  }
  const speech = await attachFlightDeckPgSpeechToTarget(context, {
    channelId,
    threadId,
    targetType: 'task_comment',
    targetId: commentId,
    body,
    title: 'Spoken task comment summary',
    filePrefix: 'flightdeck-task-comment-tts',
    userPrompt: getText(context.eventInput.payload.body),
    metadata: {
      task_id: taskId,
    },
  });
  return {
    ...objectValue(result),
    speech,
  };
}

async function updateFlightDeckPgTaskStateWithLease(
  context: DispatchPipelineFlightDeckPublisherContext,
  taskId: string,
  state: string,
): Promise<JsonObject> {
  const pg = getFlightDeckPgPublishContext(context);
  const taskResult = await fetchFlightDeckPgTask({
    backendBaseUrl: pg.backendBaseUrl,
    workspaceId: pg.workspaceId,
    taskId,
    appNpub: pg.appNpub,
    botIdentity: pg.botIdentity,
  });
  const rowVersion = Number(taskResult.task?.row_version);
  if (!Number.isFinite(rowVersion) || rowVersion <= 0) {
    throw new Error(`Flight Deck PG task ${taskId} did not include a valid row_version.`);
  }
  const leaseResult = await acquireFlightDeckPgEditLease({
    backendBaseUrl: pg.backendBaseUrl,
    workspaceId: pg.workspaceId,
    appNpub: pg.appNpub,
    botIdentity: pg.botIdentity,
    entityType: 'task',
    entityId: taskId,
    ttlSeconds: 120,
  });
  const leaseToken = getText(leaseResult.lease?.lease_token);
  if (!leaseToken) {
    throw new Error(`Flight Deck PG task ${taskId} edit lease did not include a token.`);
  }
  return await updateFlightDeckPgTaskState({
    backendBaseUrl: pg.backendBaseUrl,
    workspaceId: pg.workspaceId,
    taskId,
    appNpub: pg.appNpub,
    botIdentity: pg.botIdentity,
    state,
    rowVersion,
    leaseToken,
  }) as JsonObject;
}

export async function prepareDispatchPipelineFlightDeckRuntime(input: {
  eventInput: DispatchPipelineEventInput;
  agent: AgentDefinitionRecord | null;
}): Promise<DispatchPipelineFlightDeckRuntime> {
  const botIdentity = input.eventInput.botIdentity ?? null;
  if (isFlightDeckPgDispatch(input.eventInput)) {
    return {
      mode: botIdentity ? 'flightdeck_pg' : 'unavailable',
      yokeStateDir: null,
      commandPrefix: null,
      commands: {},
      error: botIdentity ? null : 'No runtime bot identity was available.',
    };
  }
  return {
    mode: 'unavailable',
    yokeStateDir: null,
    commandPrefix: null,
    commands: {},
    error: 'Flight Deck PG workspace context is required; Yoke fallback is disabled.',
  };
}

export function createDispatchFlightDeckPublisher(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      return {
        published: false,
        status: 'failed',
        operation: 'flightdeck_publish',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }

    try {
      const triggerKind = context.eventInput.triggerKind;
      if (triggerKind === 'chat') {
        return await publishChatReply(context, input);
      }
      if (triggerKind === 'task') {
        return await publishTaskUpdate(context, input, 'task_dispatch');
      }
      if (triggerKind === 'task_review') {
        return await publishTaskUpdate(context, input, 'task_review');
      }
      if (triggerKind === 'comment') {
        return await publishCommentReply(context, input);
      }
      return {
        published: false,
        status: 'skipped',
        operation: 'flightdeck_publish',
        reason: `Unsupported dispatch trigger kind: ${triggerKind}`,
      };
    } catch (error) {
      const enriched = error as Error & {
        status?: number;
        detailCode?: string | null;
        details?: unknown;
      };
      return {
        published: false,
        status: 'failed',
        operation: 'flightdeck_publish',
        reason: error instanceof Error ? error.message : String(error),
        ...(typeof enriched.status === 'number' ? { httpStatus: enriched.status } : {}),
        ...(enriched.detailCode ? { detailCode: enriched.detailCode } : {}),
        ...(enriched.details !== undefined ? { details: enriched.details } : {}),
      };
    }
  };
}

export function createDispatchChatContextHydrator(
  context: DispatchPipelineFlightDeckPublisherContext,
  operation: 'chat.hydrate-context' | 'chat.reload-thread' = 'chat.hydrate-context',
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      return {
        hydrated: false,
        status: 'failed',
        operation,
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    if (context.eventInput.triggerKind !== 'chat') {
      return {
        hydrated: false,
        status: 'skipped',
        operation,
        reason: `Unsupported dispatch trigger kind: ${context.eventInput.triggerKind}`,
      };
    }

    const channelId = context.eventInput.channelId ?? getText(context.eventInput.payload.channel_id);
    const threadId = context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id);
    if (!channelId || !threadId) {
      throw new Error('Chat hydration requires channelId and threadId.');
    }

    const hydratedThread = await hydrateChatThreadWithFallback(context, channelId, threadId);
    const thread = hydratedThread.thread;
    const channelContext = resolveHydratedChannelContext(input, channelId);
    const selfAuthored = detectSelfAuthoredChatDispatch(context, input, thread);
    const intakeAcknowledgement = objectValue(objectValue(input.runtime).acknowledgement);
    const acknowledgement = !selfAuthored.selfAuthored && operation === 'chat.hydrate-context'
      ? isChatAcknowledgementResult(intakeAcknowledgement)
        ? intakeAcknowledgement
        : await acknowledgeChatDispatchMessage(context, channelId)
      : {
          acknowledged: false,
          status: 'skipped',
          operation: 'chat.acknowledge-message',
          reason: selfAuthored.selfAuthored ? 'self_authored_dispatch' : 'not_initial_hydration',
        };
    let scopes: unknown = [];
    let referencedRecords: Array<Record<string, unknown>> = [];
    if (!selfAuthored.selfAuthored) {
      if (isFlightDeckPgPublisherContext(context)) {
        scopes = [];
        referencedRecords = await loadReferencedFlightDeckPgDocuments(context, thread, channelId);
      } else {
        try {
          scopes = await runYokeJson(context, ['scopes', 'list', '--json']);
        } catch (error) {
          scopes = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        referencedRecords = await loadMentionedFlightDeckRecords(context, thread);
      }
    }

    return {
      hydrated: hydratedThread.hydrated,
      status: selfAuthored.selfAuthored ? 'skipped' : hydratedThread.status,
      operation,
      shouldProceed: !selfAuthored.selfAuthored,
      selfAuthored: selfAuthored.selfAuthored,
      suppressionReason: selfAuthored.reason,
      matchedSelfNpub: selfAuthored.matchedSelfNpub,
      channelId,
      threadId,
      channelContext,
      thread,
      acknowledgement,
      hydrationWarnings: hydratedThread.warnings,
      fallbackContext: hydratedThread.fallbackContext,
      scopes,
      referencedRecords,
      availablePipelines: Array.isArray(input.availablePipelines) ? input.availablePipelines : [],
    };
  };
}

export async function acknowledgeChatDispatchMessage(
  context: DispatchPipelineFlightDeckPublisherContext,
  channelId: string,
): Promise<JsonObject> {
  try {
    if (isFlightDeckPgPublisherContext(context)) {
      const pg = getFlightDeckPgPublishContext(context);
      const result = await createFlightDeckPgReaction({
        backendBaseUrl: pg.backendBaseUrl,
        workspaceId: pg.workspaceId,
        appNpub: pg.appNpub,
        botIdentity: pg.botIdentity,
        targetType: 'message',
        targetId: context.eventInput.recordId,
        emoji: 'thumbs_up',
        metadata: {
          autopilot_dispatch: true,
          channel_id: channelId,
          subscription_id: context.eventInput.subscription.subscriptionId,
        },
      });
      return {
        acknowledged: true,
        status: 'ok',
        operation: 'chat.acknowledge-message',
        emoji: 'thumbs_up',
        targetMessageId: context.eventInput.recordId,
        result,
      };
    }
    const result = await runYokeJson(context, [
      'chat',
      'react',
      '--channel',
      channelId,
      '--message',
      context.eventInput.recordId,
      '--emoji',
      'shaka',
      '--skip-refresh',
      '--format',
      'json',
    ]);
    return {
      acknowledged: true,
      status: 'ok',
      operation: 'chat.acknowledge-message',
      emoji: 'shaka',
      targetMessageId: context.eventInput.recordId,
      result,
    };
  } catch (error) {
    return {
      acknowledged: false,
      status: 'failed',
      operation: 'chat.acknowledge-message',
      emoji: isFlightDeckPgPublisherContext(context) ? 'thumbs_up' : 'shaka',
      targetMessageId: context.eventInput.recordId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function isChatAcknowledgementResult(value: Record<string, unknown>): value is JsonObject {
  return value.operation === 'chat.acknowledge-message'
    && typeof value.status === 'string'
    && typeof value.acknowledged === 'boolean';
}

export function createDispatchChatThreadReloader(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return createDispatchChatContextHydrator(context, 'chat.reload-thread');
}

export function createDispatchDiscussionDocumentEnsurer(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      return {
        ensured: false,
        status: 'failed',
        operation: 'docs.ensure-discussion-document',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    const existing = findDiscussionDocumentReference(input);
    if (existing.documentId) {
      return {
        ensured: true,
        status: 'reused',
        operation: 'docs.ensure-discussion-document',
        documentId: existing.documentId,
        documentTitle: existing.documentTitle ?? 'Discussion document',
        documentUrl: existing.documentUrl,
        documentMention: mention('document', existing.documentId, existing.documentTitle ?? 'Discussion document'),
      };
    }

    const workPlan = objectValue(input.workPlan ?? objectValue(input.decision).discussionWorkPlan);
    if (isFlightDeckPgPublisherContext(context)) {
      const titleMatch = await findFlightDeckPgDiscussionDocumentByTitle(context, input, workPlan);
      if (titleMatch.documentId) {
        return {
          ensured: true,
          status: 'reused',
          operation: 'docs.ensure-discussion-document',
          documentId: titleMatch.documentId,
          documentTitle: titleMatch.documentTitle ?? 'Discussion document',
          documentUrl: null,
          documentMention: mention('document', titleMatch.documentId, titleMatch.documentTitle ?? 'Discussion document'),
          lookup: titleMatch.lookup,
        };
      }
    }

    const title = buildDiscussionDocumentTitle(input, workPlan);
    const body = buildDiscussionDocumentScaffold(input, workPlan, title);
    if (isFlightDeckPgPublisherContext(context)) {
      const channelId = resolveFlightDeckPgChannelId(context, getText(workPlan.channelId ?? objectValue(workPlan.origin).channelId));
      if (!channelId) {
        return {
          ensured: false,
          status: 'failed',
          operation: 'docs.ensure-discussion-document',
          reason: 'Flight Deck PG channel id was not available for discussion document creation.',
        };
      }
      try {
        const result = await createFlightDeckPgChannelDocument({
          ...getFlightDeckPgPublishContext(context),
          channelId,
          title,
          body,
          summary: getText(workPlan.taskSummary),
          metadata: {
            autopilot_discussion_document: true,
            source_record_id: context.eventInput.recordId,
            source_channel_id: context.eventInput.channelId,
            source_thread_id: context.eventInput.threadId,
          },
        });
        const documentId = getText(objectValue(result.doc).id);
        if (!documentId) {
          return {
            ensured: false,
            status: 'failed',
            operation: 'docs.ensure-discussion-document',
            reason: 'Document creation succeeded but no document id was returned.',
            createResult: result,
          };
        }
        return {
          ensured: true,
          status: 'created',
          operation: 'docs.ensure-discussion-document',
          documentId,
          documentTitle: title,
          documentUrl: null,
          documentMention: mention('document', documentId, title),
          createResult: result,
        };
      } catch (error) {
        return {
          ensured: false,
          status: 'failed',
          operation: 'docs.ensure-discussion-document',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const scopeId = getText(workPlan.scopeId ?? objectValue(input.decision).scopeId);
    const args = [
      'docs',
      'create',
      '--title',
      title,
      '--body',
      body,
    ];
    if (scopeId) {
      args.push('--scope', scopeId);
    }
    args.push('--json');

    try {
      const result = await runYokeJson(context, args);
      const documentId = getCreatedRecordId(result);
      if (!documentId) {
        return {
          ensured: false,
          status: 'failed',
          operation: 'docs.ensure-discussion-document',
          reason: 'Document creation succeeded but no document id was returned.',
          createResult: result,
        };
      }
      return {
        ensured: true,
        status: 'created',
        operation: 'docs.ensure-discussion-document',
        documentId,
        documentTitle: title,
        documentUrl: null,
        documentMention: mention('document', documentId, title),
        createResult: result,
      };
    } catch (error) {
      return {
        ensured: false,
        status: 'failed',
        operation: 'docs.ensure-discussion-document',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createDispatchDocumentInvocationContextPreparer(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    const payload = objectValue(context.eventInput.payload ?? objectValue(input.record).payload);
    const target = objectValue(payload.target);
    const documentId = getText(context.eventInput.bindingId)
      ?? getText(payload.target_id)
      ?? getText(target.id);
    const documentTitleHint = getText(payload.target_title)
      ?? getText(target.title)
      ?? getText(payload.title);
    const prompt = getText(payload.prompt)
      ?? getText(payload.description)
      ?? getText(input.prompt)
      ?? '';
    const channelId = resolveFlightDeckPgChannelId(context, getText(input.channelId ?? payload.channel_id));
    const scopeId = getText(context.eventInput.scopeId ?? input.scopeId ?? payload.scope_id);
    const invocationId = getText(payload.invocation_id ?? payload.id ?? context.eventInput.recordId);
    const requesterNpub = getText(payload.created_by_npub ?? context.eventInput.updaterNpub);
    const channelContext = objectValue(objectValue(input.flightDeckContext).channel);

    if (!documentId) {
      return {
        status: 'failed',
        operation: 'docs.prepare-document-invocation',
        reason: 'Document invocation did not include a target document id.',
        invocation: { invocationId, prompt, requesterNpub },
      };
    }
    if (!canUseFlightDeckRuntime(context)) {
      return {
        status: 'failed',
        operation: 'docs.prepare-document-invocation',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
        invocation: { invocationId, prompt, requesterNpub },
        document: { documentId, title: documentTitleHint },
      };
    }

    const pg = getFlightDeckPgPublishContext(context);
    try {
      const [documentResult, commentsResult] = await Promise.all([
        fetchFlightDeckPgDocument({
          backendBaseUrl: pg.backendBaseUrl,
          workspaceId: pg.workspaceId,
          documentId,
          appNpub: pg.appNpub,
          botIdentity: pg.botIdentity,
          includeBody: true,
        }),
        fetchFlightDeckPgDocumentComments({
          backendBaseUrl: pg.backendBaseUrl,
          workspaceId: pg.workspaceId,
          documentId,
          appNpub: pg.appNpub,
          botIdentity: pg.botIdentity,
          limit: 200,
        }).catch((error) => ({
          comments: [],
          next_cursor: null,
          load_error: error instanceof Error ? error.message : String(error),
        })),
      ]);
      const doc = objectValue(documentResult.doc);
      const title = getText(doc.title) ?? documentTitleHint ?? 'Flight Deck document';
      const body = decodeFlightDeckPgDocumentBody(documentResult) ?? '';
      const comments = Array.isArray(commentsResult.comments) ? commentsResult.comments : [];
      const storageReferences = extractStorageReferences(body);
      const localPath = await writeDocumentInvocationSnapshot({
        workdir: getText(objectValue(input.agent).workingDirectory ?? objectValue(input.defaults).workdir),
        invocationId,
        documentId,
        title,
        rowVersion: doc.row_version ?? doc.rowVersion ?? null,
        prompt,
        body,
        comments,
        storageReferences,
      });
      return {
        status: 'loaded',
        operation: 'docs.prepare-document-invocation',
        invocation: {
          invocationId,
          prompt,
          requesterNpub,
          sourceSurface: getText(objectValue(payload.metadata).source_surface),
          createdByNpub: getText(payload.created_by_npub),
        },
        workspace: {
          workspaceId: pg.workspaceId,
          workspaceOwnerNpub: getText(objectValue(input.workspace).workspaceOwnerNpub),
          humanWorkspaceOwnerNpub: getText(objectValue(input.workspace).humanWorkspaceOwnerNpub),
          backendBaseUrl: pg.backendBaseUrl,
          appNpub: pg.appNpub,
        },
        location: {
          scopeId,
          channelId,
          channelName: getText(channelContext.name),
          channelContextPrompt: getText(channelContext.contextPrompt),
          hasSpecificChannelContext: channelContext.hasSpecificContext === true,
        },
        document: {
          documentId,
          title,
          mention: mention('document', documentId, title),
          rowVersion: doc.row_version ?? doc.rowVersion ?? null,
          bodyLength: body.length,
          bodyExcerpt: truncateBlock(body, 5000),
          bodyTruncated: body.length > 5000,
          localPath,
          storageReferences,
          comments: comments.slice(0, 50).map((comment) => {
            const item = objectValue(comment);
            return {
              commentId: getText(item.id),
              parentCommentId: getText(item.parent_comment_id ?? item.parentCommentId),
              authorNpub: getText(item.created_by_actor_npub ?? item.sender_npub),
              body: getText(item.body),
              createdAt: getText(item.created_at),
              updatedAt: getText(item.updated_at),
            };
          }),
          commentsLoadError: getText(objectValue(commentsResult).load_error),
        },
        guidance: [
          'This is a Flight Deck Postgres document invocation, not a chat thread.',
          'Use current Flight Deck PG helpers/MCP tools to refresh the document, download storage assets, edit the document, and create document comments when useful.',
          'Do not create a task unless the user explicitly asks for a task.',
          'Return structured closeout metadata only; the pipeline will post the channel summary.',
        ],
      };
    } catch (error) {
      return {
        status: 'failed',
        operation: 'docs.prepare-document-invocation',
        reason: error instanceof Error ? error.message : String(error),
        invocation: { invocationId, prompt, requesterNpub },
        document: {
          documentId,
          title: documentTitleHint,
          mention: mention('document', documentId, documentTitleHint ?? 'Flight Deck document'),
        },
      };
    }
  };
}

export function createDispatchDocumentInvocationSummaryPublisher(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      return {
        published: false,
        status: 'failed',
        operation: 'docs.publish-document-invocation-summary',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    if (!isFlightDeckPgPublisherContext(context)) {
      return {
        published: false,
        status: 'failed',
        operation: 'docs.publish-document-invocation-summary',
        reason: 'Flight Deck PG context is required.',
      };
    }
    const invocationContext = objectValue(input.invocationContext);
    const document = objectValue(invocationContext.document);
    const invocation = objectValue(invocationContext.invocation);
    const location = objectValue(invocationContext.location);
    const result = objectValue(input.agentResult ?? input.agentResponse ?? input.result);
    const documentId = getText(document.documentId ?? context.eventInput.bindingId);
    const title = getText(document.title) ?? getText(objectValue(context.eventInput.payload).target_title) ?? 'Flight Deck document';
    const documentMention = getText(document.mention) ?? (documentId ? mention('document', documentId, title) : title);
    const channelId = resolveFlightDeckPgChannelId(context, getText(location.channelId));
    if (!channelId) {
      return {
        published: false,
        status: 'failed',
        operation: 'docs.publish-document-invocation-summary',
        reason: 'Document invocation summary publish requires a channel id.',
        agentResult: result,
      };
    }
    const summary = getText(result.summary)
      ?? getText(result.updateSummary)
      ?? getText(result.reviewSummary)
      ?? getText(result.result)
      ?? 'I handled the document invocation.';
    const changedSections = getStringArray(result.changedSections);
    const commentsCreated = getStringArray(result.commentsCreated);
    const openQuestions = getStringArray(result.openQuestions);
    const body = [
      `I handled ${documentMention}.`,
      '',
      summary,
      ...formatList('Changed sections', changedSections),
      ...formatList('Comments/questions added', commentsCreated),
      ...formatList('Open questions', openQuestions),
    ].join('\n').trim();
    try {
      const publishResult = await createFlightDeckPgChannelMessageFromContext(context, {
        channelId,
        body: normalisePublishedMarkdownBody(body),
        createThread: true,
        metadata: {
          autopilot_dispatch: true,
          operation: 'docs.document-invocation-summary',
          invocation_id: getText(invocation.invocationId ?? context.eventInput.recordId),
          document_id: documentId,
          subscription_id: context.eventInput.subscription.subscriptionId,
        },
        speechMode: 'background',
        speechTitle: 'Document update summary',
        speechFilePrefix: 'document-invocation-summary',
        userPrompt: getText(invocation.prompt),
      });
      return {
        published: true,
        status: 'ok',
        operation: 'docs.publish-document-invocation-summary',
        channelId,
        documentId,
        result: publishResult,
        agentResult: result,
      };
    } catch (error) {
      return {
        published: false,
        status: 'failed',
        operation: 'docs.publish-document-invocation-summary',
        channelId,
        documentId,
        reason: error instanceof Error ? error.message : String(error),
        agentResult: result,
      };
    }
  };
}

export function createDispatchTaskInvocationContextPreparer(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    const payload = objectValue(context.eventInput.payload ?? objectValue(input.record).payload);
    const target = objectValue(payload.target);
    const taskId = getText(context.eventInput.bindingId)
      ?? getText(payload.target_id)
      ?? getText(target.id)
      ?? getText(payload.task_id);
    const taskTitleHint = getText(payload.target_title)
      ?? getText(target.title)
      ?? getText(payload.title);
    const prompt = getText(payload.prompt)
      ?? getText(payload.description)
      ?? getText(input.prompt)
      ?? '';
    const invocationId = getText(payload.invocation_id ?? payload.id ?? context.eventInput.recordId);
    const requesterNpub = getText(payload.created_by_npub ?? context.eventInput.updaterNpub);
    const channelContext = objectValue(objectValue(input.flightDeckContext).channel);

    if (!taskId) {
      return {
        status: 'failed',
        operation: 'tasks.prepare-task-invocation',
        reason: 'Task invocation did not include a target task id.',
        invocation: { invocationId, prompt, requesterNpub },
      };
    }
    if (!canUseFlightDeckRuntime(context)) {
      return {
        status: 'failed',
        operation: 'tasks.prepare-task-invocation',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
        invocation: { invocationId, prompt, requesterNpub },
        task: { taskId, title: taskTitleHint },
      };
    }

    const pg = getFlightDeckPgPublishContext(context);
    try {
      const [taskResult, commentsResult] = await Promise.all([
        fetchFlightDeckPgTask({
          backendBaseUrl: pg.backendBaseUrl,
          workspaceId: pg.workspaceId,
          taskId,
          appNpub: pg.appNpub,
          botIdentity: pg.botIdentity,
        }),
        fetchFlightDeckPgTaskComments({
          backendBaseUrl: pg.backendBaseUrl,
          workspaceId: pg.workspaceId,
          taskId,
          appNpub: pg.appNpub,
          botIdentity: pg.botIdentity,
          limit: 200,
        }).catch((error) => ({
          comments: [],
          next_cursor: null,
          load_error: error instanceof Error ? error.message : String(error),
        })),
      ]);
      const task = objectValue(taskResult.task);
      const title = getText(task.title) ?? taskTitleHint ?? 'Flight Deck task';
      const description = getText(task.description) ?? '';
      const comments = Array.isArray(commentsResult.comments) ? commentsResult.comments : [];
      const channelId = getText(task.channel_id)
        ?? resolveFlightDeckPgChannelId(context, getText(payload.channel_id));
      const scopeId = getText(task.scope_id ?? context.eventInput.scopeId ?? payload.scope_id);
      const localPath = await writeTaskInvocationSnapshot({
        workdir: getText(objectValue(input.agent).workingDirectory ?? objectValue(input.defaults).workdir),
        invocationId,
        taskId,
        title,
        state: getText(task.state),
        rowVersion: task.row_version ?? task.rowVersion ?? null,
        prompt,
        description,
        comments,
      });
      return {
        status: 'loaded',
        operation: 'tasks.prepare-task-invocation',
        invocation: {
          invocationId,
          prompt,
          requesterNpub,
          sourceSurface: getText(objectValue(payload.metadata).source_surface),
          createdByNpub: getText(payload.created_by_npub),
        },
        workspace: {
          workspaceId: pg.workspaceId,
          workspaceOwnerNpub: getText(objectValue(input.workspace).workspaceOwnerNpub),
          humanWorkspaceOwnerNpub: getText(objectValue(input.workspace).humanWorkspaceOwnerNpub),
          backendBaseUrl: pg.backendBaseUrl,
          appNpub: pg.appNpub,
        },
        location: {
          scopeId,
          channelId,
          channelName: getText(channelContext.name),
          channelContextPrompt: getText(channelContext.contextPrompt),
          hasSpecificChannelContext: channelContext.hasSpecificContext === true,
        },
        task: {
          taskId,
          title,
          mention: mention('task', taskId, title),
          state: getText(task.state),
          priority: getText(task.priority),
          description,
          rowVersion: task.row_version ?? task.rowVersion ?? null,
          localPath,
          comments: comments.slice(0, 50).map((comment) => {
            const item = objectValue(comment);
            return {
              commentId: getText(item.id),
              authorNpub: getText(item.created_by_actor_npub ?? item.sender_npub),
              body: getText(item.body),
              createdAt: getText(item.created_at),
              updatedAt: getText(item.updated_at),
            };
          }),
          commentsLoadError: getText(objectValue(commentsResult).load_error),
        },
        guidance: [
          'This is a Flight Deck Postgres task invocation, not a chat thread.',
          'Use the invocation prompt as the immediate instruction and the target task as the response surface.',
          'If child work is required, launch an existing child pipeline with reporting.mode flightdeck_task and taskId set to this task.',
          'Direct answers, needs-input questions, and status updates should be comments on this task.',
        ],
      };
    } catch (error) {
      return {
        status: 'failed',
        operation: 'tasks.prepare-task-invocation',
        reason: error instanceof Error ? error.message : String(error),
        invocation: { invocationId, prompt, requesterNpub },
        task: {
          taskId,
          title: taskTitleHint,
          mention: mention('task', taskId, taskTitleHint ?? 'Flight Deck task'),
        },
      };
    }
  };
}

export function createDispatchTaskInvocationResponsePublisher(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      return {
        published: false,
        status: 'failed',
        operation: 'tasks.publish-task-invocation-response',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    if (!isFlightDeckPgPublisherContext(context)) {
      return {
        published: false,
        status: 'failed',
        operation: 'tasks.publish-task-invocation-response',
        reason: 'Flight Deck PG context is required.',
      };
    }
    const plan = objectValue(input.plan ?? input.taskInvocationPlan ?? input.workPlan);
    const invocationContext = objectValue(input.invocationContext);
    const task = objectValue(invocationContext.task);
    const invocation = objectValue(invocationContext.invocation);
    const childPipeline = objectValue(input.childPipeline);
    const taskId = getText(plan.taskId ?? task.taskId ?? context.eventInput.bindingId);
    if (!taskId) {
      return {
        published: false,
        status: 'failed',
        operation: 'tasks.publish-task-invocation-response',
        reason: 'Task invocation response publish requires a task id.',
      };
    }
    const action = getText(plan.action) ?? 'direct_response';
    const shouldComment = plan.shouldComment !== false;
    if (!shouldComment) {
      return {
        published: false,
        status: 'skipped',
        operation: 'tasks.publish-task-invocation-response',
        reason: getText(plan.reason) ?? 'Plan requested no task comment.',
        taskId,
      };
    }
    const commentBody = buildTaskInvocationComment({
      action,
      plan,
      childPipeline,
      invocation,
      task,
    });
    try {
      const commentResult = await createFlightDeckPgTaskCommentFromContext(context, taskId, commentBody, {
        autopilot_dispatch: true,
        operation: 'tasks.task-invocation-response',
        invocation_id: getText(invocation.invocationId ?? context.eventInput.recordId),
        task_invocation_action: action,
        child_pipeline_run_id: getText(childPipeline.pipelineRunId),
      });
      return {
        published: true,
        status: 'ok',
        operation: 'tasks.publish-task-invocation-response',
        taskId,
        action,
        commentResult,
        childPipeline,
      };
    } catch (error) {
      return {
        published: false,
        status: 'failed',
        operation: 'tasks.publish-task-invocation-response',
        taskId,
        action,
        reason: error instanceof Error ? error.message : String(error),
        childPipeline,
      };
    }
  };
}

async function findFlightDeckPgDiscussionDocumentByTitle(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  workPlan: Record<string, unknown>,
): Promise<{
  documentId: string | null;
  documentTitle: string | null;
  lookup?: JsonObject;
}> {
  const candidateTitles = extractDiscussionDocumentTitleCandidates(input, workPlan);
  if (candidateTitles.length === 0) {
    return { documentId: null, documentTitle: null };
  }
  const channelId = resolveFlightDeckPgChannelId(context, getText(workPlan.channelId ?? objectValue(workPlan.origin).channelId));
  if (!channelId) {
    return {
      documentId: null,
      documentTitle: null,
      lookup: {
        status: 'skipped',
        reason: 'missing_channel_id',
        candidateTitles,
      },
    };
  }
  try {
    const result = await listFlightDeckPgChannelDocs({
      ...getFlightDeckPgPublishContext(context),
      channelId,
      limit: 100,
    });
    const docs = Array.isArray(result.docs) ? result.docs : [];
    const wanted = candidateTitles.map((title) => normalizeDocumentLookupTitle(title));
    const exact = docs.find((doc) => {
      const title = normalizeDocumentLookupTitle(getText(doc.title));
      return Boolean(title && wanted.includes(title));
    });
    if (exact?.id) {
      return {
        documentId: exact.id,
        documentTitle: getText(exact.title),
        lookup: {
          status: 'matched',
          method: 'channel_doc_title',
          channelId,
          candidateTitles,
          matchedTitle: getText(exact.title),
        },
      };
    }
    return {
      documentId: null,
      documentTitle: null,
      lookup: {
        status: 'not_found',
        method: 'channel_doc_title',
        channelId,
        candidateTitles,
        availableTitles: docs.map((doc) => getText(doc.title)).filter(Boolean).slice(0, 20),
      },
    };
  } catch (error) {
    return {
      documentId: null,
      documentTitle: null,
      lookup: {
        status: 'failed',
        method: 'channel_doc_title',
        channelId,
        candidateTitles,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function createDispatchReviewTaskCompleter(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      return {
        completed: false,
        status: 'failed',
        operation: 'tasks.complete-review-from-chat',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }
    const reviewApproval = objectValue(input.reviewApproval);
    const taskId = getText(reviewApproval.taskId);
    if (!taskId) {
      return {
        completed: false,
        status: 'skipped',
        operation: 'tasks.complete-review-from-chat',
        reason: 'missing_task_id',
      };
    }
    try {
      const updateResult = isFlightDeckPgPublisherContext(context)
        ? await updateFlightDeckPgTaskStateWithLease(context, taskId, 'done')
        : await runYokeJson(context, [
          'tasks',
          'update',
          taskId,
          '--state',
          'done',
          '--json',
        ]);
      const taskTitle = getText(reviewApproval.taskTitle) ?? 'review task';
      const evidence = getText(reviewApproval.evidence);
      const commentBody = [
        `Marked "${taskTitle}" done from chat approval.`,
        evidence ? `Approval text: ${evidence}` : '',
      ].filter(Boolean).join('\n');
      const commentResult = isFlightDeckPgPublisherContext(context)
        ? await createFlightDeckPgTaskCommentFromContext(
          context,
          taskId,
          commentBody,
          {
            autopilot_dispatch: true,
            notification_kind: 'review_approval',
          },
        )
        : await runYokeJson(context, [
          'tasks',
          'comment',
          taskId,
          '--body',
          commentBody,
          '--json',
        ]);
      return {
        completed: true,
        status: 'done',
        operation: 'tasks.complete-review-from-chat',
        taskId,
        taskTitle,
        updateResult,
        commentResult,
      };
    } catch (error) {
      return {
        completed: false,
        status: 'failed',
        operation: 'tasks.complete-review-from-chat',
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

async function hydrateChatThreadWithFallback(
  context: DispatchPipelineFlightDeckPublisherContext,
  channelId: string,
  threadId: string,
): Promise<{
  hydrated: boolean;
  status: 'ok' | 'partial';
  thread: unknown;
  warnings: string[];
  fallbackContext: boolean;
}> {
  if (isFlightDeckPgPublisherContext(context)) {
    const warnings: string[] = [];
    try {
      const pg = getFlightDeckPgPublishContext(context);
      const result = await fetchFlightDeckPgChannelMessages({
        backendBaseUrl: pg.backendBaseUrl,
        workspaceId: pg.workspaceId,
        channelId,
        appNpub: pg.appNpub,
        botIdentity: pg.botIdentity,
        threadId,
        limit: 20,
      });
      return {
        hydrated: true,
        status: 'ok',
        thread: buildFlightDeckPgChatThread(channelId, threadId, result.messages),
        warnings,
        fallbackContext: false,
      };
    } catch (error) {
      warnings.push(`flightdeck pg chat context failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        hydrated: true,
        status: 'partial',
        thread: buildFallbackChatThread(context, channelId, threadId),
        warnings,
        fallbackContext: true,
      };
    }
  }

  const args = [
    'chat',
    'context',
    '--channel',
    channelId,
    '--thread',
    threadId,
    '--limit',
    '20',
    '--format',
    'json',
  ];
  const warnings: string[] = [];

  try {
    return {
      hydrated: true,
      status: 'ok',
      thread: await runYokeJson(context, args),
      warnings,
      fallbackContext: false,
    };
  } catch (error) {
    warnings.push(`initial chat context failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await runYokeJson(context, ['sync', '--json']);
  } catch (error) {
    warnings.push(`sync before chat context retry failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return {
      hydrated: true,
      status: 'ok',
      thread: await runYokeJson(context, args),
      warnings,
      fallbackContext: false,
    };
  } catch (error) {
    warnings.push(`retry chat context failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    hydrated: true,
    status: 'partial',
    thread: buildFallbackChatThread(context, channelId, threadId),
    warnings,
    fallbackContext: true,
  };
}

function buildFlightDeckPgChatThread(
  channelId: string,
  threadId: string,
  messages: FlightDeckPgMessage[],
): JsonObject {
  const recentMessages = messages.map((message) => ({
    message_id: message.id,
    record_id: message.id,
    parent_message_id: null,
    sender_npub: null,
    sender_actor_id: message.created_by_actor_id ?? null,
    actor_id: message.created_by_actor_id ?? null,
    body: message.body ?? '',
    attachments: Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [],
    metadata: message.metadata ?? {},
    scope_id: message.scope_id ?? null,
    channel_id: message.channel_id ?? channelId,
    thread_id: message.thread_id ?? threadId,
    updated_at: message.updated_at ?? message.created_at ?? null,
    created_at: message.created_at ?? null,
    record_state: 'current',
    version: message.row_version ?? null,
  }));
  return {
    channel_id: channelId,
    thread_id: threadId,
    fallback_context: false,
    recent_messages: recentMessages,
    messages: recentMessages,
    thread: {
      message_id: threadId,
      record_id: threadId,
      recent_messages: recentMessages,
      messages: recentMessages,
    },
  };
}

function buildFallbackChatThread(
  context: DispatchPipelineFlightDeckPublisherContext,
  channelId: string,
  threadId: string,
): JsonObject {
  const payload = context.eventInput.payload;
  const messageId = context.eventInput.recordId;
  const parentMessageId = getText(payload.parent_message_id);
  const message = {
    message_id: messageId,
    record_id: messageId,
    parent_message_id: parentMessageId,
    sender_npub: getText(payload.sender_npub),
    body: getText(payload.body) ?? '',
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    updated_at: getText(payload.updated_at),
    record_state: getText(payload.record_state),
    version: typeof payload.version === 'number' ? payload.version : null,
  };
  return {
    channel_id: channelId,
    thread_id: threadId,
    fallback_context: true,
    fallback_reason: 'local chat context was unavailable; using the dispatch record payload',
    recent_messages: [message],
    messages: [message],
    thread: {
      message_id: threadId,
      record_id: threadId,
      recent_messages: [message],
      messages: [message],
    },
  };
}

function detectSelfAuthoredChatDispatch(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  thread: unknown,
): {
  selfAuthored: boolean;
  reason: string | null;
  matchedSelfNpub: string | null;
} {
  const selfNpubs = new Set(
    [
      context.eventInput.subscription.botNpub,
      context.eventInput.subscription.wsKeyNpub,
      context.agent?.botNpub,
      context.botIdentity?.botNpub,
    ].filter((value): value is string => Boolean(value)),
  );
  if (selfNpubs.size === 0) {
    return { selfAuthored: false, reason: null, matchedSelfNpub: null };
  }

  const inputRecord = objectValue(input.record);
  const inputPayload = objectValue(inputRecord.payload ?? context.eventInput.payload);
  const inputChat = objectValue(input.chat);
  const threadMessage = findThreadMessageById(thread, context.eventInput.recordId);
  const threadSender = getText(threadMessage?.sender_npub);
  const senderCandidates = [
    getText(context.eventInput.payload.sender_npub),
    getText(inputPayload.sender_npub),
    getText(inputChat.senderNpub),
    threadSender,
  ];
  const updaterCandidates = [
    context.eventInput.updaterNpub,
    getText(inputRecord.updaterNpub),
    getText(inputPayload.signature_npub),
    getText(inputPayload.owner_npub),
  ];
  const matchedSender = senderCandidates.find((value) => Boolean(value && selfNpubs.has(value))) ?? null;
  if (matchedSender) {
    return {
      selfAuthored: true,
      reason: threadSender === matchedSender ? 'trigger_thread_message_sender_is_self' : 'trigger_sender_is_self',
      matchedSelfNpub: matchedSender,
    };
  }
  const matchedUpdater = updaterCandidates.find((value) => Boolean(value && selfNpubs.has(value))) ?? null;
  if (matchedUpdater) {
    return {
      selfAuthored: true,
      reason: 'trigger_updater_is_self',
      matchedSelfNpub: matchedUpdater,
    };
  }
  return { selfAuthored: false, reason: null, matchedSelfNpub: null };
}

function findThreadMessageById(thread: unknown, messageId: string): Record<string, unknown> | null {
  const root = objectValue(thread);
  const nestedThread = objectValue(root.thread);
  const candidates = [
    root.recent_messages,
    root.messages,
    nestedThread.recent_messages,
    nestedThread.messages,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const message = objectValue(entry);
      const id = getText(message.message_id) ?? getText(message.record_id);
      if (id === messageId) {
        return message;
      }
    }
  }
  return null;
}

export function createDispatchChatTaskCreator(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const decision = objectValue(input.decision ?? input.agentResponse ?? input);
    if (decision.dispatchTask !== true) {
      return {
        created: false,
        status: 'skipped',
        operation: 'tasks.create-from-chat',
        reason: 'Decision does not require task-backed work.',
      };
    }

    const taskDraft = objectValue(decision.taskDraft);
    const workPlan = objectValue(decision.workPlan);
    const title = getText(taskDraft.title) ?? getText(workPlan.taskSummary) ?? 'Chat-requested Wingman task';
    const description = buildChatCreatedTaskDescription(context, decision);
    const scopeId = getText(decision.scopeId ?? workPlan.scopeId);
    const assignedTo = context.eventInput.subscription.botNpub;
    const pipelineLaunches = Array.isArray(decision.pipelineLaunches)
      ? decision.pipelineLaunches.map((item) => objectValue(item))
      : [];
    if (decision.pipelinesRequired === true && pipelineLaunches.length > 0) {
      if (!isFlightDeckPgPublisherContext(context)) {
        return {
          created: false,
          status: 'failed',
          operation: 'tasks.create-from-chat.multi',
          reason: 'Multi-pipeline task creation requires Flight Deck PG runtime.',
          items: [],
        };
      }
      const items: JsonObject[] = [];
      for (let index = 0; index < pipelineLaunches.length; index += 1) {
        const launch = pipelineLaunches[index]!;
        const requirementId = getText(launch.requirementId) ?? `requirement-${index + 1}`;
        const requirementWorkPlan = objectValue(launch.workPlan);
        const requirementTitle = getText(requirementWorkPlan.taskSummary ?? requirementWorkPlan.title)
          ?? `${title} - ${requirementId}`;
        const requirementScopeId = getText(requirementWorkPlan.scopeId ?? decision.scopeId ?? workPlan.scopeId);
        const requirementDecision = {
          ...decision,
          pipelineDefinitionId: getText(launch.pipelineDefinitionId ?? requirementWorkPlan.pipelineDefinitionId),
          workPlan: requirementWorkPlan,
          taskDraft: {
            ...taskDraft,
            title: requirementTitle,
            instructions: getText(requirementWorkPlan.instructions) ?? getText(taskDraft.instructions),
          },
        };
        try {
          const createResult = await createFlightDeckPgTaskFromContext(context, {
            title: requirementTitle,
            description: buildChatCreatedTaskDescription(context, requirementDecision),
            state: 'in_progress',
            metadata: {
              autopilot_dispatch: true,
              source_message_id: context.eventInput.recordId,
              assigned_to_npub: assignedTo,
              scope_id: requirementScopeId,
              requirement_id: requirementId,
              pipeline_definition_id: getText(launch.pipelineDefinitionId ?? requirementWorkPlan.pipelineDefinitionId),
            },
          });
          const taskId = getText(objectValue(createResult.task).id);
          if (!taskId) {
            items.push({
              requirementId,
              created: false,
              status: 'failed',
              reason: 'Task creation succeeded but no created task id was returned.',
              scopeId: requirementScopeId,
              assignedToNpub: assignedTo,
              createResult,
            });
            continue;
          }
          const nextWorkPlan = buildCreatedTaskWorkPlan(requirementWorkPlan, requirementDecision, {
            taskId,
            scopeId: requirementScopeId,
            assignedTo,
          });
          const assignment = await assignFlightDeckPgTaskToNpub(context, taskId, assignedTo);
          items.push({
            requirementId,
            created: true,
            status: assignment.status === 'ok' ? 'ok' : 'partial',
            operation: 'tasks.create-from-chat',
            taskId,
            scopeId: requirementScopeId,
            assignedToNpub: assignedTo,
            assignment,
            pipelineDefinitionId: nextWorkPlan.pipelineDefinitionId,
            workPlan: nextWorkPlan,
            createResult,
          });
        } catch (error) {
          items.push({
            requirementId,
            created: false,
            status: 'failed',
            operation: 'tasks.create-from-chat',
            reason: error instanceof Error ? error.message : String(error),
            scopeId: requirementScopeId,
            assignedToNpub: assignedTo,
            pipelineDefinitionId: getText(launch.pipelineDefinitionId ?? requirementWorkPlan.pipelineDefinitionId),
            workPlan: {
              ...requirementWorkPlan,
              taskId: null,
              scopeId: requirementScopeId,
              assignedToNpub: assignedTo,
            },
          });
        }
      }
      const failed = items.filter((item) => getText(item.status) === 'failed');
      const firstReady = items.find((item) => getText(item.taskId));
      return {
        created: items.some((item) => item.created === true),
        status: failed.length === 0 ? 'ok' : failed.length === items.length ? 'failed' : 'partial',
        operation: 'tasks.create-from-chat.multi',
        taskId: getText(firstReady?.taskId),
        scopeId: getText(firstReady?.scopeId) ?? scopeId,
        assignedToNpub: assignedTo,
        pipelineDefinitionId: getText(firstReady?.pipelineDefinitionId),
        workPlan: objectValue(firstReady?.workPlan),
        items,
      };
    }
    const reusableTaskId = getText(workPlan.taskId ?? decision.taskId) ?? findReusableTaskIdForChatTask(input);
    if (reusableTaskId) {
      let updateResult: unknown = null;
      let updateError: string | null = null;
      try {
        updateResult = isFlightDeckPgPublisherContext(context)
          ? await updateFlightDeckPgTaskStateWithLease(context, reusableTaskId, 'in_progress')
          : await runYokeJson(context, [
            'tasks',
            'update',
            reusableTaskId,
            '--state',
            'in_progress',
            '--assign',
            assignedTo,
            '--json',
          ]);
      } catch (error) {
        updateError = error instanceof Error ? error.message : String(error);
      }
      const assignment = isFlightDeckPgPublisherContext(context)
        ? await assignFlightDeckPgTaskToNpub(context, reusableTaskId, assignedTo)
        : null;
      const nextWorkPlan = buildCreatedTaskWorkPlan(workPlan, decision, {
        taskId: reusableTaskId,
        scopeId,
        assignedTo,
      });
      return {
        created: false,
        reused: true,
        status: updateError || (assignment && assignment.status !== 'ok') ? 'partial' : 'ok',
        operation: 'tasks.reuse-from-chat',
        taskId: reusableTaskId,
        scopeId,
        assignedToNpub: assignedTo,
        assignment,
        updateResult,
        updateError,
        pipelineDefinitionId: nextWorkPlan.pipelineDefinitionId,
        workPlan: nextWorkPlan,
      };
    }
    if (isFlightDeckPgPublisherContext(context)) {
      const createResult = await createFlightDeckPgTaskFromContext(context, {
        title,
        description,
        state: 'in_progress',
        metadata: {
          autopilot_dispatch: true,
          source_message_id: context.eventInput.recordId,
          assigned_to_npub: assignedTo,
          scope_id: scopeId,
        },
      });
      const taskId = getText(objectValue(createResult.task).id);
      if (!taskId) {
        return {
          created: false,
          status: 'failed',
          operation: 'tasks.create-from-chat',
          reason: 'Task creation succeeded but no created task id was returned.',
          scopeId,
          assignedToNpub: assignedTo,
          pipelineDefinitionId: null,
          createResult,
          workPlan: {
            ...workPlan,
            taskId: null,
            scopeId,
            assignedToNpub: assignedTo,
            childPipelineDefinitionId: null,
            pipelineDefinitionId: null,
          },
        };
      }
      const nextWorkPlan = buildCreatedTaskWorkPlan(workPlan, decision, {
        taskId,
        scopeId,
        assignedTo,
      });
      const assignment = await assignFlightDeckPgTaskToNpub(context, taskId, assignedTo);
      return {
        created: true,
        status: assignment.status === 'ok' ? 'ok' : 'partial',
        operation: 'tasks.create-from-chat',
        taskId,
        scopeId,
        assignedToNpub: assignedTo,
        assignment,
        pipelineDefinitionId: nextWorkPlan.pipelineDefinitionId,
        workPlan: nextWorkPlan,
        createResult,
      };
    }

    const previousTaskIds = await listMatchingTaskIds(context, {
      title,
      state: 'in_progress',
      assignedTo,
    });
    const args = [
      'tasks',
      'create',
      '--title',
      title,
      '--description',
      description,
      '--state',
      'in_progress',
      '--assign',
      assignedTo,
    ];
    if (scopeId) {
      args.push('--scope', scopeId);
    }
    args.push('--json');
    let createResult: unknown = null;
    let taskId: string | null = null;
    try {
      createResult = await runYokeJson(context, args);
      taskId = getCreatedRecordId(createResult)
        ?? await findNewlyCreatedTaskId(context, {
          title,
          state: 'in_progress',
          assignedTo,
          previousTaskIds,
        });
    } catch (error) {
      return {
        created: false,
        status: 'failed',
        operation: 'tasks.create-from-chat',
        reason: error instanceof Error ? error.message : String(error),
        scopeId,
        assignedToNpub: assignedTo,
        pipelineDefinitionId: null,
        workPlan: {
          ...workPlan,
          taskId: null,
          scopeId,
          assignedToNpub: assignedTo,
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
        },
      };
    }
    if (!taskId) {
      return {
        created: false,
        status: 'failed',
        operation: 'tasks.create-from-chat',
        reason: 'Task creation succeeded but no created task id was returned.',
        scopeId,
        assignedToNpub: assignedTo,
        pipelineDefinitionId: null,
        createResult,
        workPlan: {
          ...workPlan,
          taskId: null,
          scopeId,
          assignedToNpub: assignedTo,
          childPipelineDefinitionId: null,
          pipelineDefinitionId: null,
        },
      };
    }
    const nextWorkPlan = {
      ...buildCreatedTaskWorkPlan(workPlan, decision, { taskId, scopeId, assignedTo }),
    };
    return {
      created: true,
      status: 'ok',
      operation: 'tasks.create-from-chat',
      taskId,
      scopeId,
      assignedToNpub: assignedTo,
      pipelineDefinitionId: nextWorkPlan.pipelineDefinitionId,
      workPlan: nextWorkPlan,
      createResult,
    };
  };
}

export function createDispatchCreatedTaskBlocker(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const childPipeline = objectValue(input.childPipeline);
    if (childPipeline.started !== false && getText(childPipeline.status) !== 'failed') {
      return {
        updated: false,
        status: 'skipped',
        operation: 'tasks.block-on-pipeline-launch-failure',
      };
    }
    const taskId = resolveTaskId(context, input);
    if (!taskId) {
      return {
        updated: false,
        status: 'skipped',
        operation: 'tasks.block-on-pipeline-launch-failure',
        reason: 'Cannot block task after pipeline launch failure without a task id.',
      };
    }
    const reason = getText(childPipeline.reason) ?? getText(childPipeline.error) ?? 'Selected pipeline failed to start.';
    if (isFlightDeckPgPublisherContext(context)) {
      const updateResult = await updateFlightDeckPgTaskStateWithLease(context, taskId, 'blocked');
      const commentResult = await createFlightDeckPgTaskCommentFromContext(
        context,
        taskId,
        `Pipeline launch failed: ${reason}`,
        {
          autopilot_dispatch: true,
          notification_kind: 'pipeline_launch_failed',
        },
      );
      return {
        updated: true,
        status: 'ok',
        operation: 'tasks.block-on-pipeline-launch-failure',
        taskId,
        updateResult,
        commentResult,
      };
    }
    const updateResult = await runYokeJson(context, [
      'tasks',
      'update',
      taskId,
      '--state',
      'blocked',
      '--json',
    ]);
    const commentResult = await runYokeJson(context, [
      'tasks',
      'comment',
      taskId,
      '--body',
      `Pipeline launch failed: ${reason}`,
      '--json',
    ]);
    return {
      updated: true,
      status: 'ok',
      operation: 'tasks.block-on-pipeline-launch-failure',
      taskId,
      updateResult,
      commentResult,
    };
  };
}

function buildCreatedTaskWorkPlan(
  workPlan: Record<string, unknown>,
  decision: Record<string, unknown>,
  input: {
    taskId: string;
    scopeId: string | null;
    assignedTo: string;
  },
): JsonObject {
  return {
    ...workPlan,
    taskId: input.taskId,
    scopeId: input.scopeId,
    assignedToNpub: input.assignedTo,
    childPipelineDefinitionId: getText(workPlan.childPipelineDefinitionId ?? decision.pipelineDefinitionId),
    pipelineDefinitionId: getText(workPlan.pipelineDefinitionId ?? decision.pipelineDefinitionId),
  };
}

function findReusableTaskIdForChatTask(input: JsonObject): string | null {
  const values = [
    objectValue(input.chatContext).thread,
    objectValue(input.chatContext).referencedRecords,
    objectValue(input.decision).workPlan,
    objectValue(input.agentResponse).workPlan,
  ];
  const orderedMentions: Array<{ type: string; id: string }> = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        orderedMentions.push(...extractMentionRefs(value[index]));
      }
    } else {
      orderedMentions.push(...extractMentionRefs(value));
    }
  }
  const taskMention = orderedMentions.find((ref) => ref.type.toLowerCase() === 'task');
  return taskMention?.id ?? null;
}

export function createDispatchNeedsInputPublisher(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      return {
        published: false,
        status: 'failed',
        operation: 'tasks.needs-input',
        reason: context.runtime.error ?? 'Flight Deck runtime was not prepared.',
      };
    }

    const question = buildNeedsInputQuestion(input);
    const taskId = resolveTaskId(context, input);
    let commentResult: unknown = null;
    let commentError: string | null = null;
    if (taskId) {
      try {
        commentResult = isFlightDeckPgPublisherContext(context)
          ? await createFlightDeckPgTaskCommentFromContext(
            context,
            taskId,
            buildNeedsInputTaskComment(input, question),
            {
              autopilot_dispatch: true,
              notification_kind: 'needs_input',
            },
          )
          : await runYokeJson(context, [
            'tasks',
            'comment',
            taskId,
            '--body',
            buildNeedsInputTaskComment(input, question),
            '--json',
          ]);
      } catch (error) {
        commentError = error instanceof Error ? error.message : String(error);
      }
    }

    const chatNotification = await publishNeedsInputChatNotification(context, input, taskId, question);

    return {
      published: !commentError && (Boolean(commentResult) || chatNotification.notified),
      status: commentError || chatNotification.error ? 'partial' : 'ok',
      operation: 'tasks.needs-input',
      taskId,
      question,
      commentResult,
      commentError,
      chatNotified: chatNotification.notified,
      chatResult: chatNotification.result,
      chatError: chatNotification.error,
      chatSkippedReason: chatNotification.skippedReason,
    };
  };
}

export function createDispatchImplementationReviewTaskEnsurer(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }

    const workPlan = objectValue(input.workPlan ?? objectValue(input.createdTask).workPlan);
    const reporting = objectValue(workPlan.reporting ?? input.reporting ?? input.reportTarget);
    const origin = objectValue(workPlan.origin ?? input.origin);
    const reportingMode = getText(reporting.mode ?? reporting.type);
    const originKind = getText(origin.kind);
    const directChatRun = context.eventInput.triggerKind === 'chat'
      && (reportingMode === 'chat_thread' || originKind === 'chat_thread' || workPlan.createTask === false);
    const existingTaskId = directChatRun ? null : resolveTaskId(context, input);
    const scopeId = getText(input.scopeId ?? workPlan.scopeId);
    const assignedTo = context.eventInput.subscription.botNpub;
    let taskId = existingTaskId;
    let createResult: unknown = null;

    if (!isFlightDeckPgPublisherContext(context)) {
      await syncFlightDeckRuntime(context);
    }

    if (directChatRun) {
      const workdir = resolveImplementationReviewWorkdir(input, workPlan, context);
      const designDocumentReference = resolveImplementationDesignDocumentReference(context, input, workPlan)
        ?? resolveChatThreadImplementationReference(context, input, workPlan);
      const designDocument = await hydrateImplementationDesignDocument(context, designDocumentReference, workdir);
      const nextWorkPlan = {
        ...workPlan,
        taskId: null,
        scopeId,
        taskSummary: getText(workPlan.taskSummary)
          ?? getText(input.taskTitle)
          ?? compactSingleLine(getText(input.implementationPrompt), 140)
          ?? 'Implementation review loop',
        instructions: getText(workPlan.instructions)
          ?? getText(input.implementationPrompt)
          ?? 'Run the implementation review loop.',
        workdir,
        designDocumentUrl: designDocumentReference,
        designDocumentSource: getText(workPlan.designDocumentSource)
          ?? (designDocumentReference?.startsWith('flightdeck-chat-thread://') ? 'chat_thread_context' : undefined),
        designDocumentUnavailableReason: getText(workPlan.designDocumentUnavailableReason)
          ?? getText(input.designDocumentUnavailableReason)
          ?? (designDocument?.status === 'failed' ? getText(designDocument.error) : undefined),
        ...(designDocument ? { designDocument } : {}),
        designDocumentLocalPath: getText(designDocument?.localPath),
        designDocumentAccessInstructions: [
          designDocument?.status === 'loaded'
            ? 'Use workPlan.designDocument.localPath as the design baseline; refresh with flightdeck_doc_get only if current state matters.'
            : 'Use workPlan.originThread and workPlan.designDocumentUrl as the design baseline for this direct chat-origin software run.',
          'Do not run Yoke or sync a Yoke workspace to read Flight Deck PG context.',
        ].join(' '),
        assignedToNpub: assignedTo,
        reviewerNpub: getText(workPlan.reviewerNpub) ?? resolveRequesterNpub(context, input),
        origin: {
          ...origin,
          kind: 'chat_thread',
          triggerKind: getText(origin.triggerKind) ?? 'chat',
          channelId: getText(origin.channelId)
            ?? context.eventInput.channelId
            ?? getText(context.eventInput.payload.channel_id),
          threadId: getText(origin.threadId)
            ?? context.eventInput.threadId
            ?? getText(context.eventInput.payload.thread_id),
          messageId: getText(origin.messageId)
            ?? context.eventInput.recordId,
        },
        reporting: {
          ...reporting,
          mode: 'chat_thread',
        },
      };

      return {
        published: false,
        status: 'ready',
        operation: 'tasks.ensure-implementation-review-loop',
        taskId: null,
        created: false,
        state: null,
        assignedToNpub: assignedTo,
        assignment: null,
        scopeId,
        createResult: null,
        updateResult: null,
        updateError: null,
        commentResult: null,
        commentError: null,
        workPlan: nextWorkPlan,
      };
    }

    if (!taskId) {
      const title = buildImplementationReviewTaskTitle(input, workPlan);
      const description = buildImplementationReviewTaskDescription(context, input, workPlan);
      if (isFlightDeckPgPublisherContext(context)) {
        createResult = await createFlightDeckPgTaskFromContext(context, {
          title,
          description,
          state: 'in_progress',
          metadata: {
            autopilot_dispatch: true,
            source_message_id: context.eventInput.recordId,
            assigned_to_npub: assignedTo,
            scope_id: scopeId,
            task_kind: 'implementation_review',
          },
        });
        taskId = getText(objectValue(createResult).taskId) ?? getText(objectValue(objectValue(createResult).task).id);
      } else {
        const previousTaskIds = await listMatchingTaskIds(context, {
          title,
          state: 'in_progress',
          assignedTo,
        });
        const args = [
          'tasks',
          'create',
          '--title',
          title,
          '--description',
          description,
          '--state',
          'in_progress',
          '--assign',
          assignedTo,
        ];
        if (scopeId) {
          args.push('--scope', scopeId);
        }
        args.push('--json');
        createResult = await runYokeJson(context, args);
        taskId = getCreatedRecordId(createResult)
          ?? await findNewlyCreatedTaskId(context, {
            title,
            state: 'in_progress',
            assignedTo,
            previousTaskIds,
          });
      }
      if (!taskId) {
        throw new Error('Implementation review task creation succeeded but no task id was returned.');
      }
    }

    let updateResult: unknown = null;
    let updateError: string | null = null;
    try {
      updateResult = isFlightDeckPgPublisherContext(context)
        ? await updateFlightDeckPgTaskStateWithLease(context, taskId, 'in_progress')
        : await runYokeJson(context, [
          'tasks',
          'update',
          taskId,
          '--state',
          'in_progress',
          '--assign',
          assignedTo,
          '--json',
        ]);
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    }

    const assignment = isFlightDeckPgPublisherContext(context)
      ? await assignFlightDeckPgTaskToNpub(context, taskId, assignedTo)
      : null;

    let commentResult: unknown = null;
    let commentError: string | null = null;
    try {
      commentResult = isFlightDeckPgPublisherContext(context)
        ? await createFlightDeckPgTaskCommentFromContext(
          context,
          taskId,
          buildImplementationReviewStartedComment(input, taskId),
          {
            autopilot_dispatch: true,
            notification_kind: 'implementation_review_started',
          },
        )
        : await runYokeJson(context, [
          'tasks',
          'comment',
          taskId,
          '--body',
          buildImplementationReviewStartedComment(input, taskId),
          '--json',
        ]);
    } catch (error) {
      commentError = error instanceof Error ? error.message : String(error);
    }

    const designDocumentReference = resolveImplementationDesignDocumentReference(context, input, workPlan);
    const workdir = resolveImplementationReviewWorkdir(input, workPlan, context);
    const designDocument = await hydrateImplementationDesignDocument(context, designDocumentReference, workdir);
    const nextWorkPlan = {
      ...workPlan,
      taskId,
      scopeId,
      taskSummary: getText(workPlan.taskSummary)
        ?? getText(input.taskTitle)
        ?? compactSingleLine(getText(input.implementationPrompt), 140)
        ?? 'Implementation review loop',
      instructions: getText(workPlan.instructions)
        ?? getText(input.implementationPrompt)
        ?? 'Run the implementation review loop.',
      workdir,
      designDocumentUrl: designDocumentReference,
      designDocumentSource: getText(workPlan.designDocumentSource) ?? getText(input.designDocumentSource),
      designDocumentUnavailableReason: getText(workPlan.designDocumentUnavailableReason)
        ?? getText(input.designDocumentUnavailableReason)
        ?? (designDocument?.status === 'failed' ? getText(designDocument.error) : undefined),
      ...(designDocument ? { designDocument } : {}),
      designDocumentLocalPath: getText(designDocument?.localPath),
      designDocumentAccessInstructions: [
        designDocument?.status === 'loaded'
          ? 'Use workPlan.designDocument.localPath as the design baseline; refresh with flightdeck_doc_get only if current state matters. If workPlan.designDocument.unresolvedStorageReferences is non-empty, download those assets with the current Flight Deck/storage helper or mark visual verification incomplete.'
          : 'If the design reference is a Flight Deck document, read it with the flightdeck_doc_get helper.',
        'Do not run Yoke or sync a Yoke workspace to read Flight Deck PG documents.',
      ].join(' '),
      assignedToNpub: assignedTo,
      reviewerNpub: getText(workPlan.reviewerNpub) ?? resolveRequesterNpub(context, input),
      origin: {
        ...objectValue(workPlan.origin),
        channelId: getText(objectValue(workPlan.origin).channelId)
          ?? context.eventInput.channelId
          ?? getText(context.eventInput.payload.channel_id),
        threadId: getText(objectValue(workPlan.origin).threadId)
          ?? context.eventInput.threadId
          ?? getText(context.eventInput.payload.thread_id),
        messageId: getText(objectValue(workPlan.origin).messageId)
          ?? context.eventInput.recordId,
      },
      reporting: {
        ...reporting,
        mode: reportingMode ?? 'flightdeck_task',
      },
    };

    return {
      published: true,
      status: updateError || commentError || (assignment && assignment.status !== 'ok') ? 'partial' : 'ok',
      operation: 'tasks.ensure-implementation-review-loop',
      taskId,
      created: !existingTaskId,
      state: 'in_progress',
      assignedToNpub: assignedTo,
      assignment,
      scopeId,
      createResult,
      updateResult,
      updateError,
      commentResult,
      commentError,
      workPlan: nextWorkPlan,
    };
  };
}

export function createDispatchImplementationReviewProgressCommenter(
  context: DispatchPipelineFlightDeckPublisherContext,
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const taskId = resolveTaskId(context, input);
    if (!taskId) {
      throw new Error('Implementation review progress comment requires a task id.');
    }
    const body = buildImplementationReviewProgressComment(input);
    const commentResult = isFlightDeckPgPublisherContext(context)
      ? await createFlightDeckPgTaskCommentFromContext(
        context,
        taskId,
        body,
        {
          autopilot_dispatch: true,
          notification_kind: 'implementation_review_progress',
        },
      )
      : await runYokeJson(context, [
        'tasks',
        'comment',
        taskId,
        '--body',
        body,
        '--json',
      ]);
    return {
      published: true,
      status: 'ok',
      operation: 'tasks.comment-implementation-review-progress',
      taskId,
      commentResult,
    };
  };
}

async function hydrateImplementationDesignDocument(
  context: DispatchPipelineFlightDeckPublisherContext,
  reference: string | null,
  workdir: string | null,
): Promise<Record<string, unknown> | null> {
  if (!reference || !isFlightDeckPgPublisherContext(context) || !context.botIdentity) {
    return null;
  }
  const documentId = extractFlightDeckDocumentId(reference);
  if (!documentId) {
    return {
      status: 'not_applicable',
      reference,
      note: 'Reference is not a Flight Deck document id or mention.',
    };
  }
  try {
    const result = await fetchFlightDeckPgDocument({
      backendBaseUrl: context.eventInput.subscription.backendBaseUrl,
      workspaceId: context.eventInput.subscription.workspaceId!,
      documentId,
      appNpub: context.eventInput.subscription.sourceAppNpub,
      botIdentity: context.botIdentity,
      includeBody: true,
    });
    const document = objectValue(result.doc);
    const body = decodeFlightDeckPgDocumentBody(result);
    const localPath = body
      ? await writeImplementationDesignDocumentSnapshot({
        workdir,
        documentId,
        title: getText(document.title),
        rowVersion: document.row_version ?? document.rowVersion ?? null,
        reference,
        body,
      })
      : null;
    return {
      status: 'loaded',
      id: documentId,
      title: getText(document.title),
      rowVersion: document.row_version ?? document.rowVersion ?? null,
      reference,
      localPath,
      unresolvedStorageReferences: body ? extractStorageReferences(body) : [],
      bodyExcerpt: body ? truncateBlock(body, 4000) : '',
      bodyTruncated: Boolean(body && body.length > 30000),
    };
  } catch (error) {
    return {
      status: 'failed',
      id: documentId,
      reference,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractFlightDeckDocumentId(reference: string): string | null {
  const mention = reference.match(/mention:(?:document|doc):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (mention?.[1]) return mention[1];
  const scheme = reference.match(/flightdeck-(?:document|doc):\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (scheme?.[1]) return scheme[1];
  const docPath = reference.match(/\/docs?\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\b|[/?#])/i);
  if (docPath?.[1]) return docPath[1];
  const bare = reference.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return bare?.[0] ?? null;
}

function resolveImplementationDesignDocumentReference(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  workPlan: Record<string, unknown>,
): string | null {
  const explicit = getText(workPlan.designDocumentUrl)
    ?? getText(input.designDocumentUrl)
    ?? getText(workPlan.documentUrl)
    ?? getText(input.documentUrl);
  if (explicit) return explicit;
  const referencedDocument = [
    getText(workPlan.instructions),
    getText(workPlan.taskSummary),
    getText(workPlan.originalPrompt),
    getText(input.implementationPrompt),
    getText(input.taskTitle),
  ].map((candidate) => candidate ? extractFlightDeckDocumentReference(candidate) : null).find(Boolean) ?? null;
  if (referencedDocument) return referencedDocument;
  const taskId = getText(workPlan.taskId ?? input.taskId);
  if (taskId) return `flightdeck-task://${taskId}`;
  return resolveChatThreadImplementationReference(context, input, workPlan);
}

function resolveChatThreadImplementationReference(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  workPlan: Record<string, unknown>,
): string | null {
  const origin = objectValue(workPlan.origin ?? input.origin);
  const chat = objectValue(input.chat);
  const routing = objectValue(input.routing);
  const record = objectValue(input.record);
  const payload = objectValue(record.payload ?? context.eventInput.payload);
  const threadId = getText(origin.threadId)
    ?? context.eventInput.threadId
    ?? getText(chat.threadId)
    ?? getText(routing.threadId)
    ?? getText(payload.thread_id);
  const messageId = getText(origin.messageId)
    ?? context.eventInput.recordId
    ?? getText(record.recordId ?? record.record_id ?? payload.record_id);
  if (!threadId) return null;
  return `flightdeck-chat-thread://${threadId}${messageId ? `#${messageId}` : ''}`;
}

function extractFlightDeckDocumentReference(text: string): string | null {
  const mention = text.match(/@?\[[^\]\n]*\]\(mention:(?:document|doc):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)/i);
  if (mention?.[0] && mention[1]) return mention[0].startsWith('@') ? mention[0] : `@${mention[0]}`;
  const url = text.match(/https?:\/\/\S*\/docs?\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:[/?#]\S*)?/i);
  if (url?.[0]) return url[0];
  const scheme = text.match(/flightdeck-(?:document|doc):\/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  if (scheme?.[0]) return scheme[0];
  return null;
}

async function writeImplementationDesignDocumentSnapshot(input: {
  workdir: string | null;
  documentId: string;
  title: string | null;
  rowVersion: unknown;
  reference: string;
  body: string;
}): Promise<string> {
  const snapshotDir = input.workdir
    ? join(input.workdir, 'tmp', 'flightdeck-docs')
    : IMPLEMENTATION_REVIEW_DOC_SNAPSHOT_FALLBACK_DIR;
  await mkdir(snapshotDir, { recursive: true });
  const safeTitle = (input.title ?? 'design-document')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    || 'design-document';
  const filePath = join(
    snapshotDir,
    `${input.documentId}.${safeTitle}.md`,
  );
  const unresolvedStorageReferences = extractStorageReferences(input.body);
  const metadata = [
    '<!--',
    'Local snapshot of Flight Deck design document for software-implementation-review-loop.',
    `Document ID: ${input.documentId}`,
    input.title ? `Title: ${input.title}` : null,
    input.rowVersion !== null && input.rowVersion !== undefined ? `Row version: ${String(input.rowVersion)}` : null,
    `Source: ${input.reference}`,
    unresolvedStorageReferences.length > 0
      ? `Unresolved storage assets: ${unresolvedStorageReferences.join(', ')}`
      : null,
    `Snapshot created: ${new Date().toISOString()}`,
    '-->',
    '',
  ].filter((line): line is string => line !== null);
  await writeFile(filePath, `${metadata.join('\n')}${input.body.trim()}\n`, 'utf8');
  return filePath;
}

function extractStorageReferences(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(/storage:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi))
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value)))];
}

async function writeDocumentInvocationSnapshot(input: {
  workdir: string | null;
  invocationId: string | null;
  documentId: string;
  title: string;
  rowVersion: unknown;
  prompt: string;
  body: string;
  comments: unknown[];
  storageReferences: string[];
}): Promise<string | null> {
  if (!input.workdir) return null;
  const snapshotDir = join(input.workdir, 'tmp', 'flightdeck-doc-invocations');
  await mkdir(snapshotDir, { recursive: true });
  const safeTitle = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    || 'document';
  const safeInvocation = (input.invocationId ?? 'invocation')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .slice(0, 60)
    || 'invocation';
  const filePath = join(snapshotDir, `${safeInvocation}.${input.documentId}.${safeTitle}.md`);
  const commentBlocks = input.comments.map((comment, index) => {
    const item = objectValue(comment);
    const id = getText(item.id) ?? `comment-${index + 1}`;
    const author = getText(item.created_by_actor_npub ?? item.sender_npub) ?? 'unknown';
    const created = getText(item.created_at) ?? 'unknown time';
    const body = getText(item.body) ?? '';
    return [
      `### ${id}`,
      `Author: ${author}`,
      `Created: ${created}`,
      '',
      body.trim() || '(empty comment)',
    ].join('\n');
  });
  const metadata = [
    '<!--',
    'Local snapshot for Flight Deck document invocation.',
    `Invocation ID: ${input.invocationId ?? 'unknown'}`,
    `Document ID: ${input.documentId}`,
    `Title: ${input.title}`,
    input.rowVersion !== null && input.rowVersion !== undefined ? `Row version: ${String(input.rowVersion)}` : null,
    input.storageReferences.length > 0
      ? `Storage references: ${input.storageReferences.join(', ')}`
      : 'Storage references: none',
    `Snapshot created: ${new Date().toISOString()}`,
    '-->',
    '',
    '# Invocation Prompt',
    '',
    input.prompt.trim() || '(empty prompt)',
    '',
    '# Document Body',
    '',
    input.body.trim() || '(empty document)',
    '',
    '# Document Comments',
    '',
    commentBlocks.length > 0 ? commentBlocks.join('\n\n') : '(no comments)',
    '',
  ].filter((line): line is string => line !== null);
  await writeFile(filePath, `${metadata.join('\n')}\n`, 'utf8');
  return filePath;
}

async function writeTaskInvocationSnapshot(input: {
  workdir: string | null;
  invocationId: string | null;
  taskId: string;
  title: string;
  state: string | null;
  rowVersion: unknown;
  prompt: string;
  description: string;
  comments: unknown[];
}): Promise<string | null> {
  if (!input.workdir) return null;
  const snapshotDir = join(input.workdir, 'tmp', 'flightdeck-task-invocations');
  await mkdir(snapshotDir, { recursive: true });
  const safeTitle = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    || 'task';
  const safeInvocation = (input.invocationId ?? 'invocation')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .slice(0, 60)
    || 'invocation';
  const filePath = join(snapshotDir, `${safeInvocation}.${input.taskId}.${safeTitle}.md`);
  const commentBlocks = input.comments.map((comment, index) => {
    const item = objectValue(comment);
    const id = getText(item.id) ?? `comment-${index + 1}`;
    const author = getText(item.created_by_actor_npub ?? item.sender_npub) ?? 'unknown';
    const created = getText(item.created_at) ?? 'unknown time';
    const body = getText(item.body) ?? '';
    return [
      `### ${id}`,
      `Author: ${author}`,
      `Created: ${created}`,
      '',
      body.trim() || '(empty comment)',
    ].join('\n');
  });
  const metadata = [
    '<!--',
    'Local snapshot for Flight Deck task invocation.',
    `Invocation ID: ${input.invocationId ?? 'unknown'}`,
    `Task ID: ${input.taskId}`,
    `Title: ${input.title}`,
    input.state ? `State: ${input.state}` : null,
    input.rowVersion !== null && input.rowVersion !== undefined ? `Row version: ${String(input.rowVersion)}` : null,
    `Snapshot created: ${new Date().toISOString()}`,
    '-->',
    '',
    '# Invocation Prompt',
    '',
    input.prompt.trim() || '(empty prompt)',
    '',
    '# Task Description',
    '',
    input.description.trim() || '(empty task description)',
    '',
    '# Task Comments',
    '',
    commentBlocks.length > 0 ? commentBlocks.join('\n\n') : '(no comments)',
    '',
  ].filter((line): line is string => line !== null);
  await writeFile(filePath, `${metadata.join('\n')}\n`, 'utf8');
  return filePath;
}

function buildTaskInvocationComment(input: {
  action: string;
  plan: Record<string, unknown>;
  childPipeline: Record<string, unknown>;
  invocation: Record<string, unknown>;
  task: Record<string, unknown>;
}): string {
  const childStarted = input.childPipeline.started === true;
  const childRunId = getText(input.childPipeline.pipelineRunId);
  const childName = getText(input.childPipeline.pipelineName ?? input.childPipeline.pipelineDefinitionId);
  const summary = getText(input.plan.taskComment)
    ?? getText(input.plan.responseDraft)
    ?? getText(input.plan.summary)
    ?? getText(input.plan.taskSummary)
    ?? (childStarted ? 'Started follow-up pipeline work for this invocation.' : 'Handled this task invocation.');
  const lines = [
    input.action === 'start_pipeline'
      ? 'Task invocation: started follow-up work.'
      : input.action === 'needs_input'
        ? 'Task invocation: needs input.'
        : 'Task invocation response.',
    `Summary: ${summary}`,
  ];
  const prompt = getText(input.invocation.prompt);
  if (prompt) {
    lines.push(`Invocation prompt: ${compactSingleLine(prompt, 500)}`);
  }
  if (childStarted) {
    lines.push(`Child pipeline: ${childName ?? 'pipeline'}${childRunId ? ` (${childRunId})` : ''}.`);
  } else if (input.action === 'start_pipeline') {
    const reason = getText(input.childPipeline.reason) ?? getText(input.plan.reason) ?? 'No child pipeline run was started.';
    lines.push(`Child pipeline not started: ${reason}`);
  }
  const changed = getStringArray(input.plan.changedSections ?? input.plan.evidence);
  if (changed.length > 0) {
    lines.push('Evidence:');
    for (const item of changed.slice(0, 8)) {
      lines.push(`- ${compactSingleLine(item, 300)}`);
    }
  }
  const blockers = getStringArray(input.plan.blockers ?? input.plan.openQuestions);
  if (blockers.length > 0) {
    lines.push('Blockers/questions:');
    for (const item of blockers.slice(0, 8)) {
      lines.push(`- ${compactSingleLine(item, 300)}`);
    }
  }
  return lines.join('\n');
}

export function createDispatchTaskStateUpdater(
  context: DispatchPipelineFlightDeckPublisherContext,
  targetState: 'in_progress' | 'review',
): DeclarativeFunction {
  return async (input) => {
    if (!canUseFlightDeckRuntime(context)) {
      throw new Error(context.runtime.error ?? 'Flight Deck runtime was not prepared.');
    }
    const taskId = resolveTaskId(context, input);
    if (!taskId) {
      throw new Error('Task update requires a task record id.');
    }
    const incompleteImplementationReview = targetState === 'review'
      ? getIncompleteImplementationReviewCloseout(input)
      : null;
    if (incompleteImplementationReview) {
      const commentBody = buildImplementationReviewIncompleteComment(input, incompleteImplementationReview);
      const commentResult = isFlightDeckPgPublisherContext(context)
        ? await createFlightDeckPgTaskCommentFromContext(
          context,
          taskId,
          commentBody,
          {
            autopilot_dispatch: true,
            notification_kind: 'implementation_review_incomplete',
          },
        )
        : await runYokeJson(context, [
          'tasks',
          'comment',
          taskId,
          '--body',
          commentBody,
          '--json',
        ]);
      const chatNotification = await publishImplementationReviewIncompleteChatNotification(
        context,
        input,
        taskId,
        incompleteImplementationReview,
      );
      return {
        published: true,
        status: chatNotification.error ? 'partial' : 'ok',
        operation: 'tasks.implementation-review-incomplete',
        taskId,
        state: 'in_progress',
        updateSkipped: true,
        skippedReviewReason: incompleteImplementationReview.reason,
        commentResult,
        chatNotified: chatNotification.notified,
        chatResult: chatNotification.result,
        chatError: chatNotification.error,
        chatSkippedReason: chatNotification.skippedReason,
      };
    }
    const reviewerNpub = targetState === 'review' ? resolveRequesterNpub(context, input) : null;
    const updateArgs = ['tasks', 'update', taskId, '--state', targetState];
    if (reviewerNpub) {
      updateArgs.push('--assign', reviewerNpub);
    }
    updateArgs.push('--json');

    if (!isFlightDeckPgPublisherContext(context)) {
      await syncFlightDeckRuntime(context);
    }
    let updateResult = isFlightDeckPgPublisherContext(context)
      ? await updateFlightDeckPgTaskStateWithLease(context, taskId, targetState)
      : await runYokeJson(context, updateArgs);
    let updateFallback: unknown = null;
    let updateStatus: 'ok' | 'fallback' | 'idempotent' = 'ok';
    if (!isFlightDeckPgPublisherContext(context) && syncResultRejected(updateResult)) {
      const currentTask = await loadFlightDeckTask(context, taskId);
      const currentState = getText(currentTask.state)?.toLowerCase() ?? null;
      if (currentState === targetState) {
        updateStatus = 'idempotent';
      } else if (targetState === 'review' && reviewerNpub) {
        updateFallback = await runYokeJson(context, ['tasks', 'update', taskId, '--state', targetState, '--json']);
        if (syncResultRejected(updateFallback)) {
          const fallbackTask = await loadFlightDeckTask(context, taskId);
          if ((getText(fallbackTask.state)?.toLowerCase() ?? null) !== targetState) {
            throw new Error(`Task ${taskId} update to ${targetState} was rejected: ${summariseSyncRejection(updateFallback)}`);
          }
          updateStatus = 'idempotent';
        } else {
          updateResult = updateFallback;
          updateStatus = 'fallback';
        }
      } else {
        throw new Error(`Task ${taskId} update to ${targetState} was rejected: ${summariseSyncRejection(updateResult)}`);
      }
    }

    const assignment = isFlightDeckPgPublisherContext(context) && targetState === 'review'
      ? await assignFlightDeckPgTaskToNpub(context, taskId, reviewerNpub)
      : null;

    const commentBody = targetState === 'review'
      ? buildReadyForReviewComment(input, reviewerNpub)
      : buildInProgressComment(input);
    let commentResult: unknown = null;
    let commentError: string | null = null;
    try {
      commentResult = isFlightDeckPgPublisherContext(context)
        ? await createFlightDeckPgTaskCommentFromContext(
          context,
          taskId,
          commentBody,
          {
            autopilot_dispatch: true,
            notification_kind: targetState === 'review' ? 'ready_for_review' : 'in_progress',
          },
        )
        : await runYokeJson(context, [
          'tasks',
          'comment',
          taskId,
          '--body',
          commentBody,
          '--json',
        ]);
    } catch (error) {
      commentError = error instanceof Error ? error.message : String(error);
    }
    const chatNotification = targetState === 'review'
      ? await publishReadyForReviewChatNotification(context, input, taskId, reviewerNpub)
      : { notified: false, result: null, error: null, skippedReason: 'not_review_handoff' };

    return {
      published: true,
      status: commentError || chatNotification.error || (assignment && assignment.status !== 'ok') ? 'partial' : 'ok',
      operation: targetState === 'review' ? 'tasks.move-to-review' : 'tasks.move-to-in-progress',
      taskId,
      state: targetState,
      assignedToNpub: reviewerNpub,
      assignment,
      updateStatus,
      updateResult,
      updateFallback,
      commentResult,
      commentError,
      chatNotified: chatNotification.notified,
      chatResult: chatNotification.result,
      chatError: chatNotification.error,
      chatSkippedReason: chatNotification.skippedReason,
    };
  };
}

async function publishReadyForReviewChatNotification(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  taskId: string,
  reviewerNpub: string | null,
): Promise<{
  notified: boolean;
  result: unknown;
  error: string | null;
  skippedReason: string | null;
}> {
  const workPlan = objectValue(input.workPlan);
  const origin = objectValue(workPlan.origin);
  const reportTarget = objectValue(input.reportTarget);
  const channelId = context.eventInput.channelId
    ?? getText(origin.channelId)
    ?? getText(reportTarget.flightDeckChannelId)
    ?? getText(reportTarget.channelId);
  const existingThreadId = context.eventInput.threadId
    ?? getText(origin.threadId)
    ?? getText(reportTarget.threadId);
  if (!channelId) {
    return {
      notified: false,
      result: null,
      error: null,
      skippedReason: 'missing_origin_chat_channel',
    };
  }
  const threadId = existingThreadId ?? randomUUID();

  try {
    if (isFlightDeckPgPublisherContext(context)) {
      const replyBody = buildReadyForReviewChatReply(input, taskId, reviewerNpub);
      const result = await createFlightDeckPgChannelMessageFromContext(context, {
        channelId,
        body: replyBody,
        threadId,
        metadata: {
          autopilot_dispatch: true,
          source_message_id: context.eventInput.recordId,
          subscription_id: context.eventInput.subscription.subscriptionId,
          notification_kind: 'ready_for_review',
        },
        speechTitle: 'Spoken review notification summary',
        speechFilePrefix: 'flightdeck-ready-review-tts',
        userPrompt: getText(objectValue(context.eventInput.payload)?.body),
      });
      return {
        notified: true,
        result: {
          ...objectValue(result),
          createdNewThread: !existingThreadId,
        },
        error: null,
        skippedReason: null,
      };
    }
    const result = await runYokeJson(context, [
      'chat',
      'reply-current',
      '--body',
      buildReadyForReviewChatReply(input, taskId, reviewerNpub),
      '--skip-refresh',
      '--channel',
      channelId,
      '--thread',
      threadId,
      '--format',
      'json',
    ]);
    return {
      notified: true,
      result: {
        ...(objectValue(result)),
        createdNewThread: !existingThreadId,
      },
      error: null,
      skippedReason: null,
    };
  } catch (error) {
    return {
      notified: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      skippedReason: null,
    };
  }
}

async function publishImplementationReviewIncompleteChatNotification(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  taskId: string,
  closeout: { reason: string; remainingPickups: string[] },
): Promise<{
  notified: boolean;
  result: unknown;
  error: string | null;
  skippedReason: string | null;
}> {
  const workPlan = objectValue(input.workPlan);
  const origin = objectValue(workPlan.origin);
  const reportTarget = objectValue(input.reportTarget);
  const channelId = context.eventInput.channelId
    ?? getText(origin.channelId)
    ?? getText(reportTarget.flightDeckChannelId)
    ?? getText(reportTarget.channelId);
  const existingThreadId = context.eventInput.threadId
    ?? getText(origin.threadId)
    ?? getText(reportTarget.threadId);
  if (!channelId) {
    return {
      notified: false,
      result: null,
      error: null,
      skippedReason: 'missing_origin_chat_channel',
    };
  }
  const threadId = existingThreadId ?? randomUUID();
  const body = buildImplementationReviewIncompleteChatReply(input, taskId, closeout);
  try {
    if (isFlightDeckPgPublisherContext(context)) {
      const result = await createFlightDeckPgChannelMessageFromContext(context, {
        channelId,
        body,
        threadId,
        metadata: {
          autopilot_dispatch: true,
          source_message_id: context.eventInput.recordId,
          subscription_id: context.eventInput.subscription.subscriptionId,
          notification_kind: 'implementation_review_incomplete',
        },
        speechTitle: 'Spoken implementation review update',
        speechFilePrefix: 'flightdeck-implementation-review-incomplete-tts',
        userPrompt: getText(objectValue(context.eventInput.payload)?.body),
      });
      return {
        notified: true,
        result: {
          ...objectValue(result),
          createdNewThread: !existingThreadId,
        },
        error: null,
        skippedReason: null,
      };
    }
    const result = await runYokeJson(context, [
      'chat',
      'reply-current',
      '--body',
      body,
      '--skip-refresh',
      '--channel',
      channelId,
      '--thread',
      threadId,
      '--format',
      'json',
    ]);
    return {
      notified: true,
      result: {
        ...(objectValue(result)),
        createdNewThread: !existingThreadId,
      },
      error: null,
      skippedReason: null,
    };
  } catch (error) {
    return {
      notified: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      skippedReason: null,
    };
  }
}

async function publishChatReply(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): Promise<JsonObject> {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  if (response.shouldRespond === false) {
    await setFlightDeckPgThreadResponseActivity(context, {
      status: 'cleared',
      label: 'Response skipped',
      expiresInSeconds: 5,
    }).catch((error) => {
      console.warn('[dispatch-publisher] failed to clear skipped response activity', error);
    });
    return {
      published: false,
      status: 'skipped',
      operation: 'chat.reply-current',
      reason: getText(response.reasoningSummary) ?? 'Agent decided not to respond.',
      agentResponse: response,
    };
  }
  const body = getText(response.responseDraft)
    ?? getText(response.replyDraft)
    ?? getText(response.body);
  const normalizedBody = body ? normalisePublishedMarkdownBody(body) : null;
  const channelId = context.eventInput.channelId ?? null;
  const threadId = context.eventInput.threadId ?? null;
  if (!normalizedBody || !channelId || !threadId) {
    throw new Error('Chat publish requires responseDraft, channelId, and threadId.');
  }

  if (isFlightDeckPgPublisherContext(context)) {
    try {
      const publicationIdentity = dispatchChatPublicationIdentity(context, channelId, threadId);
      const candidateAt = getText(response.createdAt ?? response.created_at ?? response.completedAt)
        ?? new Date().toISOString();
      const duplicateEvaluation = publicationIdentity
        ? context.publicationFilter?.evaluate({ ...publicationIdentity, body: normalizedBody, candidateAt })
        : null;
      if (duplicateEvaluation?.suppress) {
        await setFlightDeckPgThreadResponseActivity(context, {
          status: 'cleared',
          label: 'Duplicate response suppressed',
          expiresInSeconds: 5,
        }).catch((error) => {
          console.warn('[dispatch-publisher] failed to clear suppressed response activity', error);
        });
        return {
          published: false,
          status: 'skipped',
          operation: 'chat.reply-current',
          reason: 'duplicate_callback_within_window',
          channelId,
          threadId,
          agentResponse: response,
        };
      }
      await setFlightDeckPgThreadResponseActivity(context, {
        status: 'publishing',
        label: 'Publishing',
        expiresInSeconds: 60,
      });
      const result = await createFlightDeckPgChannelMessageFromContext(context, {
        channelId,
        body: normalizedBody,
        threadId,
        metadata: {
          autopilot_dispatch: true,
          source_message_id: context.eventInput.recordId,
          subscription_id: context.eventInput.subscription.subscriptionId,
        },
        speechMode: 'background',
        speechTitle: 'TTS reply summary',
        speechFilePrefix: 'chat-reply-tts',
        userPrompt: getText(objectValue(context.eventInput.payload)?.body),
      });
      const publishedMessageId = getPublishedPgMessageId(result);
      if (publicationIdentity && publishedMessageId) {
        context.publicationFilter?.recordPublished({ ...publicationIdentity, candidateAt,
          publishedAt: new Date().toISOString(), publishedMessageId });
      }
      const childPipeline = objectValue(response.childPipeline);
      const childPipelineStarted = childPipeline.started !== false
        && Boolean(getText(childPipeline.pipelineRunId))
        && !new Set(['failed', 'error', 'needs_input']).has(getText(childPipeline.status) ?? '');
      await setFlightDeckPgThreadResponseActivity(context, childPipelineStarted
        ? {
            status: 'thinking',
            label: 'Started software work',
            expiresInSeconds: 900,
            pipelineRunId: getText(childPipeline.pipelineRunId),
            metadata: {
              pipeline_definition_id: getText(childPipeline.pipelineDefinitionId ?? childPipeline.pipelineName),
              step: 'child-pipeline-started',
            },
          }
        : {
            status: 'cleared',
            label: 'Response published',
            expiresInSeconds: 5,
          }).catch((error) => {
        console.warn('[dispatch-publisher] failed to update published response activity', error);
      });
      return {
        published: true,
        status: 'ok',
        operation: 'chat.reply-current',
        channelId,
        threadId,
        result,
        speech: objectValue(result).speech,
        agentResponse: {
          ...response,
          responseDraft: normalizedBody,
        },
      };
    } catch (error) {
      await setFlightDeckPgThreadResponseActivity(context, {
        status: 'failed',
        label: 'Response failed',
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
        expiresInSeconds: 300,
      }).catch((activityError) => {
        console.warn('[dispatch-publisher] failed to publish response failure activity', activityError);
      });
      throw error;
    }
  }

  const result = await runYokeJson(context, [
    'chat',
    'reply-current',
    '--body',
    normalizedBody,
    '--skip-refresh',
    '--channel',
    channelId,
    '--thread',
    threadId,
    '--format',
    'json',
  ]);
  return {
    published: true,
    status: 'ok',
    operation: 'chat.reply-current',
    channelId,
    threadId,
    result,
    agentResponse: {
      ...response,
      responseDraft: normalizedBody,
    },
  };
}

async function publishTaskUpdate(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  mode: 'task_dispatch' | 'task_review',
): Promise<JsonObject> {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const taskId = getRecordId(context.eventInput);
  if (!taskId) {
    throw new Error('Task publish requires a task record id.');
  }
  const state = mode === 'task_review'
    ? normaliseReviewState(response)
    : normaliseTaskState(response);
  if (isFlightDeckPgPublisherContext(context)) {
    let updateResult: unknown = null;
    let updateError: string | null = null;
    try {
      updateResult = await updateFlightDeckPgTaskStateWithLease(context, taskId, state);
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    }
    const publishSummary = {
      ...response,
      childPipeline: objectValue(input.childPipeline ?? input.launchResult ?? response.childPipeline),
      updateError,
    };
    const commentBody = buildTaskCommentBody(mode, state, publishSummary);
    let commentResult: unknown = null;
    let commentError: string | null = null;
    try {
      commentResult = await createFlightDeckPgTaskCommentFromContext(context, taskId, commentBody, {
        autopilot_dispatch: true,
        operation: mode === 'task_review' ? 'tasks.update-review' : 'tasks.update',
        task_state: state,
      });
    } catch (error) {
      commentError = error instanceof Error ? error.message : String(error);
    }
    return {
      published: commentError === null,
      status: commentError !== null ? 'failed' : updateError !== null ? 'partial' : 'ok',
      operation: mode === 'task_review' ? 'tasks.update-review' : 'tasks.update',
      taskId,
      state,
      updateResult,
      updateError,
      commentResult,
      commentError,
      agentResponse: publishSummary,
    };
  }
  let updateResult: unknown = null;
  let updateError: string | null = null;
  try {
    updateResult = await runYokeJson(context, [
      'tasks',
      'update',
      taskId,
      '--state',
      state,
      '--json',
    ]);
  } catch (error) {
    updateError = error instanceof Error ? error.message : String(error);
  }
  const publishSummary = {
    ...response,
    childPipeline: objectValue(input.childPipeline ?? input.launchResult ?? response.childPipeline),
    updateError,
  };
  const commentBody = buildTaskCommentBody(mode, state, publishSummary);
  let commentResult: unknown = null;
  let commentError: string | null = null;
  try {
    commentResult = await runYokeJson(context, [
      'tasks',
      'comment',
      taskId,
      '--body',
      commentBody,
      '--json',
    ]);
  } catch (error) {
    commentError = error instanceof Error ? error.message : String(error);
  }
  const updateRejected = updateError !== null || syncResultRejected(updateResult);
  const commentRejected = commentError !== null || syncResultRejected(commentResult);

  return {
    published: !commentRejected,
    status: commentRejected ? 'failed' : updateRejected ? 'partial' : 'ok',
    operation: mode === 'task_review' ? 'tasks.update-review' : 'tasks.update',
    taskId,
    state,
    updateResult,
    updateError,
    commentResult,
    commentError,
    agentResponse: publishSummary,
  };
}

async function publishCommentReply(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): Promise<JsonObject> {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const body = getText(response.replyDraft)
    ?? getText(response.responseDraft)
    ?? getText(response.body)
    ?? getText(response.nextAction);
  const commentId = getText(context.eventInput.payload.commentId)
    ?? getText(context.eventInput.payload.comment_id)
    ?? context.eventInput.recordId;
  if (!body || !commentId) {
    throw new Error('Comment publish requires replyDraft and commentId.');
  }

  const family = getText(context.eventInput.payload.targetRecordFamilyHash)
    ?? getText(context.eventInput.payload.target_record_family_hash)
    ?? '';
  const target = context.eventInput.bindingType === 'task' || family.toLowerCase().includes('task')
    ? 'tasks'
    : 'docs';
  if (isFlightDeckPgPublisherContext(context)) {
    if (target !== 'tasks') {
      return {
        published: false,
        status: 'failed',
        operation: 'docs.reply',
        commentId,
        reason: 'Flight Deck PG document comment replies are not available yet.',
        agentResponse: response,
      };
    }
    const taskId = getText(context.eventInput.payload.targetRecordId)
      ?? getText(context.eventInput.payload.target_record_id)
      ?? context.eventInput.bindingId;
    if (!taskId) {
      throw new Error('Task comment publish requires a target task id.');
    }
    const normalizedBody = normalisePublishedMarkdownBody(body);
    const result = await createFlightDeckPgTaskCommentFromContext(context, taskId, normalizedBody, {
      autopilot_dispatch: true,
      operation: 'tasks.reply',
      parent_comment_id: commentId,
    });
    return {
      published: true,
      status: 'ok',
      operation: 'tasks.reply',
      commentId,
      taskId,
      result,
      agentResponse: {
        ...response,
        replyDraft: normalizedBody,
      },
    };
  }
  const result = await runYokeJson(context, [
    target,
    'reply',
    commentId,
    '--body',
    body,
    '--json',
  ]);

  return {
    published: true,
    status: 'ok',
    operation: `${target}.reply`,
    commentId,
    result,
    agentResponse: response,
  };
}

async function runYokeJson(
  _context: DispatchPipelineFlightDeckPublisherContext,
  _args: string[],
): Promise<unknown> {
  throw new Error('Yoke fallback is disabled; Flight Deck PG/Tower publisher support is required.');
}

function stepNeedsFlightDeckPublisher(step: DeclarativeStep): boolean {
  if (
    step.type === 'code'
    && (
      step.function === 'dispatch.publishFlightDeckResponse'
      || step.function === 'dispatch.hydrateChatContext'
      || step.function === 'dispatch.reloadChatThread'
      || step.function === 'dispatch.createChatTask'
      || step.function === 'dispatch.blockTaskIfPipelineLaunchFailed'
      || step.function === 'dispatch.publishNeedsInput'
      || step.function === 'dispatch.markTaskInProgress'
      || step.function === 'dispatch.markTaskReadyForReview'
      || step.function === 'dispatch.ensureImplementationReviewTask'
      || step.function === 'dispatch.commentImplementationReviewProgress'
      || step.function === 'dispatch.ensureDiscussionDocument'
      || step.function === 'dispatch.prepareDocumentInvocationContext'
      || step.function === 'dispatch.publishDocumentInvocationSummary'
      || step.function === 'dispatch.prepareTaskInvocationContext'
      || step.function === 'dispatch.publishTaskInvocationResponse'
      || step.function === 'dispatch.completeReviewTaskFromChat'
    )
  ) {
    return true;
  }
  if (step.type === 'loop') {
    return (step.steps ?? []).some(stepNeedsFlightDeckPublisher);
  }
  if (step.type === 'parallel') {
    return stepNeedsFlightDeckPublisher(step.step);
  }
  return false;
}

function buildRuntimeCommands(
  _eventInput: DispatchPipelineEventInput,
  _stateDir: string,
  _commandPrefix: string,
): Record<string, string> {
  return {};
}

function buildTaskCommentBody(
  mode: 'task_dispatch' | 'task_review',
  state: string,
  response: Record<string, unknown>,
): string {
  const lines = [`Wingman pipeline ${mode === 'task_review' ? 'review' : 'update'}: ${state}`];
  const summary = getText(response.taskSummary)
    ?? getText(response.reviewSummary)
    ?? getText(response.summary)
    ?? getText(response.replyDraft);
  if (summary) {
    lines.push(`Summary: ${summary}`);
  }
  const childPipeline = objectValue(response.childPipeline);
  const childRunId = getText(childPipeline.pipelineRunId);
  if (childRunId) {
    lines.push(`Started child pipeline: ${childRunId}`);
  }
  const requiredChanges = getStringArray(response.requiredChanges);
  if (requiredChanges.length > 0) {
    lines.push(`Required changes: ${requiredChanges.join('; ')}`);
  }
  const risks = getStringArray(response.risks);
  if (risks.length > 0) {
    lines.push(`Risks: ${risks.join('; ')}`);
  }
  const updateError = getText(response.updateError);
  if (updateError) {
    lines.push(`Update warning: ${updateError}`);
  }
  if (typeof response.confidence === 'number' && Number.isFinite(response.confidence)) {
    lines.push(`Confidence: ${Math.round(response.confidence * 100)}%`);
  }
  return lines.join('\n');
}

function normaliseTaskState(response: Record<string, unknown>): string {
  if (response.accepted === false) {
    return 'blocked';
  }
  const suggested = getText(response.suggestedStatus)?.toLowerCase().replace(/[\s-]+/g, '_');
  return suggested && KNOWN_TASK_STATES.has(suggested) ? suggested : 'in_progress';
}

function normaliseReviewState(response: Record<string, unknown>): string {
  const decision = getText(response.decision)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (decision === 'accept' || decision === 'accepted' || decision === 'approve' || decision === 'approved') {
    return 'done';
  }
  if (decision === 'reject' || decision === 'rejected') {
    return 'blocked';
  }
  return 'in_progress';
}

function syncResultRejected(value: unknown): boolean {
  const result = objectValue(value);
  return Array.isArray(result.rejected) && result.rejected.length > 0;
}

function summariseSyncRejection(value: unknown): string {
  const result = objectValue(value);
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  if (rejected.length === 0) {
    return 'unknown rejection';
  }
  return rejected
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      const record = objectValue(entry);
      return getText(record.reason)
        ?? getText(record.error)
        ?? getText(record.message)
        ?? JSON.stringify(record);
    })
    .join('; ');
}

async function syncFlightDeckRuntime(context: DispatchPipelineFlightDeckPublisherContext): Promise<void> {
  try {
    await runYokeJson(context, ['sync', '--json']);
  } catch {
    // The following task update still performs its own refresh through Yoke.
  }
}

async function loadFlightDeckTask(
  context: DispatchPipelineFlightDeckPublisherContext,
  taskId: string,
): Promise<Record<string, unknown>> {
  try {
    return objectValue(await runYokeJson(context, ['tasks', 'show', taskId, '--json']));
  } catch {
    return {};
  }
}

function resolveRequesterNpub(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): string | null {
  const record = objectValue(input.record);
  const payload = objectValue(record.payload ?? context.eventInput.payload);
  const data = objectValue(payload.data);
  const workPlan = objectValue(input.workPlan);
  const createdTask = objectValue(input.createdTask);
  return firstExternalNpub([
    input.reviewerNpub,
    input.requesterNpub,
    workPlan.reviewerNpub,
    workPlan.assignerNpub,
    createdTask.reviewerNpub,
    createdTask.assignerNpub,
    record.updaterNpub,
    context.eventInput.updaterNpub,
    payload.signature_npub,
    data.signature_npub,
    data.created_by_npub,
    data.owner_npub,
    payload.owner_npub,
    context.eventInput.subscription.managedByNpub,
  ], [
    context.eventInput.subscription.botNpub,
    context.eventInput.subscription.wsKeyNpub,
  ]);
}

async function loadMentionedFlightDeckRecords(
  context: DispatchPipelineFlightDeckPublisherContext,
  thread: unknown,
): Promise<Array<Record<string, unknown>>> {
  const mentions = extractMentionRefs(thread).slice(0, 20);
  const records: Array<Record<string, unknown>> = [];
  for (const mention of mentions) {
    const command = commandForMention(mention);
    if (!command) continue;
    try {
      const record = await runYokeJson(context, command);
      records.push({
        type: mention.type,
        id: mention.id,
        status: 'ok',
        record,
      });
    } catch (error) {
      records.push({
        type: mention.type,
        id: mention.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}

function commandForMention(mention: { type: string; id: string }): string[] | null {
  const type = mention.type.toLowerCase();
  if (type === 'task') return ['tasks', 'show', mention.id, '--json'];
  if (type === 'doc' || type === 'document') return ['docs', 'show', mention.id, '--json'];
  if (type === 'flow') return ['flows', 'get', mention.id, '--json'];
  if (type === 'scope') return ['scopes', 'show', mention.id, '--json'];
  return null;
}

function extractMentionRefs(value: unknown): Array<{ type: string; id: string }> {
  const seen = new Set<string>();
  const refs: Array<{ type: string; id: string }> = [];
  const visit = (entry: unknown) => {
    if (typeof entry === 'string') {
      const re = /@\[.*?\]\(mention:(\w+):([^)]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(entry)) !== null) {
        const type = match[1]?.trim();
        const id = match[2]?.trim();
        if (!type || !id || type === 'person') continue;
        const key = `${type}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ type, id });
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const item of Object.values(entry as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return refs;
}

async function loadReferencedFlightDeckPgDocuments(
  context: DispatchPipelineFlightDeckPublisherContext,
  thread: unknown,
  channelId: string,
): Promise<Array<Record<string, unknown>>> {
  const candidateTitles = extractThreadDocumentTitleCandidates(thread);
  if (candidateTitles.length === 0) {
    return [];
  }
  try {
    const result = await listFlightDeckPgChannelDocs({
      ...getFlightDeckPgPublishContext(context),
      channelId,
      limit: 100,
    });
    const wanted = candidateTitles.map((title) => normalizeDocumentLookupTitle(title));
    const docs = Array.isArray(result.docs) ? result.docs : [];
    return docs
      .filter((doc) => {
        const title = normalizeDocumentLookupTitle(getText(doc.title));
        return Boolean(title && wanted.includes(title));
      })
      .slice(0, 8)
      .map((doc) => ({
        type: 'document',
        family: 'document',
        recordFamily: 'document',
        id: doc.id,
        recordId: doc.id,
        title: getText(doc.title),
        summary: getText(doc.summary),
        state: 'current',
        channelId: getText(doc.channel_id),
        scopeId: getText(doc.scope_id),
        rowVersion: doc.row_version ?? null,
        status: 'ok',
        referenceSource: 'pg_channel_doc_title',
      }));
  } catch (error) {
    return [{
      type: 'document',
      family: 'document',
      status: 'failed',
      referenceSource: 'pg_channel_doc_title',
      titleCandidates: candidateTitles,
      error: error instanceof Error ? error.message : String(error),
    }];
  }
}

function extractThreadDocumentTitleCandidates(thread: unknown): string[] {
  const messages = Array.isArray(thread)
    ? thread
    : Array.isArray(objectValue(thread).recent_messages)
      ? objectValue(thread).recent_messages as unknown[]
      : [];
  if (messages.length === 0) {
    return [];
  }
  const candidates: string[] = [];
  const add = (value: string) => {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };
  for (const message of messages.slice(-12)) {
    const body = getText(objectValue(message).body);
    for (const title of extractQuotedDocumentTitles(body)) {
      add(title);
    }
  }
  return candidates.slice(0, 8);
}

function buildChatCreatedTaskDescription(
  context: DispatchPipelineFlightDeckPublisherContext,
  decision: Record<string, unknown>,
): string {
  const workPlan = objectValue(decision.workPlan);
  const taskDraft = objectValue(decision.taskDraft);
  const channelId = context.eventInput.channelId ?? getText(context.eventInput.payload.channel_id);
  const threadId = context.eventInput.threadId ?? getText(context.eventInput.payload.thread_id);
  const requestMessageId = context.eventInput.recordId;
  const lines = [
    getText(taskDraft.instructions) ?? getText(workPlan.instructions) ?? getText(workPlan.taskSummary) ?? 'Task created from chat dispatch.',
    '',
    'Dispatch context:',
    channelId ? `- Channel: ${mention('channel', channelId, 'Flight Deck chat')}` : '',
    threadId ? `- Thread: ${mention('message', threadId, 'thread root')}` : '',
    requestMessageId ? `- Request message: ${mention('message', requestMessageId, 'dispatch request')}` : '',
    getText(workPlan.pipelineDefinitionId ?? workPlan.childPipelineDefinitionId) ? `- Pipeline: ${getText(workPlan.pipelineDefinitionId ?? workPlan.childPipelineDefinitionId)}` : '',
    getText(workPlan.scopeId) ? `- Scope: ${mention('scope', getText(workPlan.scopeId)!, 'selected scope')}` : '',
    getText(workPlan.workdir) ? `- Workdir: ${getText(workPlan.workdir)}` : '',
    getText(workPlan.assignerNpub) ? `- Assigner: ${getText(workPlan.assignerNpub)}` : '',
    getText(workPlan.reviewerNpub) ? `- Reviewer: ${getText(workPlan.reviewerNpub)}` : '',
    ...formatOriginThreadContext(workPlan.originThread),
    ...formatReferencedRecordsContext(workPlan.referencedRecords),
    '',
    ...formatList('Acceptance criteria', getStringArray(workPlan.acceptanceCriteria)),
    ...formatList('Execution plan', getStringArray(workPlan.executionPlan)),
    ...formatList('Manager checklist', getStringArray(workPlan.managerChecklist)),
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function normalisePublishedMarkdownBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return normalisePublishedMarkdownBody(parsed);
      }
    } catch {
      // Fall through to escape normalization below.
    }
  }
  if (!value.includes('\n') && /\\[nr]/.test(value)) {
    return value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n');
  }
  return value;
}

function findDiscussionDocumentReference(input: JsonObject): {
  documentId: string | null;
  documentTitle: string | null;
  documentUrl: string | null;
} {
  const documentContext = objectValue(input.documentContext);
  const directId = getText(documentContext.documentId);
  if (directId) {
    return {
      documentId: directId,
      documentTitle: getText(documentContext.documentTitle),
      documentUrl: getText(documentContext.documentUrl),
    };
  }

  const contexts = [
    objectValue(input.chatContext),
    objectValue(input.originalChatContext),
    objectValue(input.freshChatContext),
    objectValue(input.workPlan),
  ];
  for (const context of contexts) {
    const directReference = objectValue(context.documentReference);
    const referencedRecords = [
      ...(Object.keys(directReference).length > 0 ? [directReference] : []),
      ...(Array.isArray(context.referencedRecords) ? context.referencedRecords : []),
    ];
    for (const entry of referencedRecords) {
      const record = objectValue(entry);
      const nested = objectValue(record.record);
      const candidate = Object.keys(nested).length > 0 ? nested : record;
      const type = getText(record.type ?? candidate.type ?? candidate.recordFamily ?? candidate.record_family)?.toLowerCase();
      const id = getText(record.id ?? record.recordId ?? record.record_id ?? candidate.recordId ?? candidate.record_id);
      if (id && (type === 'doc' || type === 'document' || type === 'documents')) {
        return {
          documentId: id,
          documentTitle: getText(candidate.title ?? objectValue(candidate.payload).title),
          documentUrl: getText(candidate.url ?? objectValue(candidate.payload).url),
        };
      }
    }
  }

  const mention = extractMentionRefs([
    input.chatDispatchInput,
    input.chatContext,
    input.originalChatContext,
    input.freshChatContext,
    input.workPlan,
  ]).find((ref) => ref.type.toLowerCase() === 'doc' || ref.type.toLowerCase() === 'document');
  return {
    documentId: mention?.id ?? null,
    documentTitle: null,
    documentUrl: null,
  };
}

function extractDiscussionDocumentTitleCandidates(input: JsonObject, workPlan: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    const text = getText(value);
    if (text && !candidates.includes(text)) {
      candidates.push(text);
    }
  };
  const documentContext = objectValue(input.documentContext);
  add(documentContext.documentTitle);
  add(documentContext.title);
  add(workPlan.documentTitle);
  add(workPlan.title);

  const promptSources = [
    documentContext.discussionGoal,
    workPlan.originalPrompt,
    workPlan.taskSummary,
    input.originalPrompt,
  ];
  for (const source of promptSources) {
    for (const title of extractQuotedDocumentTitles(getText(source))) {
      add(title);
    }
  }

  const threadSources = [
    objectValue(input.chatDispatchInput).latestThread,
    objectValue(input.chatContext).latestThread,
    objectValue(input.chatContext).thread,
  ];
  for (const source of threadSources) {
    if (!Array.isArray(source)) continue;
    for (const message of source.slice(-8)) {
      const body = getText(objectValue(message).body);
      for (const title of extractQuotedDocumentTitles(body)) {
        add(title);
      }
    }
  }
  return candidates.slice(0, 8);
}

function extractQuotedDocumentTitles(text: string | null): string[] {
  if (!text) return [];
  const titles: string[] = [];
  const quoted = text.matchAll(/["“”']([^"“”'\n]{3,160})["“”']/g);
  for (const match of quoted) {
    const title = match[1]?.trim();
    if (title) titles.push(title);
  }
  return titles;
}

function normalizeDocumentLookupTitle(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized || null;
}

function buildDiscussionDocumentTitle(input: JsonObject, workPlan: Record<string, unknown>): string {
  return compactSingleLine(
    getText(workPlan.taskSummary)
      ?? getText(workPlan.title)
      ?? getText(objectValue(input.documentContext).discussionGoal)
      ?? getText(workPlan.originalPrompt),
    80,
  ) ?? 'Flight Deck discussion';
}

function buildDiscussionDocumentScaffold(input: JsonObject, workPlan: Record<string, unknown>, title: string): string {
  const originalPrompt = getText(workPlan.originalPrompt)
    ?? getText(objectValue(input.documentContext).discussionGoal)
    ?? 'Continue the document-centred discussion from the linked Flight Deck chat thread.';
  const origin = objectValue(workPlan.origin);
  const originThread = Array.isArray(workPlan.originThread)
    ? workPlan.originThread
    : Array.isArray(objectValue(input.chatDispatchInput).latestThread)
      ? objectValue(input.chatDispatchInput).latestThread as unknown[]
      : [];
  const lines = [
    `# ${title}`,
    '',
    '## Discussion Goal',
    originalPrompt,
    '',
    '## Working Notes',
    '- Capture decisions, constraints, open questions, and design changes here as the discussion evolves.',
    '',
    '## Source Thread',
    getText(origin.channelId) ? `- Channel: ${mention('channel', getText(origin.channelId)!, 'source chat')}` : '',
    getText(origin.threadId) ? `- Thread: ${mention('message', getText(origin.threadId)!, 'discussion thread')}` : '',
    getText(origin.messageId) ? `- Request: ${mention('message', getText(origin.messageId)!, 'latest request')}` : '',
    ...formatOriginThreadContext(originThread),
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function formatOriginThreadContext(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  const lines = ['', 'Originating chat context:'];
  for (const entry of value.slice(-8)) {
    const message = objectValue(entry);
    const body = compactSingleLine(getText(message.body), 700);
    if (!body) continue;
    const sender = compactSingleLine(getText(message.senderNpub), 24) ?? 'unknown sender';
    const messageId = getText(message.messageId);
    lines.push(`- ${sender}${messageId ? ` (${messageId})` : ''}: ${body}`);
  }
  return lines.length > 2 ? lines : [];
}

function formatReferencedRecordsContext(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  const lines = ['', 'Referenced Flight Deck records:'];
  for (const entry of value.slice(0, 8)) {
    const record = objectValue(entry);
    const label = getText(record.title)
      ?? getText(record.recordId)
      ?? getText(record.id)
      ?? 'Untitled record';
    const family = getText(record.family) ?? 'record';
    const summary = compactSingleLine(getText(record.summary), 500);
    lines.push(`- ${family}: ${label}${summary ? ` - ${summary}` : ''}`);
  }
  return lines.length > 2 ? lines : [];
}

function formatList(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return ['', `${title}:`, ...items.map((item) => `- ${item}`)];
}

function mention(type: string, id: string, label: string): string {
  return `@[${label}](mention:${type}:${id})`;
}

function getCreatedRecordId(value: unknown): string | null {
  const result = objectValue(value);
  const direct = getText(result.record_id)
    ?? getText(result.task_id)
    ?? getText(result.recordId)
    ?? getText(result.taskId);
  if (direct) return direct;

  const createdRecordIds = getStringArray(result.created_record_ids ?? result.createdRecordIds);
  if (createdRecordIds.length > 0) return createdRecordIds[0]!;

  const accepted = Array.isArray(result.accepted) ? result.accepted : [];
  for (const record of accepted) {
    const id = getText(objectValue(record).record_id) ?? getText(objectValue(record).recordId);
    if (id) return id;
  }

  const records = Array.isArray(result.records) ? result.records : [];
  for (const record of records) {
    const id = getText(objectValue(record).record_id);
    if (id) return id;
  }
  return null;
}

async function listMatchingTaskIds(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    title: string;
    state: string;
    assignedTo: string;
  },
): Promise<Set<string>> {
  const rows = await listTasks(context);
  return new Set(rows
    .filter((row) => taskMatchesCreatedChatTask(row, input))
    .map((row) => getText(row.record_id))
    .filter((id): id is string => Boolean(id)));
}

async function findNewlyCreatedTaskId(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: {
    title: string;
    state: string;
    assignedTo: string;
    previousTaskIds: Set<string>;
  },
): Promise<string | null> {
  const rows = await listTasks(context);
  const candidates = rows
    .filter((row) => taskMatchesCreatedChatTask(row, input))
    .filter((row) => {
      const id = getText(row.record_id);
      return id && !input.previousTaskIds.has(id);
    })
    .sort((left, right) => parseTime(right.updated_at) - parseTime(left.updated_at));
  return getText(candidates[0]?.record_id);
}

async function listTasks(
  context: DispatchPipelineFlightDeckPublisherContext,
): Promise<Array<Record<string, unknown>>> {
  const result = await runYokeJson(context, ['tasks', 'list', '--json']);
  return Array.isArray(result)
    ? result.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : [];
}

function taskMatchesCreatedChatTask(
  row: Record<string, unknown>,
  input: {
    title: string;
    state: string;
    assignedTo: string;
  },
): boolean {
  return getText(row.title) === input.title
    && getText(row.state) === input.state
    && getText(row.assigned_to_npub) === input.assignedTo;
}

function parseTime(value: unknown): number {
  const timestamp = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function resolveTaskId(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
): string | null {
  const workPlan = objectValue(input.workPlan);
  const createdTask = objectValue(input.createdTask);
  const record = objectValue(input.record);
  const payload = objectValue(record.payload ?? context.eventInput.payload);
  const isTaskDispatch = context.eventInput.triggerKind === 'task' || context.eventInput.triggerKind === 'task_review';
  return getText(input.taskId)
    ?? getText(workPlan.taskId)
    ?? getText(createdTask.taskId)
    ?? getText(payload.taskId)
    ?? getText(payload.task_id)
    ?? (isTaskDispatch ? getText(payload.record_id) : null)
    ?? (isTaskDispatch
      ? getRecordId(context.eventInput)
      : null);
}

function firstExternalNpub(values: unknown[], excludedNpubs: Array<string | null | undefined>): string | null {
  const excluded = new Set(excludedNpubs.filter((value): value is string => typeof value === 'string' && value.length > 0));
  for (const value of values) {
    const npub = getText(value);
    if (npub && !excluded.has(npub)) {
      return npub;
    }
  }
  return null;
}

function buildInProgressComment(input: JsonObject): string {
  const workPlan = objectValue(input.workPlan ?? input.agentResponse ?? input);
  const summary = getText(workPlan.taskSummary) ?? getText(workPlan.summary) ?? 'Task accepted for pipeline dispatch.';
  const workStyle = getText(workPlan.workStyle);
  return [
    'Pipeline intake: moved task to in_progress before dispatch.',
    `Summary: ${summary}`,
    ...(workStyle ? [`Dispatch target: ${workStyle}`] : []),
  ].join('\n');
}

async function publishNeedsInputChatNotification(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  taskId: string | null,
  question: string,
): Promise<{
  notified: boolean;
  result: unknown;
  error: string | null;
  skippedReason: string | null;
}> {
  const workPlan = objectValue(input.workPlan);
  const origin = objectValue(workPlan.origin);
  const channelId = context.eventInput.channelId
    ?? getText(origin.channelId)
    ?? getText(objectValue(input.routing).channelId);
  const threadId = context.eventInput.threadId
    ?? getText(origin.threadId)
    ?? getText(objectValue(input.routing).threadId);
  if (!channelId || !threadId) {
    return {
      notified: false,
      result: null,
      error: null,
      skippedReason: 'missing_origin_chat_thread',
    };
  }

  try {
    if (isFlightDeckPgPublisherContext(context)) {
      const replyBody = buildNeedsInputChatReply(input, taskId, question);
      const result = await createFlightDeckPgChannelMessageFromContext(context, {
        channelId,
        body: replyBody,
        threadId,
        metadata: {
          autopilot_dispatch: true,
          source_message_id: context.eventInput.recordId,
          subscription_id: context.eventInput.subscription.subscriptionId,
          notification_kind: 'needs_input',
        },
        speechTitle: 'Spoken needs-input summary',
        speechFilePrefix: 'flightdeck-needs-input-tts',
        userPrompt: getText(objectValue(context.eventInput.payload)?.body),
      });
      return {
        notified: true,
        result,
        error: null,
        skippedReason: null,
      };
    }
    const result = await runYokeJson(context, [
      'chat',
      'reply-current',
      '--body',
      buildNeedsInputChatReply(input, taskId, question),
      '--skip-refresh',
      '--channel',
      channelId,
      '--thread',
      threadId,
      '--format',
      'json',
    ]);
    return {
      notified: true,
      result,
      error: null,
      skippedReason: null,
    };
  } catch (error) {
    return {
      notified: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      skippedReason: null,
    };
  }
}

function buildNeedsInputTaskComment(input: JsonObject, question: string): string {
  const workerResult = extractNeedsInputPayload(input);
  const summary = getText(workerResult.summary) ?? 'The pipeline needs input before it can continue.';
  const lines = [
    'Pipeline needs input before it can continue.',
    `Summary: ${summary}`,
    `Question: ${question}`,
  ];
  const blockers = getStringArray(workerResult.blockers);
  if (blockers.length > 0) {
    lines.push(`Blockers: ${blockers.join('; ')}`);
  }
  return lines.join('\n');
}

function buildNeedsInputChatReply(input: JsonObject, taskId: string | null, question: string): string {
  const lines = [
    'I need more information before I can continue.',
    ...(taskId ? [`Task: ${mention('task', taskId, 'needs-input task')}`] : []),
    `Question: ${question}`,
  ];
  const blockers = getStringArray(extractNeedsInputPayload(input).blockers);
  if (blockers.length > 0) {
    lines.push(`Blockers: ${blockers.join('; ')}`);
  }
  return lines.join('\n');
}

function buildNeedsInputQuestion(input: JsonObject): string {
  const workerResult = extractNeedsInputPayload(input);
  const result = getText(workerResult.result);
  const resultQuestion = result?.replace(/^needs_input:\s*/i, '').trim();
  const blockers = getStringArray(workerResult.blockers);
  return getText(workerResult.taskUpdateComment)
    ?? getText(workerResult.clarifyingQuestion)
    ?? getText(workerResult.question)
    ?? (resultQuestion && resultQuestion.length > 0 ? resultQuestion : null)
    ?? (blockers.length > 0 ? `Please resolve: ${blockers.join('; ')}` : null)
    ?? 'What information should I use to continue this task?';
}

function extractNeedsInputPayload(input: JsonObject): Record<string, unknown> {
  for (const candidate of [input.workerResult, input.agentResponse, input.result]) {
    const value = objectValue(candidate);
    if (Object.keys(value).length > 0) {
      return value;
    }
  }
  return input;
}

function buildImplementationReviewTaskTitle(
  input: JsonObject,
  workPlan: Record<string, unknown>,
): string {
  return getText(input.taskTitle)
    ?? getText(workPlan.taskSummary)
    ?? getText(workPlan.title)
    ?? compactSingleLine(getText(input.implementationPrompt), 90)
    ?? 'Implementation review loop';
}

function buildImplementationReviewTaskDescription(
  context: DispatchPipelineFlightDeckPublisherContext,
  input: JsonObject,
  workPlan: Record<string, unknown>,
): string {
  const lines = [
    getText(input.implementationPrompt)
      ?? getText(workPlan.instructions)
      ?? getText(workPlan.taskSummary)
      ?? 'Run the implementation review loop.',
    '',
    'Implementation review loop context:',
    getText(input.designDocumentUrl ?? workPlan.designDocumentUrl)
      ? `- Design: ${getText(input.designDocumentUrl ?? workPlan.designDocumentUrl)}`
      : '',
    getText(input.designDocumentUnavailableReason ?? workPlan.designDocumentUnavailableReason)
      ? `- Design note: ${getText(input.designDocumentUnavailableReason ?? workPlan.designDocumentUnavailableReason)}`
      : '',
    getText(input.workingDirectory ?? workPlan.workdir ?? workPlan.workingDirectory)
      ? `- Working directory: ${getText(input.workingDirectory ?? workPlan.workdir ?? workPlan.workingDirectory)}`
      : '',
    context.eventInput.channelId ? `- Source channel: ${mention('channel', context.eventInput.channelId, 'Flight Deck chat')}` : '',
    context.eventInput.threadId ? `- Source thread: ${mention('message', context.eventInput.threadId, 'thread root')}` : '',
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function buildImplementationReviewStartedComment(input: JsonObject, taskId: string): string {
  const workPlan = objectValue(input.workPlan ?? objectValue(input.createdTask).workPlan);
  const summary = getText(workPlan.taskSummary)
    ?? getText(input.implementationPrompt)
    ?? 'Implementation review loop started.';
  const lines = [
    'Pipeline intake: implementation review loop started.',
    `Task: ${mention('task', taskId, 'implementation task')}`,
    `Summary: ${summary}`,
  ];
  const designDocumentUrl = getText(workPlan.designDocumentUrl ?? input.designDocumentUrl);
  if (designDocumentUrl) {
    lines.push(`Design/reference: ${designDocumentUrl}`);
  }
  const designDocumentUnavailableReason = getText(workPlan.designDocumentUnavailableReason ?? input.designDocumentUnavailableReason);
  if (designDocumentUnavailableReason) {
    lines.push(`Design/reference note: ${designDocumentUnavailableReason}`);
  }
  const maxIterations = Number(input.maxReviewIterations ?? workPlan.maxReviewIterations);
  if (Number.isFinite(maxIterations) && maxIterations > 0) {
    lines.push(`Review loop limit: ${Math.floor(maxIterations)} manager pass(es).`);
  }
  return lines.join('\n');
}

function buildImplementationReviewProgressComment(input: JsonObject): string {
  const loop = objectValue(input.reviewLoop);
  const managerReview = objectValue(input.managerReview);
  const iteration = Number(loop.iteration ?? loop.completed ?? 1);
  const done = managerReview.done === true;
  const summary = getText(managerReview.managerSummary)
    ?? getText(managerReview.reviewSummary)
    ?? (done ? 'Manager accepted the implementation.' : 'Manager requested follow-up work.');
  const lines = [
    `Manager review iteration ${Number.isFinite(iteration) ? iteration : 1}: ${done ? 'approved' : 'changes requested'}.`,
    `Summary: ${summary}`,
  ];
  const pickups = Array.isArray(managerReview.pickups) ? managerReview.pickups : [];
  if (pickups.length > 0) {
    lines.push('Pickups:');
    for (const pickup of pickups.slice(0, 5)) {
      const record = objectValue(pickup);
      const title = getText(record.title) ?? 'Untitled pickup';
      const action = getText(record.action);
      lines.push(`- ${title}${action ? `: ${action}` : ''}`);
    }
  }
  const risks = getStringArray(managerReview.risks);
  if (risks.length > 0) {
    lines.push(`Risks: ${risks.join('; ')}`);
  }
  const nextWorkerPrompt = getText(managerReview.nextWorkerPrompt);
  if (!done && nextWorkerPrompt) {
    lines.push(`Next worker prompt: ${compactSingleLine(nextWorkerPrompt, 500)}`);
  }
  return lines.join('\n');
}

function getIncompleteImplementationReviewCloseout(input: JsonObject): { reason: string; remainingPickups: string[] } | null {
  const managerReview = objectValue(input.agentResponse ?? input.managerReview);
  const workerResult = objectValue(input.workerResult);
  const hasManagerDone = typeof managerReview.done === 'boolean';
  const status = getText(workerResult.status)?.toLowerCase() ?? '';
  if (hasManagerDone && managerReview.done !== true) {
    return {
      reason: 'manager_review_not_done',
      remainingPickups: extractRemainingImplementationPickups(managerReview, workerResult),
    };
  }
  if (!hasManagerDone && (status === 'incomplete' || status === 'max_iterations_reached')) {
    return {
      reason: status,
      remainingPickups: extractRemainingImplementationPickups(managerReview, workerResult),
    };
  }
  return null;
}

function extractRemainingImplementationPickups(
  managerReview: Record<string, unknown>,
  workerResult: Record<string, unknown>,
): string[] {
  const fromWorker = getStringArray(workerResult.remainingPickups);
  if (fromWorker.length > 0) return fromWorker;
  const pickups = Array.isArray(managerReview.pickups) ? managerReview.pickups : [];
  return pickups
    .map((pickup) => {
      const record = objectValue(pickup);
      const title = getText(record.title);
      const action = getText(record.action);
      if (title && action) return `${title}: ${action}`;
      return title ?? action ?? null;
    })
    .filter((value): value is string => Boolean(value));
}

function buildImplementationReviewIncompleteComment(
  input: JsonObject,
  closeout: { reason: string; remainingPickups: string[] },
): string {
  const managerReview = objectValue(input.agentResponse ?? input.managerReview);
  const workerResult = objectValue(input.workerResult);
  const summary = getText(workerResult.summary)
    ?? getText(workerResult.reportSummary)
    ?? getText(managerReview.managerSummary)
    ?? getText(managerReview.reviewSummary)
    ?? 'Implementation review did not clear manager review.';
  const lines = [
    'Pipeline handoff: implementation review is not complete; task remains in progress.',
    `Reason: ${closeout.reason}.`,
    `Summary: ${summary}`,
  ];
  const managerSummary = getText(managerReview.managerSummary ?? managerReview.reviewSummary);
  if (managerSummary && managerSummary !== summary) {
    lines.push(`Manager review: ${managerSummary}`);
  }
  if (closeout.remainingPickups.length > 0) {
    lines.push('Remaining pickups:');
    for (const pickup of closeout.remainingPickups.slice(0, 8)) {
      lines.push(`- ${compactSingleLine(pickup, 400)}`);
    }
  }
  const taskUpdateComment = getText(workerResult.taskUpdateComment);
  if (taskUpdateComment && taskUpdateComment !== summary) {
    lines.push(taskUpdateComment);
  }
  return lines.join('\n');
}

function buildImplementationReviewIncompleteChatReply(
  input: JsonObject,
  _taskId: string,
  closeout: { reason: string; remainingPickups: string[] },
): string {
  const finalThreadResponse = objectValue(input.finalThreadResponse);
  const finalBody = getText(finalThreadResponse.body);
  if (finalBody) {
    return normalizeFinalThreadReplyBody(finalBody);
  }
  const managerReview = objectValue(input.agentResponse ?? input.managerReview);
  const workerResult = objectValue(input.workerResult);
  const summary = getText(workerResult.summary)
    ?? getText(workerResult.reportSummary)
    ?? getText(managerReview.managerSummary)
    ?? 'The implementation pass ran, but manager review still has required pickups.';
  const lines = [
    summary,
    `It did not clear manager review, so I left the task in progress instead of marking it ready for review.`,
  ];
  if (closeout.remainingPickups.length > 0) {
    lines.push('Remaining pickups:');
    for (const pickup of closeout.remainingPickups.slice(0, 5)) {
      lines.push(`- ${compactSingleLine(pickup, 300)}`);
    }
  }
  const taskUpdateComment = getText(workerResult.taskUpdateComment);
  if (taskUpdateComment && taskUpdateComment !== summary) {
    lines.push(taskUpdateComment);
  }
  return lines.join('\n');
}

function buildReadyForReviewComment(input: JsonObject, reviewerNpub: string | null): string {
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const workerResult = objectValue(input.workerResult);
  const finalThreadResponse = objectValue(input.finalThreadResponse);
  const summary = getText(workerResult.reportSummary)
    ?? getText(workerResult.summary)
    ?? getText(finalThreadResponse.summary)
    ?? getText(response.summary)
    ?? getText(response.reviewSummary)
    ?? 'Pipeline work is ready for review.';
  const taskUpdateComment = getText(workerResult.taskUpdateComment);
  const lines = [
    reviewerNpub
      ? `Pipeline handoff: moved task to review and assigned it to ${reviewerNpub}.`
      : 'Pipeline handoff: moved task to review.',
    `Summary: ${summary}`,
  ];
  lines.push(...buildWorkerResultLines(input, { maxLength: 6000 }));
  if (taskUpdateComment && taskUpdateComment !== summary) {
    lines.push(taskUpdateComment);
  }
  lines.push(...buildReviewDocumentLines(input));
  const requiredChanges = getStringArray(response.requiredChanges);
  if (requiredChanges.length > 0) {
    lines.push(`Required changes: ${requiredChanges.join('; ')}`);
  }
  const risks = getStringArray(response.risks);
  if (risks.length > 0) {
    lines.push(`Risks: ${risks.join('; ')}`);
  }
  if (typeof response.confidence === 'number' && Number.isFinite(response.confidence)) {
    lines.push(`Confidence: ${Math.round(response.confidence * 100)}%`);
  }
  return lines.join('\n');
}

function buildReadyForReviewChatReply(
  input: JsonObject,
  _taskId: string,
  _reviewerNpub: string | null,
): string {
  const finalThreadResponse = objectValue(input.finalThreadResponse);
  const finalBody = getText(finalThreadResponse.body);
  if (finalBody) {
    return ensureFinalThreadReplyLinks(finalBody, input);
  }
  const response = objectValue(input.agentResponse ?? input.response ?? input);
  const workerResult = objectValue(input.workerResult);
  const summary = getText(workerResult.reportSummary)
    ?? getText(workerResult.summary)
    ?? getText(response.summary)
    ?? getText(response.reviewSummary)
    ?? 'I have completed the work.';
  const documentLines = buildReviewDocumentLines(input);
  const lines = [summary];
  if (documentLines.length > 0) {
    lines.push(...documentLines);
  }
  lines.push(...buildWorkerResultLines(input, { maxLength: 2200 }));
  const taskUpdateComment = getText(workerResult.taskUpdateComment);
  if (taskUpdateComment && taskUpdateComment !== summary) {
    lines.push(taskUpdateComment);
  }
  return lines.join('\n');
}

function ensureFinalThreadReplyLinks(body: string, input: JsonObject): string {
  const lines = [normalizeFinalThreadReplyBody(body)];
  const documentLines = buildReviewDocumentLines(input);
  for (const line of documentLines) {
    if (!lines.some((existing) => existing.includes(line))) {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

function normalizeFinalThreadReplyBody(body: string): string {
  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !/^(Task|Assigned back to):\s+/i.test(line.trim()));
  const normalized = lines
    .join('\n')
    .replace(/^\s*(Summary|Pipeline handoff):\s*/i, '')
    .trim();
  return normalized || body.trim();
}

function buildWorkerResultLines(
  input: JsonObject,
  options: { maxLength: number },
): string[] {
  if (buildReviewDocumentLines(input).length > 0) {
    return [];
  }
  const workerResult = objectValue(input.workerResult);
  const result = getText(workerResult.result);
  if (!result) {
    return [];
  }
  return [
    'Result:',
    truncateBlock(result, options.maxLength),
  ];
}

function buildReviewDocumentLines(input: JsonObject): string[] {
  const workerResult = objectValue(input.workerResult);
  const documentId = getText(workerResult.documentId)
    ?? getText(workerResult.document_id)
    ?? getText(workerResult.reportDocumentId)
    ?? getText(workerResult.report_document_id);
  if (!documentId) {
    return [];
  }
  const title = getText(workerResult.reportTitle)
    ?? getText(workerResult.documentTitle)
    ?? 'report document';
  return [`Document: ${mention('document', documentId, title)}`];
}

function truncateBlock(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 80)).trimEnd()}\n\n[Truncated. Open the linked task for the full result.]`;
}

function getRecordId(eventInput: DispatchPipelineEventInput): string | null {
  return getText(eventInput.payload.taskId)
    ?? getText(eventInput.payload.task_id)
    ?? getText(eventInput.payload.record_id)
    ?? eventInput.recordId
    ?? null;
}

function resolveHydratedChannelContext(input: JsonObject, fallbackChannelId: string): JsonObject {
  const flightDeckContext = objectValue(input.flightDeckContext);
  const channel = objectValue(flightDeckContext.channel);
  const contextPrompt = getText(channel.contextPrompt);
  const hasSpecificContext = Boolean(contextPrompt && contextPrompt !== 'No Specific Channel Context');
  return {
    channelId: getText(channel.id) ?? fallbackChannelId,
    scopeId: getText(channel.scopeId),
    name: getText(channel.name),
    contextPrompt: contextPrompt ?? 'No Specific Channel Context',
    hasSpecificContext,
  };
}

function getText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
    : [];
}

function compactSingleLine(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null;
  }
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) {
    return null;
  }
  return compacted.length > maxLength ? `${compacted.slice(0, Math.max(0, maxLength - 3))}...` : compacted;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeSessionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}
