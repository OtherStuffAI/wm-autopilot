import { createHash } from 'node:crypto';

import { finalizeEvent, nip19 } from 'nostr-tools';

import type {
  AgentChatDiagnostic,
  BackendConnectionRecord,
  HealthStatus,
  RuntimeBotIdentity as StoredRuntimeBotIdentity,
  YokeWorkspaceSession,
} from './types';
import { loadYokeBotHelpers } from './yoke-bot-helpers';

export interface TowerErrorDetails {
  status: number;
  message: string;
  detailCode: string | null;
  details?: unknown;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const AGENT_INSTRUCTION_SIGNATURE_PROTOCOL = 'flightdeck_pg_message_instruction';
const AGENT_INSTRUCTION_SIGNATURE_KIND = 33358;
const FLIGHT_DECK_DOCUMENT_CONTENT_FORMAT = 'document_content_v1';
const FLIGHT_DECK_DOCUMENT_CONTENT_MIME = 'application/vnd.wingman.flightdeck.document-content+json';

export interface BrokeredFlightDeckPgBotIdentity {
  botNpub: string;
  botPubkeyHex: string;
  signNip98: (input: { url: string; method: string; body?: unknown }) => Promise<string>;
  signNostrEvent: (event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<Record<string, unknown>>;
}

export type FlightDeckPgBotIdentity = StoredRuntimeBotIdentity | BrokeredFlightDeckPgBotIdentity;

// Keep the existing parameter spelling throughout this client while allowing
// the agent-facing CLI to use the capability broker instead of a raw key.
type RuntimeBotIdentity = FlightDeckPgBotIdentity;

export interface FlightDeckPgWorkspaceMeResult {
  identity?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  membership?: Record<string, unknown>;
  permissions?: string[];
  visible?: Record<string, unknown>;
}

export interface FlightDeckPgEvent {
  id?: string;
  event_id?: string;
  cursor?: string | null;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  thread_id?: string | null;
  actor_id?: string | null;
  actor_npub?: string | null;
  mentions?: unknown[];
  event_type?: string;
  entity_type?: string;
  entity_id?: string | null;
  operation?: string;
  entity_row_version?: number | null;
  row_version?: number;
  timestamp?: string;
  created_at?: string;
  payload?: Record<string, unknown>;
  refetch?: Record<string, unknown>;
  visible_to_agent_npubs?: string[];
  visible_to_audience_npubs?: string[];
}

export interface FlightDeckPgMessage {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  thread_id?: string | null;
  thread_source_message_id?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  mentions?: unknown[];
  attachments?: unknown[];
  row_version?: number | null;
  created_by_actor_id?: string | null;
  created_by_actor_npub?: string | null;
  sender_npub?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export type WorkroomParticipantRole = 'integration' | 'contributor' | 'reviewer' | 'approver' | 'observer';

export interface WorkroomParticipantMetadata {
  npub: string | null;
  role: WorkroomParticipantRole | null;
  metadataStatus: 'missing' | 'valid' | 'invalid' | null;
  capabilities: string[];
  localWorkspace: {
    repoPath: string | null;
    defaultBranch: string | null;
    canRunTests: boolean | null;
  };
  constraints: {
    canMergeIntegration: boolean | null;
    canMergeProduction: boolean | null;
    canRestartManagedApps: boolean | null;
  };
}

export interface FlightDeckPgWorkroomContext {
  isWorkroom: boolean;
  workroom: Record<string, unknown> | null;
  participant: WorkroomParticipantMetadata | null;
  appTargets: Record<string, unknown>[];
  recentEvents: Record<string, unknown>[];
  recentLinks: Record<string, unknown>[];
  openApprovals: Record<string, unknown>[];
}

export interface FlightDeckPgChannel {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  name?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  kind?: string | null;
  participant_npubs?: string[] | null;
  row_version?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgTask {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  thread_id?: string | null;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  priority?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgDailyScopeItem {
  id?: string | null;
  text: string;
  completed?: boolean;
  source?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgDailyNote {
  id: string;
  workspace_id?: string;
  owner_actor_id?: string | null;
  owner_actor_npub?: string | null;
  note_date?: string | null;
  title?: string | null;
  body?: string | null;
  focus?: string | null;
  items?: FlightDeckPgDailyScopeItem[];
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  updated_by_actor_id?: string | null;
  updated_by_actor_npub?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgTaskComment {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  task_id?: string | null;
  thread_id?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgDailyNotesResult {
  identity?: Record<string, unknown>;
  daily_notes: FlightDeckPgDailyNote[];
  next_cursor?: string | null;
}

export interface FlightDeckPgDocument {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  storage_object_id?: string | null;
  title?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  body?: Record<string, unknown> | null;
}

export interface FlightDeckPgDocumentComment {
  id: string;
  workspace_id?: string;
  scope_id?: string | null;
  channel_id?: string | null;
  doc_id?: string | null;
  parent_comment_id?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  row_version?: number | null;
  created_by_actor_id?: string | null;
  created_by_actor_npub?: string | null;
  sender_npub?: string | null;
  updated_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FlightDeckPgWorkspaceMember {
  actor?: {
    id?: string | null;
    actor_id?: string | null;
    npub?: string | null;
    kind?: string | null;
    display_name?: string | null;
  };
  membership?: Record<string, unknown> | null;
}

export interface FlightDeckPgEditLease {
  id: string;
  entity_type?: string;
  entity_id?: string;
  field_path?: string | null;
  lease_token?: string;
  holder_actor_npub?: string | null;
  expires_at?: string | null;
}

export interface FlightDeckPgMessagesResult {
  identity?: Record<string, unknown>;
  channel_id?: string;
  thread_id?: string | null;
  messages: FlightDeckPgMessage[];
  next_cursor: string | null;
}

export interface FlightDeckPgScopeChannelsResult {
  identity?: Record<string, unknown>;
  scope_id?: string;
  channels: FlightDeckPgChannel[];
  next_cursor: string | null;
}

export interface FlightDeckPgStoragePrepareResult {
  identity?: Record<string, unknown>;
  object_id: string;
  file_name?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  upload_url?: string | null;
  complete_url?: string | null;
  content_url?: string | null;
  download_url?: string | null;
  completed_at?: string | null;
}

function buildFlightDeckPgDocumentFileName(title: string | null | undefined, fallback: string): string {
  const safeTitle = String(title || fallback || 'document')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document';
  const safeFallback = String(fallback || 'record').trim().slice(0, 36) || 'record';
  return `${safeTitle}-${safeFallback}.document.json`;
}

function buildFlightDeckPgDocumentContentBytes(body: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    format: FLIGHT_DECK_DOCUMENT_CONTENT_FORMAT,
    content_model: {
      content: body,
      content_format: null,
      content_blocks: [],
    },
  }));
}

function decodeFlightDeckPgDocumentContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const model = parsed && typeof parsed.content_model === 'object' && parsed.content_model
      ? parsed.content_model as Record<string, unknown>
      : parsed;
    if (typeof model?.content === 'string') return model.content;
  } catch {
    // Older PG document helper uploads used raw Markdown. Keep those readable.
  }
  return raw;
}

export interface FlightDeckPgAudioNoteResult {
  identity?: Record<string, unknown>;
  audio_note?: Record<string, unknown>;
  storage_link?: Record<string, unknown> | null;
}

export interface FlightDeckPgWriteResult {
  identity?: Record<string, unknown>;
  message?: FlightDeckPgMessage;
  task?: FlightDeckPgTask;
  comment?: FlightDeckPgTaskComment;
  lease?: FlightDeckPgEditLease;
  reaction?: Record<string, unknown>;
  response_activity?: Record<string, unknown>;
  event?: FlightDeckPgEvent;
  [key: string]: unknown;
}

export interface FlightDeckPgTaskCommentsResult {
  identity?: Record<string, unknown>;
  task_id?: string;
  comments: FlightDeckPgTaskComment[];
  next_cursor: string | null;
}

export interface FlightDeckPgDocumentResult {
  identity?: Record<string, unknown>;
  doc?: FlightDeckPgDocument;
  storage_link?: Record<string, unknown> | null;
  body?: {
    object_id?: string;
    content_type?: string | null;
    size_bytes?: number | null;
    sha256_hex?: string | null;
    encoding?: string | null;
    base64_data?: string | null;
  };
}

export interface FlightDeckPgChannelDocsResult {
  identity?: Record<string, unknown>;
  channel_id?: string;
  docs: FlightDeckPgDocument[];
  next_cursor: string | null;
}

export interface FlightDeckPgDocumentCommentsResult {
  identity?: Record<string, unknown>;
  doc_id?: string;
  comments: FlightDeckPgDocumentComment[];
  next_cursor: string | null;
}

export interface FlightDeckPgEventsResult {
  identity?: Record<string, unknown>;
  events: FlightDeckPgEvent[];
  next_cursor: string | null;
  cursor_semantics?: Record<string, unknown>;
  subscription_audience_npubs?: string[];
  rejected_audience_npubs?: string[];
}

export interface FlightDeckPgEventSubscriptionRejection {
  npub: string;
  code: string;
}

export interface FlightDeckPgEventSubscriptionAgentsResult {
  identity?: Record<string, unknown>;
  agent_npubs: string[];
  audience_npubs?: string[];
  rejected_audience?: FlightDeckPgEventSubscriptionRejection[];
  agents?: Record<string, unknown>[];
}

export function normaliseBackendBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const parsed = URL.parse(trimmed);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('backend_base_url must be an http or https URL');
  }
  return trimmed.replace(/\/+$/, '');
}

export function buildChatMessageFamilyHash(sourceAppNpub: string): string {
  return `${sourceAppNpub}:chat_message`;
}

export function buildRecordFamilyHash(appNpub: string, collectionSpace: string): string {
  return `${appNpub}:${collectionSpace}`;
}

export function stripNostrAuthPrefix(value: string): string {
  return value.replace(/^Nostr\s+/i, '').trim();
}

export function encodeFlightDeckPgEventCursor(rowVersion: number): string {
  return Buffer.from(JSON.stringify({ version: 1, rowVersion }), 'utf8').toString('base64url');
}

export function decodeFlightDeckPgEventCursor(cursor: string | null | undefined): { version: number; rowVersion: number } | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      version?: unknown;
      rowVersion?: unknown;
    };
    const version = Number(parsed.version);
    const rowVersion = Number(parsed.rowVersion);
    if (!Number.isInteger(version) || version !== 1 || !Number.isInteger(rowVersion) || rowVersion < 0) {
      return null;
    }
    return { version, rowVersion };
  } catch {
    return null;
  }
}

function buildFlightDeckPgUrl(
  backendBaseUrl: string,
  path: string,
  params: Record<string, string | number | null | undefined> = {},
): string {
  const url = new URL(path, backendBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && String(value).trim().length > 0) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function signFlightDeckPgBotRequest(params: {
  botIdentity: RuntimeBotIdentity;
  url: string;
  method: string;
  body?: unknown;
}): Promise<string> {
  if ('signNip98' in params.botIdentity) {
    return await params.botIdentity.signNip98({
      url: params.url,
      method: params.method,
      body: params.body,
    });
  }
  const helpers = await loadYokeBotHelpers();
  return helpers.signBotRequest({
    botSecret: params.botIdentity.botSecret,
    botNpub: params.botIdentity.botNpub,
    url: params.url,
    method: params.method,
    body: params.body ?? null,
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildFlightDeckPgMessageInstructionSignature(params: {
  botIdentity: StoredRuntimeBotIdentity;
  body: string;
  workspaceId: string;
  channelId: string;
  threadId?: string | null;
}): Record<string, unknown> {
  const bodySha256 = sha256Hex(params.body);
  const tags = [
    ['protocol', AGENT_INSTRUCTION_SIGNATURE_PROTOCOL],
    ['body_sha256', bodySha256],
    ['workspace_id', params.workspaceId],
    ['channel_id', params.channelId],
  ];
  if (params.threadId) {
    tags.push(['thread_id', params.threadId]);
  }
  const event = finalizeEvent({
    kind: AGENT_INSTRUCTION_SIGNATURE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: params.body,
  }, params.botIdentity.botSecret);
  return {
    version: 1,
    protocol: AGENT_INSTRUCTION_SIGNATURE_PROTOCOL,
    kind: AGENT_INSTRUCTION_SIGNATURE_KIND,
    signer_npub: nip19.npubEncode(event.pubkey),
    body_sha256: bodySha256,
    nostr_event: event,
  };
}

async function buildFlightDeckPgMessageInstructionSignatureForIdentity(params: {
  botIdentity: RuntimeBotIdentity;
  body: string;
  workspaceId: string;
  channelId: string;
  threadId?: string | null;
}): Promise<Record<string, unknown>> {
  if (!('signNostrEvent' in params.botIdentity)) {
    return buildFlightDeckPgMessageInstructionSignature({
      ...params,
      botIdentity: params.botIdentity,
    });
  }
  const bodySha256 = sha256Hex(params.body);
  const tags = [
    ['protocol', AGENT_INSTRUCTION_SIGNATURE_PROTOCOL],
    ['body_sha256', bodySha256],
    ['workspace_id', params.workspaceId],
    ['channel_id', params.channelId],
  ];
  if (params.threadId) tags.push(['thread_id', params.threadId]);
  const event = await params.botIdentity.signNostrEvent({
    kind: AGENT_INSTRUCTION_SIGNATURE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: params.body,
  });
  return {
    version: 1,
    protocol: AGENT_INSTRUCTION_SIGNATURE_PROTOCOL,
    kind: AGENT_INSTRUCTION_SIGNATURE_KIND,
    signer_npub: params.botIdentity.botNpub,
    body_sha256: bodySha256,
    nostr_event: event,
  };
}

export async function parseTowerError(response: Response, stage: string): Promise<TowerErrorDetails> {
  const bodyText = await response.text().catch(() => '');
  let message = bodyText || response.statusText || stage;
  let details: unknown;
  try {
    const parsed = JSON.parse(bodyText) as { error?: string; code?: string; details?: unknown };
    if (typeof parsed?.error === 'string' && parsed.error.trim().length > 0) {
      message = parsed.error.trim();
    }
    details = parsed?.details;
    if (typeof parsed?.code === 'string' && parsed.code.trim()) {
      return {
        status: response.status,
        message,
        detailCode: parsed.code.trim(),
        ...(details !== undefined ? { details } : {}),
      };
    }
  } catch {
    // Non-JSON response.
  }
  return {
    status: response.status,
    message,
    detailCode: inferDetailCode(stage, response.status, message),
    ...(details !== undefined ? { details } : {}),
  };
}

export async function buildStreamUrl(
  backendBaseUrl: string,
  workspaceNpub: string,
  wsSession: YokeWorkspaceSession,
  lastEventId?: string | null,
): Promise<string> {
  const helpers = await loadYokeBotHelpers();
  const streamUrl = new URL(`/api/v4/workspaces/${encodeURIComponent(workspaceNpub)}/stream`, backendBaseUrl);
  if (lastEventId) {
    streamUrl.searchParams.set('last_event_id', lastEventId);
  }
  const signedUrl = streamUrl.toString();
  const signed = helpers.signWorkspaceRequest({
    wsSession,
    url: signedUrl,
    method: 'GET',
  });
  streamUrl.searchParams.set('token', stripNostrAuthPrefix(signed));
  return streamUrl.toString();
}

export async function fetchRecordHistory(
  backendBaseUrl: string,
  workspaceNpub: string,
  recordId: string,
  wsSession: YokeWorkspaceSession,
  options: { signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  const helpers = await loadYokeBotHelpers();
  const path = `/api/v4/records/${encodeURIComponent(recordId)}/history?owner_npub=${encodeURIComponent(workspaceNpub)}`;
  const url = new URL(path, backendBaseUrl).toString();
  const authorization = helpers.signWorkspaceRequest({ wsSession, url, method: 'GET' });
  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
    },
    signal: options.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'record_history');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { versions?: Record<string, unknown>[] };
  return Array.isArray(payload?.versions) ? payload.versions : [];
}

export async function fetchFlightDeckPgWorkspaceMe(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWorkspaceMeResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/me`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_workspace_me');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWorkspaceMeResult;
}

export async function reconcileFlightDeckPgEventSubscriptionAgents(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  agentNpubs: string[];
  signal?: AbortSignal;
}): Promise<FlightDeckPgEventSubscriptionAgentsResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/event-subscription-agents`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = JSON.stringify({ agent_npubs: [...new Set(params.agentNpubs)].sort() });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'PUT',
    body,
  });
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body,
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_event_subscription_agents');
    if (response.status === 404) {
      error.detailCode = 'flightdeck_pg_event_subscription_agents_contract_missing';
      error.message = 'Tower does not expose the managed-agent event subscription contract.';
    }
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgEventSubscriptionAgentsResult>;
  const acceptedAudience = payload.audience_npubs ?? payload.agent_npubs;
  if (!Array.isArray(acceptedAudience) || acceptedAudience.some((npub) => typeof npub !== 'string')) {
    throw Object.assign(new Error('Tower event subscription audience response omitted audience_npubs and agent_npubs.'), {
      detailCode: 'flightdeck_pg_event_subscription_agents_invalid',
    });
  }
  if (payload.rejected_audience !== undefined
    && (!Array.isArray(payload.rejected_audience)
      || payload.rejected_audience.some((item) => !item
        || typeof item !== 'object'
        || typeof item.npub !== 'string'
        || typeof item.code !== 'string'))) {
    throw Object.assign(new Error('Tower event subscription audience response included invalid rejected_audience diagnostics.'), {
      detailCode: 'flightdeck_pg_event_subscription_agents_invalid',
    });
  }
  const normalizedAudience = [...new Set(acceptedAudience)].sort();
  return {
    ...payload,
    agent_npubs: normalizedAudience,
    audience_npubs: normalizedAudience,
    rejected_audience: payload.rejected_audience ?? [],
  };
}

export async function fetchFlightDeckPgScopeChannels(params: {
  backendBaseUrl: string;
  workspaceId: string;
  scopeId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgScopeChannelsResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/scopes/${encodeURIComponent(params.scopeId)}/channels`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    limit: params.limit ?? 200,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_scope_channels');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgScopeChannelsResult>;
  return {
    ...payload,
    channels: Array.isArray(payload.channels) ? payload.channels : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function fetchFlightDeckPgEvents(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
  audienceNpubs?: string[];
}): Promise<FlightDeckPgEventsResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/events`;
  const url = new URL(buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    cursor: params.cursor ?? encodeFlightDeckPgEventCursor(0),
    limit: params.limit ?? 100,
  }));
  for (const npub of [...new Set(params.audienceNpubs ?? [])].sort()) {
    url.searchParams.append('audience_npub', npub);
  }
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url: url.toString(),
    method: 'GET',
  });
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_events');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgEventsResult>;
  return {
    ...payload,
    events: Array.isArray(payload.events) ? payload.events : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function connectFlightDeckPgEventStream(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
  audienceNpubs?: string[];
}): Promise<Response> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/events/stream`;
  const url = new URL(buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    cursor: params.cursor ?? encodeFlightDeckPgEventCursor(0),
    limit: params.limit ?? 100,
  }));
  for (const npub of [...new Set(params.audienceNpubs ?? [])].sort()) {
    url.searchParams.append('audience_npub', npub);
  }
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url: url.toString(),
    method: 'GET',
  });
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'text/event-stream',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok || !response.body) {
    const error = await parseTowerError(response, 'flightdeck_pg_events_stream');
    throw Object.assign(new Error(error.message), error);
  }
  return response;
}

export async function fetchFlightDeckPgChannelMessages(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  threadId?: string | null;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgMessagesResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/messages`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    thread_id: params.threadId ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? 200,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_channel_messages');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgMessagesResult>;
  return {
    ...payload,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function fetchFlightDeckPgChannel(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  signal?: AbortSignal;
}): Promise<FlightDeckPgChannel> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({ botIdentity: params.botIdentity, url, method: 'GET' });
  const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: authorization, 'x-flightdeck-pg-app-npub': params.appNpub }, signal: params.signal });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_channel');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { channel?: FlightDeckPgChannel } & FlightDeckPgChannel;
  return payload.channel ?? payload;
}

function normaliseWorkroomParticipant(value: unknown): WorkroomParticipantMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const participant = value as Record<string, unknown>;
  const localWorkspaceValue = participant.localWorkspace ?? participant.local_workspace;
  const localWorkspace = localWorkspaceValue && typeof localWorkspaceValue === 'object'
    ? localWorkspaceValue as Record<string, unknown>
    : {};
  const constraints = participant.constraints && typeof participant.constraints === 'object'
    ? participant.constraints as Record<string, unknown>
    : {};
  const role = participant.role;
  const metadataStatus = participant.metadataStatus ?? participant.metadata_status;
  const repoPath = localWorkspace.repoPath ?? localWorkspace.repo_path;
  const defaultBranch = localWorkspace.defaultBranch ?? localWorkspace.default_branch;
  const canRunTests = localWorkspace.canRunTests ?? localWorkspace.can_run_tests;
  const canMergeIntegration = constraints.canMergeIntegration ?? constraints.can_merge_integration;
  const canMergeProduction = constraints.canMergeProduction ?? constraints.can_merge_production;
  const canRestartManagedApps = constraints.canRestartManagedApps ?? constraints.can_restart_managed_apps;
  return {
    npub: typeof participant.npub === 'string' ? participant.npub : null,
    role: role === 'integration' || role === 'contributor' || role === 'reviewer' || role === 'approver' || role === 'observer'
      ? role
      : null,
    metadataStatus: metadataStatus === 'missing'
      || metadataStatus === 'valid'
      || metadataStatus === 'invalid'
      ? metadataStatus
      : null,
    capabilities: Array.isArray(participant.capabilities)
      ? participant.capabilities.filter((item): item is string => typeof item === 'string')
      : [],
    localWorkspace: {
      repoPath: typeof repoPath === 'string' ? repoPath : null,
      defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : null,
      canRunTests: typeof canRunTests === 'boolean' ? canRunTests : null,
    },
    constraints: {
      canMergeIntegration: typeof canMergeIntegration === 'boolean' ? canMergeIntegration : null,
      canMergeProduction: typeof canMergeProduction === 'boolean' ? canMergeProduction : null,
      canRestartManagedApps: typeof canRestartManagedApps === 'boolean' ? canRestartManagedApps : null,
    },
  };
}

function normaliseWorkroomContext(value: unknown): FlightDeckPgWorkroomContext {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const workroom = payload.workroom && typeof payload.workroom === 'object' && !Array.isArray(payload.workroom)
    ? payload.workroom as Record<string, unknown>
    : null;
  const records = (key: string): Record<string, unknown>[] => Array.isArray(payload[key])
    ? payload[key].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
  return {
    isWorkroom: payload.isWorkroom === true,
    workroom: workroom ?? (payload.room && typeof payload.room === 'object' && !Array.isArray(payload.room) ? payload.room as Record<string, unknown> : null),
    participant: normaliseWorkroomParticipant(payload.participant),
    appTargets: records('appTargets').concat(records('app_targets')),
    recentEvents: records('recentEvents').concat(records('recent_events')),
    recentLinks: records('recentLinks').concat(records('recent_links')),
    openApprovals: records('openApprovals').concat(records('open_approvals')),
  };
}

export async function fetchFlightDeckPgWorkroomContext(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  threadId: string;
  actorNpub?: string | null;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWorkroomContext> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/workroom-context`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    channel_id: params.channelId,
    thread_id: params.threadId,
    actor_npub: params.actorNpub ?? null,
  });
  const authorization = await signFlightDeckPgBotRequest({ botIdentity: params.botIdentity, url, method: 'GET' });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { isWorkroom: false, workroom: null, participant: null, appTargets: [], recentEvents: [], recentLinks: [], openApprovals: [] };
  }
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_workroom_context');
    throw Object.assign(new Error(error.message), error);
  }
  return normaliseWorkroomContext(await response.json());
}

export async function patchFlightDeckPgWorkroomParticipantMetadata(params: {
  backendBaseUrl: string;
  workspaceId: string;
  workroomId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  metadata: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/workrooms/${encodeURIComponent(params.workroomId)}/participant`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = { metadata: params.metadata };
  const authorization = await signFlightDeckPgBotRequest({ botIdentity: params.botIdentity, url, method: 'PATCH', body });
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_workroom_participant_patch');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json();
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

export async function createFlightDeckPgChannelMessage(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  body: string;
  threadId?: string | null;
  createThread?: boolean;
  metadata?: Record<string, unknown> | null;
  clientRequestId?: string | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/messages`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    body: params.body,
    message_signature: await buildFlightDeckPgMessageInstructionSignatureForIdentity({
      botIdentity: params.botIdentity,
      body: params.body,
      workspaceId: params.workspaceId,
      channelId: params.channelId,
      threadId: params.threadId,
    }),
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.createThread !== undefined ? { create_thread: params.createThread } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.clientRequestId ? { client_request_id: params.clientRequestId } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_channel_message_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function upsertFlightDeckPgResponseActivity(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  targetType: 'chat_thread' | 'task_comment' | 'doc_comment';
  targetId: string;
  status: 'queued' | 'thinking' | 'drafting' | 'publishing' | 'failed' | 'cleared';
  severity?: 'info' | 'warning' | 'error';
  label?: string | null;
  message?: string | null;
  activityType?: string | null;
  pipelineRunId?: string | null;
  sourceMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
  expiresInSeconds?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/response-activities`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    target_type: params.targetType,
    target_id: params.targetId,
    status: params.status,
    ...(params.severity ? { severity: params.severity } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.message ? { message: params.message } : {}),
    ...(params.activityType ? { activity_type: params.activityType } : {}),
    ...(params.pipelineRunId ? { pipeline_run_id: params.pipelineRunId } : {}),
    ...(params.sourceMessageId ? { source_message_id: params.sourceMessageId } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.expiresInSeconds ? { expires_in_seconds: params.expiresInSeconds } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_response_activity_upsert');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function upsertFlightDeckPgAgentActivity(params: {
  backendBaseUrl: string;
  workspaceId: string;
  activityId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
  triggerMessageId: string;
  turnId: string;
  sessionId: string;
  agentNpub: string;
  state: 'accepted' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  sequence: number;
  label?: string;
  summary?: string;
  body?: string;
  expiresInSeconds?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/agent-activities/${encodeURIComponent(params.activityId)}`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    channel_id: params.channelId,
    thread_id: params.threadId,
    trigger_message_id: params.triggerMessageId,
    turn_id: params.turnId,
    session_id: params.sessionId,
    agent_npub: params.agentNpub,
    state: params.state,
    visibility: 'user_visible',
    sequence: params.sequence,
    ...(params.label ? { label: params.label } : {}),
    ...(params.summary ? { summary: params.summary } : {}),
    ...(params.body ? { body: params.body } : {}),
    ...(params.expiresInSeconds ? { expires_in_seconds: params.expiresInSeconds } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({ botIdentity: params.botIdentity, url, method: 'PUT', body });
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Accept: 'application/json', Authorization: authorization, 'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_agent_activity_upsert');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function uploadFlightDeckPgStorageObject(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  fileName: string;
  contentType: string;
  content: Uint8Array;
  signal?: AbortSignal;
}): Promise<FlightDeckPgStoragePrepareResult> {
  const preparePath = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/storage/prepare`;
  const prepareUrl = buildFlightDeckPgUrl(params.backendBaseUrl, preparePath);
  const prepareBody = {
    file_name: params.fileName,
    content_type: params.contentType,
    size_bytes: params.content.byteLength,
  };
  const prepareAuthorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url: prepareUrl,
    method: 'POST',
    body: prepareBody,
  });
  const prepareResponse = await fetch(prepareUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: prepareAuthorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(prepareBody),
    signal: params.signal,
  });
  if (!prepareResponse.ok) {
    const error = await parseTowerError(prepareResponse, 'flightdeck_pg_storage_prepare');
    throw Object.assign(new Error(error.message), error);
  }
  const prepared = await prepareResponse.json() as FlightDeckPgStoragePrepareResult;
  if (!prepared.object_id) {
    throw new Error('Flight Deck PG storage prepare did not return object_id');
  }

  const uploadPath = `/api/v4/storage/${encodeURIComponent(prepared.object_id)}`;
  const uploadUrl = buildFlightDeckPgUrl(params.backendBaseUrl, uploadPath);
  const uploadBody = { base64_data: Buffer.from(params.content).toString('base64') };
  const uploadAuthorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url: uploadUrl,
    method: 'PUT',
    body: uploadBody,
  });
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: uploadAuthorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(uploadBody),
    signal: params.signal,
  });
  if (!uploadResponse.ok) {
    const error = await parseTowerError(uploadResponse, 'flightdeck_pg_storage_upload');
    throw Object.assign(new Error(error.message), error);
  }

  const completePath = `/api/v4/storage/${encodeURIComponent(prepared.object_id)}/complete`;
  const completeUrl = buildFlightDeckPgUrl(params.backendBaseUrl, completePath);
  const completeBody = {
    size_bytes: params.content.byteLength,
    sha256_hex: createHash('sha256').update(params.content).digest('hex'),
  };
  const completeAuthorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url: completeUrl,
    method: 'POST',
    body: completeBody,
  });
  const completeResponse = await fetch(completeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: completeAuthorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(completeBody),
    signal: params.signal,
  });
  if (!completeResponse.ok) {
    const error = await parseTowerError(completeResponse, 'flightdeck_pg_storage_complete');
    throw Object.assign(new Error(error.message), error);
  }
  const completed = await completeResponse.json() as Record<string, unknown>;
  return {
    ...prepared,
    ...completed,
    object_id: prepared.object_id,
  } as FlightDeckPgStoragePrepareResult;
}

export async function createFlightDeckPgChannelDocument(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  title: string;
  body: string;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgDocumentResult> {
  const content = buildFlightDeckPgDocumentContentBytes(params.body);
  const uploaded = await uploadFlightDeckPgStorageObject({
    backendBaseUrl: params.backendBaseUrl,
    workspaceId: params.workspaceId,
    appNpub: params.appNpub,
    botIdentity: params.botIdentity,
    fileName: buildFlightDeckPgDocumentFileName(params.title, params.channelId),
    contentType: FLIGHT_DECK_DOCUMENT_CONTENT_MIME,
    content,
    signal: params.signal,
  });
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/docs`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const requestBody = {
    title: params.title,
    storage_object_id: uploaded.object_id,
    ...(params.summary !== undefined ? { summary: params.summary } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body: requestBody,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(requestBody),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_doc_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgDocumentResult;
}

export async function listFlightDeckPgChannelDocs(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgChannelDocsResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/docs`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    limit: params.limit ?? 100,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_channel_docs');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgChannelDocsResult;
}

export async function fetchFlightDeckPgDocument(params: {
  backendBaseUrl: string;
  workspaceId: string;
  documentId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  includeBody?: boolean;
  signal?: AbortSignal;
}): Promise<FlightDeckPgDocumentResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/docs/${encodeURIComponent(params.documentId)}${params.includeBody ? '/body' : ''}`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, params.includeBody ? 'flightdeck_pg_doc_body' : 'flightdeck_pg_doc');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgDocumentResult;
}

export async function updateFlightDeckPgDocument(params: {
  backendBaseUrl: string;
  workspaceId: string;
  documentId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  title?: string | null;
  body?: string | null;
  rowVersion: number;
  leaseToken: string;
  metadata?: Record<string, unknown> | null;
  summary?: string | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgDocumentResult> {
  let storageObjectId: string | null = null;
  if (params.body !== undefined && params.body !== null) {
    const content = buildFlightDeckPgDocumentContentBytes(params.body);
    const uploaded = await uploadFlightDeckPgStorageObject({
      backendBaseUrl: params.backendBaseUrl,
      workspaceId: params.workspaceId,
      appNpub: params.appNpub,
      botIdentity: params.botIdentity,
      fileName: buildFlightDeckPgDocumentFileName(params.title, params.documentId),
      contentType: FLIGHT_DECK_DOCUMENT_CONTENT_MIME,
      content,
      signal: params.signal,
    });
    storageObjectId = uploaded.object_id;
  }
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/docs/${encodeURIComponent(params.documentId)}`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const requestBody = {
    row_version: params.rowVersion,
    lease_token: params.leaseToken,
    ...(params.title ? { title: params.title } : {}),
    ...(storageObjectId ? { storage_object_id: storageObjectId } : {}),
    ...(params.summary !== undefined ? { summary: params.summary } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'PATCH',
    body: requestBody,
  });
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(requestBody),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_doc_update');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgDocumentResult;
}

export function decodeFlightDeckPgDocumentBody(result: FlightDeckPgDocumentResult): string | null {
  const body = result.body;
  if (!body || body.encoding !== 'base64' || typeof body.base64_data !== 'string') return null;
  return decodeFlightDeckPgDocumentContent(Buffer.from(body.base64_data, 'base64').toString('utf8'));
}

export async function fetchFlightDeckPgDocumentComments(params: {
  backendBaseUrl: string;
  workspaceId: string;
  documentId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgDocumentCommentsResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/docs/${encodeURIComponent(params.documentId)}/comments`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    limit: params.limit ?? 200,
    cursor: params.cursor ?? undefined,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_doc_comments');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgDocumentCommentsResult>;
  return {
    ...payload,
    comments: Array.isArray(payload.comments) ? payload.comments : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function createFlightDeckPgDocumentComment(params: {
  backendBaseUrl: string;
  workspaceId: string;
  documentId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  body: string;
  parentCommentId?: string | null;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/docs/${encodeURIComponent(params.documentId)}/comments`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const requestBody = {
    body: params.body,
    ...(params.parentCommentId ? { parent_comment_id: params.parentCommentId } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body: requestBody,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(requestBody),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_doc_comment_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function createFlightDeckPgAudioNote(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  storageObjectId: string;
  mimeType: string;
  title?: string | null;
  targetType?: 'message' | 'task_comment' | 'task' | 'doc' | 'file' | 'audio_note' | null;
  targetId?: string | null;
  threadId?: string | null;
  durationSeconds?: number | null;
  sizeBytes?: number | null;
  transcriptPreview?: string | null;
  transcriptText?: string | null;
  transcriptStatus?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgAudioNoteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/audio-notes`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    storage_object_id: params.storageObjectId,
    mime_type: params.mimeType,
    ...(params.title ? { title: params.title } : {}),
    ...(params.targetType && params.targetId ? { target_type: params.targetType, target_id: params.targetId } : {}),
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.durationSeconds !== undefined ? { duration_seconds: params.durationSeconds } : {}),
    ...(params.sizeBytes !== undefined ? { size_bytes: params.sizeBytes } : {}),
    ...(params.transcriptPreview ? { transcript_preview: params.transcriptPreview } : {}),
    ...(params.transcriptText ? { transcript_text: params.transcriptText } : {}),
    ...(params.transcriptStatus ? { transcript_status: params.transcriptStatus } : {}),
    ...(params.summary ? { summary: params.summary } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_audio_note_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgAudioNoteResult;
}

export async function createFlightDeckPgReaction(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  targetType: string;
  targetId: string;
  emoji: string;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/reactions`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    target_type: params.targetType,
    target_id: params.targetId,
    emoji: params.emoji,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_reaction_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function fetchFlightDeckPgTask(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

function dailyScopeError(error: TowerErrorDetails): Error & TowerErrorDetails {
  const permissionDenied = error.status === 403 || error.detailCode === 'permission_denied';
  const message = permissionDenied
    ? 'Daily Scope access is not enabled for this agent. The human must enable Daily Scope access for this agent in My Agents settings.'
    : error.message;
  return Object.assign(new Error(message), {
    ...error,
    detailCode: permissionDenied ? 'daily_scope_forbidden' : error.detailCode,
  });
}

export async function fetchFlightDeckPgDailyScope(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  ownerActorId?: string | null;
  ownerNpub?: string | null;
  noteDate?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgDailyNotesResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/daily-notes`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    owner_actor_id: params.ownerActorId,
    owner_npub: params.ownerNpub,
    note_date: params.noteDate,
    limit: params.limit ?? 5,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_daily_scope_get');
    throw dailyScopeError(error);
  }
  return await response.json() as FlightDeckPgDailyNotesResult;
}

export async function upsertFlightDeckPgDailyScope(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  ownerActorId?: string | null;
  ownerNpub?: string | null;
  noteDate: string;
  title?: string | null;
  body?: string | null;
  focus?: string | null;
  items?: FlightDeckPgDailyScopeItem[];
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/daily-notes`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    note_date: params.noteDate,
    title: params.title ?? 'Daily Scope',
    body: params.body ?? '',
    focus: params.focus ?? '',
    items: Array.isArray(params.items) ? params.items.slice(0, 5) : [],
    status: 'active',
    ...(params.ownerActorId ? { owner_actor_id: params.ownerActorId } : {}),
    ...(params.ownerNpub ? { owner_npub: params.ownerNpub } : {}),
    metadata: {
      source: 'agent',
      autopilot_daily_scope_helper: true,
      ...(params.metadata ?? {}),
    },
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_daily_scope_upsert');
    throw dailyScopeError(error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function createFlightDeckPgChannelTask(params: {
  backendBaseUrl: string;
  workspaceId: string;
  channelId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  title: string;
  description?: string | null;
  state?: string;
  priority?: string;
  threadId?: string | null;
  metadata?: Record<string, unknown> | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/channels/${encodeURIComponent(params.channelId)}/tasks`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    title: params.title,
    ...(params.description !== undefined ? { description: params.description } : {}),
    state: params.state ?? 'new',
    priority: params.priority ?? 'sand',
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function createFlightDeckPgTaskComment(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  body: string;
  threadId?: string | null;
  metadata?: Record<string, unknown> | null;
  clientRequestId?: string | null;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}/comments`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    body: params.body,
    ...(params.clientRequestId ? { client_request_id: params.clientRequestId } : {}),
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_comment_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function fetchFlightDeckPgTaskComments(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgTaskCommentsResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}/comments`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path, {
    limit: params.limit ?? 200,
  });
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_comments');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as Partial<FlightDeckPgTaskCommentsResult>;
  return {
    ...payload,
    comments: Array.isArray(payload.comments) ? payload.comments : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function acquireFlightDeckPgEditLease(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  entityType: 'task' | 'document';
  entityId: string;
  ttlSeconds?: number;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/edit-leases/acquire`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    entity_type: params.entityType,
    entity_id: params.entityId,
    ttl_seconds: params.ttlSeconds ?? 120,
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_edit_lease_acquire');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function updateFlightDeckPgTaskState(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  state: string;
  rowVersion: number;
  leaseToken: string;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}/state`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = {
    state: params.state,
    row_version: params.rowVersion,
    lease_token: params.leaseToken,
  };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_state_update');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function fetchFlightDeckPgWorkspaceMembers(params: {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  signal?: AbortSignal;
}): Promise<{ identity?: Record<string, unknown>; members: FlightDeckPgWorkspaceMember[]; next_cursor?: string | null }> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/members`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'GET',
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_workspace_members');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { identity?: Record<string, unknown>; members?: FlightDeckPgWorkspaceMember[]; next_cursor?: string | null };
  return {
    ...payload,
    members: Array.isArray(payload.members) ? payload.members : [],
    next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

export async function assignFlightDeckPgTask(params: {
  backendBaseUrl: string;
  workspaceId: string;
  taskId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  actorId: string;
  signal?: AbortSignal;
}): Promise<FlightDeckPgWriteResult> {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(params.workspaceId)}/tasks/${encodeURIComponent(params.taskId)}/assignments`;
  const url = buildFlightDeckPgUrl(params.backendBaseUrl, path);
  const body = { actor_id: params.actorId };
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: params.botIdentity,
    url,
    method: 'POST',
    body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Type': 'application/json',
      'x-flightdeck-pg-app-npub': params.appNpub,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'flightdeck_pg_task_assignment_create');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as FlightDeckPgWriteResult;
}

export async function fetchGroupsForViewer(
  backendBaseUrl: string,
  viewerNpub: string,
  wsSession: YokeWorkspaceSession,
): Promise<Record<string, unknown>[]> {
  const helpers = await loadYokeBotHelpers();
  const path = `/api/v4/groups?npub=${encodeURIComponent(viewerNpub)}`;
  const url = new URL(path, backendBaseUrl).toString();
  const authorization = helpers.signWorkspaceRequest({ wsSession, url, method: 'GET' });
  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
    },
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'group_list');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { groups?: Record<string, unknown>[] };
  return Array.isArray(payload?.groups) ? payload.groups : [];
}

export interface WorkspaceKeyMapping {
  workspace_owner_npub: string;
  ws_key_npub: string;
  user_npub: string;
  workspace_service_npub?: string;
  workspace_user_key_npub?: string;
}

export async function fetchWorkspaceKeyMappings(
  backendBaseUrl: string,
  workspaceNpub: string,
  wsSession: YokeWorkspaceSession,
): Promise<WorkspaceKeyMapping[]> {
  const helpers = await loadYokeBotHelpers();
  const path = `/api/v4/user/workspace-key-mappings?workspace_service_npub=${encodeURIComponent(workspaceNpub)}`;
  const url = new URL(path, backendBaseUrl).toString();
  const authorization = helpers.signWorkspaceRequest({ wsSession, url, method: 'GET' });
  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
    },
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'workspace_key_mappings');
    throw Object.assign(new Error(error.message), error);
  }
  const payload = await response.json() as { mappings?: WorkspaceKeyMapping[] };
  return Array.isArray(payload?.mappings) ? payload.mappings : [];
}

export async function registerWorkspaceKeyWithTower(params: {
  backendBaseUrl: string;
  workspaceNpub: string;
  workspaceOwnerNpub?: string | null;
  wsKeyNpub: string;
  authorization: string;
}): Promise<Record<string, unknown>> {
  const url = new URL('/api/v4/user/workspace-keys', params.backendBaseUrl).toString();
  const body = {
    workspace_owner_npub: params.workspaceNpub,
    workspace_service_npub: params.workspaceNpub,
    human_workspace_owner_npub: params.workspaceOwnerNpub ?? null,
    ws_key_npub: params.wsKeyNpub,
    workspace_user_key_npub: params.wsKeyNpub,
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: params.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await parseTowerError(response, 'workspace_key_register');
    throw Object.assign(new Error(error.message), error);
  }
  return await response.json() as Record<string, unknown>;
}

export async function checkBackendConnectionHealth(
  record: BackendConnectionRecord,
  fetchImpl: FetchLike = fetch,
): Promise<{ healthStatus: HealthStatus; diagnostic: AgentChatDiagnostic }> {
  const targetUrl = record.healthUrl?.trim() || null;
  if (!targetUrl) {
    return {
      healthStatus: 'degraded',
      diagnostic: buildFailureDiagnostic(
        'backend_health_unavailable',
        'Backend connection has no health URL.',
        'backend_health_url_missing',
        {
          backend_connection_id: record.backendConnectionId,
          backend_base_url: record.backendBaseUrl,
        },
      ),
    };
  }

  const startedAt = Date.now();
  try {
    const response = await fetchImpl(targetUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const elapsedMs = Date.now() - startedAt;
    const details: Record<string, unknown> = {
      backend_connection_id: record.backendConnectionId,
      backend_base_url: record.backendBaseUrl,
      health_url: targetUrl,
      status: response.status,
      elapsed_ms: elapsedMs,
    };
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      details.response = await response.json().catch(() => null);
    }

    if (!response.ok) {
      return {
        healthStatus: 'unhealthy',
        diagnostic: buildFailureDiagnostic(
          'backend_health_failed',
          response.statusText || `Backend health check failed with HTTP ${response.status}.`,
          'backend_health_http_error',
          details,
        ),
      };
    }

    return {
      healthStatus: 'healthy',
      diagnostic: buildSuccessDiagnostic('Backend health check passed.', details),
    };
  } catch (error) {
    return {
      healthStatus: 'unhealthy',
      diagnostic: buildFailureDiagnostic(
        'backend_health_failed',
        error instanceof Error ? error.message : 'Backend health check failed.',
        'backend_health_request_failed',
        {
          backend_connection_id: record.backendConnectionId,
          backend_base_url: record.backendBaseUrl,
          health_url: targetUrl,
        },
      ),
    };
  }
}

export function buildFailureDiagnostic(
  code: string,
  message: string,
  detailCode: string | null,
  details?: Record<string, unknown> | null,
): AgentChatDiagnostic {
  return {
    ok: false,
    code,
    message,
    at: new Date().toISOString(),
    details: {
      ...(details ?? {}),
      detailCode,
    },
  };
}

export function buildSuccessDiagnostic(
  message: string,
  details?: Record<string, unknown> | null,
): AgentChatDiagnostic {
  return {
    ok: true,
    code: null,
    message,
    at: new Date().toISOString(),
    details: details ?? null,
  };
}

function inferDetailCode(stage: string, status: number, message: string): string | null {
  const lowered = message.toLowerCase();
  if (stage === 'workspace_key_register') {
    if (status === 403) return 'workspace_access_denied';
    if (lowered.includes('conflict')) return 'workspace_key_invalid';
  }
  if (stage === 'group_key_fetch') {
    if (status === 403) return 'group_membership_revoked';
    if (lowered.includes('epoch')) return 'group_key_epoch_stale';
    if (lowered.includes('missing wrapped group keys')) return 'group_key_missing';
  }
  if (stage === 'stream_connect') {
    if (status === 403) return 'sse_stream_forbidden';
    if (status === 401) return 'workspace_key_invalid';
  }
  if (stage === 'record_history') {
    if (status === 403) return 'group_membership_revoked';
    if (status === 404) return 'record_pull_not_found';
    if (lowered.includes('epoch')) return 'group_key_epoch_stale';
  }
  if (lowered.includes('workspace key revoked')) return 'workspace_key_revoked';
  if (lowered.includes('workspace key invalid')) return 'workspace_key_invalid';
  if (lowered.includes('epoch')) return 'group_key_epoch_stale';
  if (lowered.includes('group key')) return 'group_key_missing';
  return null;
}
