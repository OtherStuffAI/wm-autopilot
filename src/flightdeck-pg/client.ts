import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, parse, relative, sep } from 'node:path';

import { getPublicKey, nip19 } from 'nostr-tools';

import type { RuntimeBotIdentity } from '../agent-chat/types';
import {
  acquireFlightDeckPgEditLease,
  assignFlightDeckPgTask,
  createFlightDeckPgAudioNote,
  createFlightDeckPgChannelDocument,
  createFlightDeckPgChannelMessage,
  createFlightDeckPgChannelTask,
  createFlightDeckPgDocumentComment,
  createFlightDeckPgReaction,
  createFlightDeckPgTaskComment,
  decodeFlightDeckPgDocumentBody,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgDocument,
  fetchFlightDeckPgDocumentComments,
  fetchFlightDeckPgEvents,
  fetchFlightDeckPgScopeChannels,
  fetchFlightDeckPgTask,
  fetchFlightDeckPgTaskComments,
  fetchFlightDeckPgWorkspaceMe,
  fetchFlightDeckPgWorkspaceMembers,
  normaliseBackendBaseUrl,
  updateFlightDeckPgDocument,
  updateFlightDeckPgTaskState,
  uploadFlightDeckPgStorageObject,
  signFlightDeckPgBotRequest,
  type FlightDeckPgBotIdentity,
  type FlightDeckPgDocumentComment,
  type FlightDeckPgDocumentResult,
} from '../agent-chat/tower-client';
import { callCapabilityBroker, type CapabilityClientContext } from '../mcp/capability-client';

export interface FlightDeckPgClientConfig {
  towerUrl: string;
  wingmanUrl: string;
  appNpub: string;
  botIdentity: FlightDeckPgBotIdentity;
  sessionId?: string | null;
  initialContext?: Record<string, unknown> | null;
  fetchImpl?: typeof fetch;
}

export interface FlightDeckPgDispatchContext {
  workspaceId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  taskId?: string | null;
  scopeId?: string | null;
  sourceAppNpub?: string | null;
  backendBaseUrl?: string | null;
  [key: string]: unknown;
}

export class MissingFlightDeckPgRouteError extends Error {
  readonly routeGap: Record<string, unknown>;

  constructor(routeGap: Record<string, unknown>) {
    super(`Missing Flight Deck PG route: ${String(routeGap.method)} ${String(routeGap.path)}`);
    this.routeGap = routeGap;
  }
}

export function createBotIdentityFromSecret(secretKey: Uint8Array): RuntimeBotIdentity {
  const botPubkeyHex = getPublicKey(secretKey);
  return {
    botSecret: secretKey,
    botPubkeyHex,
    botNpub: nip19.npubEncode(botPubkeyHex),
  };
}

export function createBotIdentityFromCapability(input: {
  wingmanUrl: string;
  sessionId: string;
  capabilityToken: string;
  botNpub: string;
  botPubkeyHex: string;
  fetchImpl?: typeof fetch;
}): FlightDeckPgBotIdentity {
  const currentContext = (): CapabilityClientContext => ({
    wingmanUrl: Bun.env.WINGMAN_BROKER_URL?.trim() || input.wingmanUrl,
    sessionId: input.sessionId,
    capabilityToken: Bun.env.WINGMAN_CAPABILITY?.trim() || input.capabilityToken,
    fetch: input.fetchImpl,
  });
  return {
    botNpub: input.botNpub,
    botPubkeyHex: input.botPubkeyHex,
    signNip98: async ({ url, method, body }) => {
      const bodyHash = body === undefined || body === null
        ? undefined
        : hashRequestBody(body);
      const result = await callCapabilityBroker<{ token: string; signedBy: string }>(
        '/api/mcp/capabilities/nip98',
        { url, method, bodyHash },
        currentContext(),
      );
      if (result.signedBy !== input.botNpub) {
        throw new Error('Capability broker identity does not match BOT_NPUB for this session.');
      }
      return result.token;
    },
    signNostrEvent: async (event) => {
      const result = await callCapabilityBroker<{ event: Record<string, unknown> }>(
        '/api/mcp/capabilities/nostr-event',
        { event },
        currentContext(),
      );
      if (result.event.pubkey !== input.botPubkeyHex) {
        throw new Error('Capability broker event identity does not match BOT_PUBKEY_HEX for this session.');
      }
      return result.event;
    },
  };
}

function hashRequestBody(body: unknown): string {
  const hash = createHash('sha256');
  if (typeof body === 'string') return hash.update(body).digest('hex');
  if (body instanceof Uint8Array) return hash.update(body).digest('hex');
  if (body instanceof ArrayBuffer) return hash.update(new Uint8Array(body)).digest('hex');
  if (ArrayBuffer.isView(body)) {
    return hash.update(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)).digest('hex');
  }
  return hash.update(JSON.stringify(body)).digest('hex');
}

export function resolveFlightDeckPgConfig(input: {
  towerUrl?: string | null;
  wingmanUrl?: string | null;
  appNpub?: string | null;
  secretKey?: Uint8Array | null;
  botCrypto?: boolean;
  sessionId?: string | null;
  initialContext?: Record<string, unknown> | null;
  fetchImpl?: typeof fetch;
}): FlightDeckPgClientConfig {
  const towerUrlRaw = (input.towerUrl || Bun.env.TOWER_URL || Bun.env.FLIGHTDECK_TOWER_URL || '').trim();
  if (!towerUrlRaw) {
    throw new Error('Missing Flight Deck PG Tower URL. Pass --tower-url or set TOWER_URL/FLIGHTDECK_TOWER_URL from the active Flight Deck PG dispatch context.');
  }
  const towerUrl = normaliseBackendBaseUrl(towerUrlRaw);
  const wingmanUrlRaw = (input.wingmanUrl || Bun.env.WINGMAN_URL || '').trim();
  const wingmanUrl = wingmanUrlRaw ? normaliseBackendBaseUrl(wingmanUrlRaw) : '';
  const appNpub = (input.appNpub || Bun.env.FLIGHTDECK_APP_NPUB || '').trim();
  if (!appNpub) {
    throw new Error('Missing Flight Deck app npub. Pass --app-npub or set FLIGHTDECK_APP_NPUB from the active Flight Deck PG dispatch context; do not use the bot npub.');
  }
  const sessionId = input.sessionId ?? Bun.env.SESSION_ID ?? null;
  const useBotCrypto = input.botCrypto === true;
  let botIdentity: FlightDeckPgBotIdentity;
  if (useBotCrypto) {
    const capabilityToken = (Bun.env.WINGMAN_CAPABILITY || '').trim();
    const botNpub = (Bun.env.BOT_NPUB || '').trim();
    const botPubkeyHex = (Bun.env.BOT_PUBKEY_HEX || '').trim();
    if (!wingmanUrl || !sessionId || !capabilityToken || !botNpub || !botPubkeyHex) {
      throw new Error('Flight Deck --bot-crypto requires WINGMAN_URL, SESSION_ID, WINGMAN_CAPABILITY, BOT_NPUB, and BOT_PUBKEY_HEX from an agent session.');
    }
    botIdentity = createBotIdentityFromCapability({
      wingmanUrl,
      sessionId,
      capabilityToken,
      botNpub,
      botPubkeyHex,
      fetchImpl: input.fetchImpl,
    });
  } else {
    if (!input.secretKey) {
      throw new Error('Missing operator signing key. Agent sessions use brokered Flight Deck auth automatically; operators may provide --key or WINGMAN_NSEC.');
    }
    botIdentity = createBotIdentityFromSecret(input.secretKey);
  }
  return {
    towerUrl,
    wingmanUrl,
    appNpub,
    botIdentity,
    sessionId,
    initialContext: input.initialContext,
    fetchImpl: input.fetchImpl,
  };
}

export class FlightDeckPgClient {
  private readonly config: FlightDeckPgClientConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FlightDeckPgClientConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async context(): Promise<Record<string, unknown>> {
    if (this.config.initialContext) return this.config.initialContext;
    if (!this.config.sessionId) {
      return {
        mode: 'flightdeck_pg',
        context_available: false,
        reason: 'SESSION_ID is not set; pass explicit --workspace/--channel/--thread/--task flags.',
        towerUrl: this.config.towerUrl,
        wingmanUrl: Bun.env.WINGMAN_BROKER_URL?.trim() || this.config.wingmanUrl,
        actor: {
          bot_npub: this.config.botIdentity.botNpub,
          bot_pubkey_hex: this.config.botIdentity.botPubkeyHex,
        },
      };
    }
    return await this.callWingmanHelper('context');
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      mode: 'flightdeck_pg',
      towerUrl: this.config.towerUrl,
      wingmanUrl: this.config.wingmanUrl,
      appNpub: this.config.appNpub,
      botNpub: this.config.botIdentity.botNpub,
      sessionId: this.config.sessionId ?? null,
    };
  }

  async listWorkspaces() {
    return await this.signedJson('GET', '/api/v4/flightdeck-pg/workspaces');
  }

  async listPersonalWapps(workspaceId: string, input: {
    ownerNpub?: string | null;
    includeArchived?: boolean;
    limit?: number;
  } = {}) {
    return await this.signedJson(
      'GET',
      `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/personal-wapps`,
      {
        owner_npub: input.ownerNpub,
        include_archived: input.includeArchived ? 'true' : undefined,
        limit: input.limit,
      },
    );
  }

  async createPersonalWapp(workspaceId: string, payload: Record<string, unknown>) {
    return await this.signedJson(
      'POST',
      `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/personal-wapps`,
      undefined,
      payload,
    );
  }

  async updatePersonalWapp(workspaceId: string, personalWappId: string, payload: Record<string, unknown>) {
    return await this.signedJson(
      'PATCH',
      `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/personal-wapps/${encodeURIComponent(personalWappId)}`,
      undefined,
      payload,
    );
  }

  async archivePersonalWapp(workspaceId: string, personalWappId: string) {
    return await this.signedJson(
      'DELETE',
      `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/personal-wapps/${encodeURIComponent(personalWappId)}`,
    );
  }

  async showWorkspace(workspaceId: string) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/descriptor`);
  }

  async workspaceMe(workspaceId: string) {
    return await fetchFlightDeckPgWorkspaceMe(this.base({ workspaceId }));
  }

  async listScopes(workspaceId: string) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/scopes`);
  }

  async showScope(workspaceId: string, scopeId: string) {
    const scopes = await this.listScopes(workspaceId) as { scopes?: Array<Record<string, unknown>> };
    const scope = scopes.scopes?.find((entry) => entry.id === scopeId);
    if (!scope) throw new MissingFlightDeckPgRouteError({
      method: 'GET',
      path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}',
      auth: 'NIP-98 actor must be a workspace member with scope.read or readable channel grants.',
      request: { path: { workspaceId, scopeId } },
      response: { identity: 'FlightDeckPgIdentity', scope: 'FlightDeckPgScope' },
      note: 'Tower currently exposes scope list but no single scope read endpoint; CLI filters list output when possible.',
    });
    return { scope };
  }

  async listChannels(workspaceId: string, scopeId: string, limit?: number) {
    return await fetchFlightDeckPgScopeChannels({ ...this.base({ workspaceId }), scopeId, limit });
  }

  async showChannel(workspaceId: string, channelId: string) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`);
  }

  async listThreads(workspaceId: string, channelId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/threads`, { limit });
  }

  async readThread(workspaceId: string, channelId: string, threadId?: string | null, limit?: number) {
    return await fetchFlightDeckPgChannelMessages({ ...this.base({ workspaceId }), channelId, threadId, limit });
  }

  async listChannelMessages(workspaceId: string, channelId: string, input: { cursor?: string | null; limit?: number } = {}) {
    return await fetchFlightDeckPgChannelMessages({
      ...this.base({ workspaceId }),
      channelId,
      cursor: input.cursor,
      limit: input.limit,
    });
  }

  async reply(workspaceId: string, channelId: string, threadId: string | null, body: string) {
    return await createFlightDeckPgChannelMessage({ ...this.base({ workspaceId }), channelId, threadId, body });
  }

  async listTasks(workspaceId: string, input: { channelId?: string | null; scopeId?: string | null; limit?: number }) {
    if (input.channelId) {
      return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(input.channelId)}/tasks`, { limit: input.limit });
    }
    if (input.scopeId) {
      return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/scopes/${encodeURIComponent(input.scopeId)}/tasks`, { limit: input.limit });
    }
    throw new MissingFlightDeckPgRouteError({
      method: 'GET',
      path: '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks',
      auth: 'NIP-98 actor must be a workspace member; response filters to task.read-visible channels.',
      request: { query: { limit: 'number?' } },
      response: { identity: 'FlightDeckPgIdentity', tasks: ['FlightDeckPgTask'], next_cursor: 'string|null' },
      note: 'Tower currently lists tasks by channel or scope only. Pass --channel or --scope until workspace task rollup exists.',
    });
  }

  async showTask(workspaceId: string, taskId: string) {
    return await fetchFlightDeckPgTask(this.base({ workspaceId, taskId }));
  }

  async createTask(workspaceId: string, channelId: string, input: { title: string; description?: string | null; state?: string; priority?: string; threadId?: string | null }) {
    return await createFlightDeckPgChannelTask({ ...this.base({ workspaceId }), channelId, ...input });
  }

  async patchTask(workspaceId: string, taskId: string, payload: Record<string, unknown>) {
    return await this.signedJson('PATCH', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`, undefined, payload);
  }

  async moveTask(workspaceId: string, taskId: string, destinationChannelId: string, destinationScopeId?: string | null) {
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/move`, undefined, {
      destination_channel_id: destinationChannelId,
      ...(destinationScopeId ? { destination_scope_id: destinationScopeId } : {}),
    });
  }

  async updateTaskState(workspaceId: string, taskId: string, state: string) {
    const taskResult = await this.showTask(workspaceId, taskId);
    const task = taskResult.task as { row_version?: number } | undefined;
    const rowVersion = Number(task?.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion < 1) throw new Error('Flight Deck PG task state update requires task.row_version from task show response.');
    const leaseResult = await acquireFlightDeckPgEditLease({ ...this.base({ workspaceId }), entityType: 'task', entityId: taskId });
    const leaseToken = String(leaseResult.lease?.lease_token || '');
    if (!leaseToken) throw new Error('Flight Deck PG edit lease acquire did not return lease_token.');
    return await updateFlightDeckPgTaskState({ ...this.base({ workspaceId, taskId }), state, rowVersion, leaseToken });
  }

  async listTaskComments(workspaceId: string, taskId: string, limit?: number) {
    return await fetchFlightDeckPgTaskComments({ ...this.base({ workspaceId, taskId }), limit });
  }

  async commentTask(workspaceId: string, taskId: string, body: string, threadId?: string | null) {
    return await createFlightDeckPgTaskComment({ ...this.base({ workspaceId, taskId }), body, threadId });
  }

  async assignTask(workspaceId: string, taskId: string, actorId: string) {
    return await assignFlightDeckPgTask({ ...this.base({ workspaceId, taskId }), actorId });
  }

  async listDocs(workspaceId: string, channelId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/docs`, { limit });
  }

  async createDoc(workspaceId: string, channelId: string, title: string, body: string) {
    return await createFlightDeckPgChannelDocument({ ...this.base({ workspaceId }), channelId, title, body });
  }

  async showDoc(
    workspaceId: string,
    documentId: string,
    includeBody: boolean,
  ): Promise<FlightDeckPgDocumentResult & { body_text?: string | null }> {
    const result = await fetchFlightDeckPgDocument({ ...this.base({ workspaceId }), documentId, includeBody });
    return includeBody ? { ...result, body_text: decodeFlightDeckPgDocumentBody(result) } : result;
  }

  async updateDoc(workspaceId: string, documentId: string, body: string) {
    const current = await fetchFlightDeckPgDocument({ ...this.base({ workspaceId }), documentId });
    const doc = current.doc as { row_version?: number; title?: string | null } | undefined;
    const rowVersion = Number(doc?.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion < 1) throw new Error('Flight Deck PG doc update requires doc.row_version from doc show response.');
    const leaseResult = await acquireFlightDeckPgEditLease({ ...this.base({ workspaceId }), entityType: 'document', entityId: documentId });
    const leaseToken = String(leaseResult.lease?.lease_token || '');
    if (!leaseToken) throw new Error('Flight Deck PG edit lease acquire did not return lease_token.');
    return await updateFlightDeckPgDocument({ ...this.base({ workspaceId }), documentId, title: doc?.title ?? undefined, body, rowVersion, leaseToken });
  }

  async moveDoc(workspaceId: string, documentId: string, destinationChannelId: string, destinationScopeId?: string | null) {
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(documentId)}/move`, undefined, {
      destination_channel_id: destinationChannelId,
      ...(destinationScopeId ? { destination_scope_id: destinationScopeId } : {}),
    });
  }

  async listDocComments(workspaceId: string, documentId: string, limit?: number) {
    return await fetchFlightDeckPgDocumentComments({ ...this.base({ workspaceId }), documentId, limit });
  }

  async replyDoc(workspaceId: string, documentId: string, body: string, parentCommentId?: string | null) {
    return await createFlightDeckPgDocumentComment({ ...this.base({ workspaceId }), documentId, body, parentCommentId });
  }

  async downloadDoc(workspaceId: string, documentRef: string, outPath: string, input: {
    includeComments?: boolean;
    downloadStorage?: boolean;
  } = {}) {
    const documentId = extractFlightDeckDocumentId(documentRef);
    if (!documentId) throw new Error(`Could not extract Flight Deck document id from ${documentRef}`);
    const result = await this.showDoc(workspaceId, documentId, true);
    const doc = objectValue(result.doc);
    const title = stringValue(doc.title) ?? documentId;
    let body = typeof result.body_text === 'string' ? result.body_text : '';
    const downloadedStorage: Array<Record<string, unknown>> = [];
    if (input.downloadStorage !== false) {
      const replaced = await this.downloadStorageReferences(workspaceId, body, outPath);
      body = replaced.body;
      downloadedStorage.push(...replaced.downloads);
    }
    const commentsResult = input.includeComments === false
      ? { comments: [] as FlightDeckPgDocumentComment[] }
      : await this.listDocComments(workspaceId, documentId, 500);
    const comments = commentsResult.comments.map((comment): Record<string, unknown> => ({ ...comment }));
    const markdown = buildDownloadedDocumentMarkdown({
      documentId,
      title,
      rowVersion: doc.row_version ?? doc.rowVersion ?? null,
      body,
      comments,
    });
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, markdown, 'utf8');
    return {
      ok: true,
      documentId,
      title,
      outPath,
      comments: comments.length,
      storageDownloads: downloadedStorage,
    };
  }

  async listFiles(workspaceId: string, channelId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/files`, { limit });
  }

  async uploadFile(workspaceId: string, channelId: string, path: string, contentType?: string | null) {
    const file = Bun.file(path);
    const content = new Uint8Array(await file.arrayBuffer());
    const uploaded = await uploadFlightDeckPgStorageObject({
      ...this.base({ workspaceId }),
      fileName: basename(path),
      contentType: contentType || file.type || 'application/octet-stream',
      content,
    });
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/files`, undefined, {
      storage_object_id: uploaded.object_id,
      display_name: basename(path),
    });
  }

  async showFile(workspaceId: string, fileId: string, includeObject = false) {
    const suffix = includeObject ? '/object' : '';
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}${suffix}`);
  }

  async createAudio(workspaceId: string, channelId: string, path: string, contentType?: string | null) {
    const file = Bun.file(path);
    const content = new Uint8Array(await file.arrayBuffer());
    const mimeType = contentType || file.type || 'application/octet-stream';
    const uploaded = await uploadFlightDeckPgStorageObject({
      ...this.base({ workspaceId }),
      fileName: basename(path),
      contentType: mimeType,
      content,
    });
    return await createFlightDeckPgAudioNote({
      ...this.base({ workspaceId }),
      channelId,
      storageObjectId: uploaded.object_id,
      mimeType,
      title: basename(path),
      sizeBytes: content.byteLength,
    });
  }

  async createReaction(workspaceId: string, target: string, emoji: string) {
    const [targetType, targetId] = target.includes(':') ? target.split(':', 2) : ['', target];
    if (!targetType || !targetId) throw new Error('--target must use <target-type>:<target-id>, for example message:<id>');
    return await createFlightDeckPgReaction({ ...this.base({ workspaceId }), targetType, targetId, emoji: normalizeEmoji(emoji) });
  }

  async pollEvents(workspaceId: string, cursor?: string | null, limit?: number) {
    return await fetchFlightDeckPgEvents({ ...this.base({ workspaceId }), cursor, limit });
  }

  async listMembers(workspaceId: string) {
    return await fetchFlightDeckPgWorkspaceMembers(this.base({ workspaceId }));
  }

  async listWorkrooms(workspaceId: string, input: { scopeId?: string | null; channelId?: string | null; status?: string | null; limit?: number } = {}) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms`, {
      scope_id: input.scopeId,
      channel_id: input.channelId,
      status: input.status,
      limit: input.limit,
    });
  }

  async searchWorkrooms(workspaceId: string, input: { query?: string | null; scopeId?: string | null; channelId?: string | null; limit?: number } = {}) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/search`, {
      q: input.query,
      scope_id: input.scopeId,
      channel_id: input.channelId,
      limit: input.limit,
    });
  }

  async showWorkroom(workspaceId: string, workroomId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(workroomId)}`, { limit });
  }

  async listWorkroomEvents(workspaceId: string, workroomId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(workroomId)}/events`, { limit });
  }

  async appendWorkroomEvent(workspaceId: string, workroomId: string, input: {
    eventType: string;
    title?: string | null;
    body?: string | null;
    targetType?: string | null;
    targetRef?: string | null;
    visibility?: string | null;
    payload?: Record<string, unknown> | null;
  }) {
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(workroomId)}/events`, undefined, {
      event_type: input.eventType,
      ...(input.title ? { title: input.title } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.targetType ? { target_type: input.targetType } : {}),
      ...(input.targetRef ? { target_ref: input.targetRef } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    });
  }

  async listWorkroomLinks(workspaceId: string, workroomId: string, limit?: number) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(workroomId)}/links`, { limit });
  }

  async appendWorkroomLink(workspaceId: string, workroomId: string, input: {
    linkType: string;
    targetType: string;
    targetId?: string | null;
    externalUrl?: string | null;
    label?: string | null;
    status?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(workroomId)}/links`, undefined, {
      link_type: input.linkType,
      target_type: input.targetType,
      ...(input.targetId ? { target_id: input.targetId } : {}),
      ...(input.externalUrl ? { external_url: input.externalUrl } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  async listApprovals(workspaceId: string, input: { targetType?: string | null; targetId?: string | null; action?: string | null; status?: string | null; limit?: number } = {}) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/approvals`, {
      target_type: input.targetType,
      target_id: input.targetId,
      action: input.action,
      status: input.status,
      limit: input.limit,
    });
  }

  async showApproval(workspaceId: string, approvalId: string) {
    return await this.signedJson('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/approvals/${encodeURIComponent(approvalId)}`);
  }

  async requestProductionMergeApproval(workspaceId: string, workroomId: string, input: {
    repo?: string | null;
    fromBranch?: string | null;
    toBranch: string;
    commit: string;
    previewUrl?: string | null;
    validationEvidence?: string[];
    title?: string | null;
    summary?: string | null;
    reviewerNpub?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.fromBranch ? { from_branch: input.fromBranch } : {}),
      to_branch: input.toBranch,
      commit: input.commit,
      ...(input.previewUrl ? { preview_url: input.previewUrl } : {}),
      ...(input.validationEvidence?.length ? { validation_evidence: input.validationEvidence } : {}),
    };
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(workroomId)}/approvals`, undefined, {
      action: 'production_merge',
      ...(input.title ? { title: input.title } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.reviewerNpub ? { reviewer_npub: input.reviewerNpub } : {}),
      metadata,
    });
  }

  async checkProductionMergeApproval(workspaceId: string, workroomId: string, input: { repo?: string | null; toBranch: string; commit: string }) {
    return await this.signedJson('POST', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/workrooms/${encodeURIComponent(workroomId)}/production-merge/check`, undefined, {
      ...(input.repo ? { repo: input.repo } : {}),
      to_branch: input.toBranch,
      commit: input.commit,
    });
  }

  private base(extra: { workspaceId: string; taskId?: string }) {
    return {
      backendBaseUrl: this.config.towerUrl,
      workspaceId: extra.workspaceId,
      taskId: extra.taskId ?? '',
      appNpub: this.config.appNpub,
      botIdentity: this.config.botIdentity,
    };
  }

  private async callWingmanHelper(action: string, params: Record<string, unknown> = {}) {
    if (!this.config.wingmanUrl) {
      throw new Error('Missing Wingman URL for Flight Deck PG dispatch context. Pass --url or set WINGMAN_URL.');
    }
    if (!this.config.sessionId || !('signNip98' in this.config.botIdentity)) {
      throw new Error('Flight Deck dispatch context requires a brokered agent session capability.');
    }
    return await callCapabilityBroker<Record<string, unknown>>(
      '/api/mcp/wingman/flightdeck',
      { action, ...params },
      {
        wingmanUrl: this.config.wingmanUrl,
        sessionId: this.config.sessionId,
        capabilityToken: Bun.env.WINGMAN_CAPABILITY?.trim() ?? '',
        fetch: this.fetchImpl,
      },
    );
  }

  private async signedJson(method: string, path: string, query?: Record<string, string | number | null | undefined>, body?: unknown) {
    const url = new URL(path, this.config.towerUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && String(value).trim()) url.searchParams.set(key, String(value));
    }
    const authorization = await signFlightDeckPgBotRequest({
      botIdentity: this.config.botIdentity,
      url: url.toString(),
      method,
      body,
    });
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'x-flightdeck-pg-app-npub': this.config.appNpub,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await readJsonResponse(response, `${method} ${path}`);
  }

  private async downloadStorageReferences(workspaceId: string, body: string, outPath: string): Promise<{
    body: string;
    downloads: Array<Record<string, unknown>>;
  }> {
    const matches = Array.from(body.matchAll(/storage:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi));
    const uniqueIds = [...new Set(matches
      .map((match) => match[1])
      .filter((objectId): objectId is string => Boolean(objectId)))];
    if (uniqueIds.length === 0) return { body, downloads: [] };
    const out = parse(outPath);
    const assetsDir = `${out.dir ? `${out.dir}/` : ''}${out.name}.assets`;
    await mkdir(assetsDir, { recursive: true });
    const replacements = new Map<string, string>();
    const downloads: Array<Record<string, unknown>> = [];
    for (const objectId of uniqueIds) {
      const downloaded = await this.downloadStorageObject(workspaceId, objectId);
      const fileName = `${objectId}${extensionForContentType(downloaded.contentType)}`;
      const assetPath = `${assetsDir}/${fileName}`;
      await writeFile(assetPath, downloaded.bytes);
      const relativePath = relative(dirname(outPath), assetPath).split(sep).join('/');
      replacements.set(objectId, relativePath);
      downloads.push({
        objectId,
        path: assetPath,
        relativePath,
        contentType: downloaded.contentType,
        sizeBytes: downloaded.bytes.byteLength,
      });
    }
    return {
      body: body.replace(/storage:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi, (_match, objectId: string) => replacements.get(objectId) ?? _match),
      downloads,
    };
  }

  private async downloadStorageObject(workspaceId: string, objectId: string): Promise<{
    bytes: Uint8Array;
    contentType: string;
  }> {
    let response: Response;
    try {
      response = await this.signedRaw('GET', `/api/v4/storage/${encodeURIComponent(objectId)}`, undefined, undefined, workspaceId);
    } catch (error) {
      try {
        return await this.downloadStorageObjectContent(workspaceId, objectId);
      } catch {
        throw error;
      }
    }
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    if (contentType.includes('application/json')) {
      const payload = await response.json() as Record<string, unknown>;
      const base64 = stringValue(payload.base64_data)
        ?? stringValue(objectValue(payload.body).base64_data)
        ?? stringValue(objectValue(payload.object).base64_data);
      const downloadUrl = stringValue(payload.download_url)
        ?? stringValue(payload.downloadUrl)
        ?? stringValue(objectValue(payload.object).download_url);
      const contentUrl = stringValue(payload.content_url)
        ?? stringValue(payload.contentUrl)
        ?? stringValue(objectValue(payload.object).content_url);
      if (base64) {
        return {
          bytes: new Uint8Array(Buffer.from(base64, 'base64')),
          contentType: stringValue(payload.content_type)
            ?? stringValue(payload.contentType)
            ?? stringValue(objectValue(payload.body).content_type)
            ?? 'application/octet-stream',
        };
      }
      if (downloadUrl) {
        const downloaded = await this.fetchImpl(downloadUrl);
        if (!downloaded.ok) throw new Error(`Storage download URL failed (${downloaded.status}): ${downloaded.statusText}`);
        return {
          bytes: new Uint8Array(await downloaded.arrayBuffer()),
          contentType: downloaded.headers.get('content-type') ?? 'application/octet-stream',
        };
      }
      if (contentUrl) {
        return await this.downloadStorageObjectContent(workspaceId, objectId);
      }
      throw new Error(`Storage object ${objectId} JSON response did not include base64_data, download_url, or content_url.`);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType,
    };
  }

  private async downloadStorageObjectContent(workspaceId: string, objectId: string): Promise<{
    bytes: Uint8Array;
    contentType: string;
  }> {
    const response = await this.signedRaw('GET', `/api/v4/storage/${encodeURIComponent(objectId)}/content`, undefined, undefined, workspaceId);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  private async signedRaw(method: string, path: string, query?: Record<string, string | number | null | undefined>, body?: unknown, workspaceId?: string) {
    const url = new URL(path, this.config.towerUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && String(value).trim()) url.searchParams.set(key, String(value));
    }
    const authorization = await signFlightDeckPgBotRequest({
      botIdentity: this.config.botIdentity,
      url: url.toString(),
      method,
      body,
    });
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Accept: '*/*',
        Authorization: authorization,
        'x-flightdeck-pg-app-npub': this.config.appNpub,
        ...(workspaceId ? { 'x-flightdeck-pg-workspace-id': workspaceId } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${method} ${path} failed (${response.status}): ${text || response.statusText}`);
    }
    return response;
  }
}

function extractFlightDeckDocumentId(reference: string): string | null {
  const trimmed = reference.trim();
  const mention = trimmed.match(/mention:(?:document|doc):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (mention?.[1]) return mention[1];
  const scheme = trimmed.match(/flightdeck-(?:document|doc):\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (scheme?.[1]) return scheme[1];
  const path = trimmed.match(/\/docs?\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\b|[/?#])/i);
  if (path?.[1]) return path[1];
  const bare = trimmed.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return bare?.[0] ?? null;
}

function buildDownloadedDocumentMarkdown(input: {
  documentId: string;
  title: string;
  rowVersion: unknown;
  body: string;
  comments: Record<string, unknown>[];
}): string {
  const lines = input.body.split('\n');
  const inline = new Map<number, Record<string, unknown>[]>();
  const trailing: Record<string, unknown>[] = [];
  for (const comment of input.comments) {
    const line = resolveCommentLine(comment);
    if (line && line >= 1 && line <= lines.length) {
      const existing = inline.get(line) ?? [];
      existing.push(comment);
      inline.set(line, existing);
    } else {
      trailing.push(comment);
    }
  }
  const output: string[] = [
    '<!--',
    'Local snapshot of Flight Deck document.',
    `Document ID: ${input.documentId}`,
    `Title: ${input.title}`,
    `Row version: ${input.rowVersion ?? ''}`,
    '-->',
    '',
  ];
  for (let index = 0; index < lines.length; index += 1) {
    output.push(lines[index] ?? '');
    for (const comment of inline.get(index + 1) ?? []) {
      output.push('', formatDownloadedComment(comment), '');
    }
  }
  if (trailing.length > 0) {
    output.push('', '---', '', '## Flight Deck Comments', '');
    for (const comment of trailing) {
      output.push(formatDownloadedComment(comment), '');
    }
  }
  return output.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

function resolveCommentLine(comment: Record<string, unknown>): number | null {
  const metadata = objectValue(comment.metadata);
  const anchor = objectValue(metadata.anchor ?? comment.anchor);
  const range = objectValue(anchor.range ?? metadata.range ?? comment.range);
  const candidates = [
    comment.line,
    comment.line_number,
    metadata.line,
    metadata.lineNumber,
    metadata.line_number,
    anchor.line,
    anchor.lineNumber,
    anchor.line_number,
    range.startLine,
    range.start_line,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function formatDownloadedComment(comment: Record<string, unknown>): string {
  const id = stringValue(comment.id) ?? '';
  const author = stringValue(comment.created_by_actor_npub)
    ?? stringValue(comment.sender_npub)
    ?? stringValue(comment.updated_by_actor_npub)
    ?? '';
  const createdAt = stringValue(comment.created_at) ?? '';
  const body = (stringValue(comment.body) ?? '').replace(/<\/comment>/gi, '<\\/comment>');
  const attrs = [
    id ? `id="${escapeXmlAttr(id)}"` : '',
    author ? `author="${escapeXmlAttr(author)}"` : '',
    createdAt ? `created_at="${escapeXmlAttr(createdAt)}"` : '',
  ].filter(Boolean).join(' ');
  return `<comment${attrs ? ` ${attrs}` : ''}>\n${body}\n</comment>`;
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const fromType: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
  };
  return fromType[normalized] ?? '';
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: unknown = {};
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : response.statusText;
    throw new Error(`${label} failed (${response.status}): ${error}`);
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
}

function normalizeEmoji(emoji: string): string {
  const map: Record<string, string> = {
    '+1': 'thumbs_up',
    ':thumbs_up:': 'thumbs_up',
    thumbs_up: 'thumbs_up',
    smile: 'smile',
    heart: 'heart',
    eyes: 'eyes',
    party: 'party',
    white_check_mark: 'white_check_mark',
  };
  return map[emoji] ?? emoji;
}
