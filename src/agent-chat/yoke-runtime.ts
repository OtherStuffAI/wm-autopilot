import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

import type { RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';

function resolveYokePath(envName: string, fallbackRelativePath: string): string {
  const override = Bun.env[envName]?.trim();
  return override || new URL(fallbackRelativePath, import.meta.url).pathname;
}

const YOKE_CLI_PATH = resolveYokePath('AGENT_CHAT_YOKE_CLI_PATH', '../../../wingman-yoke/src/cli.js');
const YOKE_STATE_ROOT = new URL('../../data/agent-chat-yoke', import.meta.url).pathname;
const YOKE_CONFIG_FILE = 'config.json';
const FLIGHTDECK_CLI_DB_FILE = 'flightdeck-cli.db';
const YOKE_DB_FILE = 'yoke.db';
const YOKE_RUNTIME_STATE_FILE = 'runtime-state.json';
const DEFAULT_LAZY_SYNC_MIN_INTERVAL_MS = 5_000;

export interface AgentChatYokeMessage {
  message_id: string;
  parent_message_id: string | null;
  sender_npub: string | null;
  body: string;
  attachments: unknown[];
  updated_at: string;
}

export interface AgentChatYokeContext {
  channel_id: string;
  thread_id: string;
  participants: string[];
  recent_messages: AgentChatYokeMessage[];
}

export interface AgentChatYokeReplyResult {
  channel_id: string;
  thread_id: string;
  message_id: string;
  status: string;
}

export interface AgentChatYokeRuntime {
  stateDir: string;
  commandPrefix: string;
  context: AgentChatYokeContext | null;
  contextError: string | null;
}

export interface AgentWorkspaceYokeRuntime {
  stateDir: string;
  commandPrefix: string;
  didSync: boolean;
}

interface CachedChatContextState {
  channelId: string;
  threadId: string;
  fetchedAt: string | null;
  context: AgentChatYokeContext | null;
}

interface YokeRuntimeState {
  token: string | null;
  lastSyncedAt: string | null;
  cachedChatContext: CachedChatContextState | null;
}

interface PrepareYokeRuntimeOptions {
  syncMode?: 'eager' | 'lazy';
  minSyncIntervalMs?: number;
}

export interface RunYokeCommandInput {
  args: string[];
  workingDirectory: string;
  stateDir: string;
  botIdentity: RuntimeBotIdentity;
}

function encodeSecretHex(secret: Uint8Array): string {
  return Buffer.from(secret).toString('hex');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveNodeBinary(): string {
  return Bun.which('node') ?? process.execPath;
}

function buildConnectionToken(subscription: WorkspaceSubscriptionRecord): string {
  return Buffer.from(JSON.stringify({
    // Deprecated, PG-unsupported discriminator retained for the external Yoke token decoder.
    // It does not enable the removed Autopilot HTTP routes or MCP tools.
    type: 'superbased_connection',
    direct_https_url: subscription.backendBaseUrl,
    workspace_owner_npub: subscription.workspaceOwnerNpub,
    app_npub: subscription.sourceAppNpub,
  })).toString('base64');
}

function getYokeConfigPath(stateDir: string): string {
  return join(stateDir, YOKE_CONFIG_FILE);
}

function getYokeRuntimeStatePath(stateDir: string): string {
  return join(stateDir, YOKE_RUNTIME_STATE_FILE);
}

function getYokeDbPath(stateDir: string): string {
  const preferredPath = join(stateDir, FLIGHTDECK_CLI_DB_FILE);
  if (existsSync(preferredPath)) {
    return preferredPath;
  }
  return join(stateDir, YOKE_DB_FILE);
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseWorkspaceKeyBlob(subscription: WorkspaceSubscriptionRecord): Record<string, unknown> | null {
  if (!subscription.wsKeyBlobJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(subscription.wsKeyBlobJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function reconcileCachedWorkspaceKey(stateDir: string, subscription: WorkspaceSubscriptionRecord): boolean {
  const blob = parseWorkspaceKeyBlob(subscription);
  const workspaceOwnerNpub = typeof blob?.workspace_owner_npub === 'string'
    ? blob.workspace_owner_npub
    : subscription.workspaceOwnerNpub;
  const wsKeyNpub = typeof blob?.ws_key_npub === 'string'
    ? blob.ws_key_npub
    : subscription.wsKeyNpub;
  if (!blob || !workspaceOwnerNpub || !wsKeyNpub) {
    return false;
  }

  const dbPath = getYokeDbPath(stateDir);
  if (!existsSync(dbPath)) {
    return false;
  }
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_keys (
        workspace_owner_npub TEXT PRIMARY KEY,
        user_npub TEXT NOT NULL,
        ws_key_npub TEXT NOT NULL,
        ws_key_epoch INTEGER NOT NULL DEFAULT 1,
        encrypted_blob TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_key_mappings (
        ws_key_npub TEXT PRIMARY KEY,
        user_npub TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
    `);
    const current = db
      .query('SELECT ws_key_npub, encrypted_blob FROM workspace_keys WHERE workspace_owner_npub = ?')
      .get(workspaceOwnerNpub) as { ws_key_npub?: string; encrypted_blob?: string } | null;
    const encryptedBlob = JSON.stringify(blob);
    if (current?.ws_key_npub === wsKeyNpub && current.encrypted_blob === encryptedBlob) {
      return false;
    }
    const now = new Date().toISOString();
    db.query(`
      INSERT INTO workspace_keys (workspace_owner_npub, user_npub, ws_key_npub, ws_key_epoch, encrypted_blob, cached_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_owner_npub) DO UPDATE SET
        user_npub = excluded.user_npub,
        ws_key_npub = excluded.ws_key_npub,
        ws_key_epoch = excluded.ws_key_epoch,
        encrypted_blob = excluded.encrypted_blob,
        cached_at = excluded.cached_at
    `).run(
      workspaceOwnerNpub,
      subscription.botNpub,
      wsKeyNpub,
      typeof blob.ws_key_epoch === 'number' ? blob.ws_key_epoch : 1,
      encryptedBlob,
      now,
    );
    db.query(`
      INSERT INTO workspace_key_mappings (ws_key_npub, user_npub, cached_at)
      VALUES (?, ?, ?)
      ON CONFLICT(ws_key_npub) DO UPDATE SET
        user_npub = excluded.user_npub,
        cached_at = excluded.cached_at
    `).run(wsKeyNpub, subscription.botNpub, now);
    return true;
  } finally {
    db.close();
  }
}

function loadYokeRuntimeState(stateDir: string): YokeRuntimeState {
  const parsed = readJsonFile(getYokeRuntimeStatePath(stateDir));
  return {
    token: typeof parsed?.token === 'string' && parsed.token.trim().length > 0 ? parsed.token : null,
    lastSyncedAt:
      typeof parsed?.lastSyncedAt === 'string' && parsed.lastSyncedAt.trim().length > 0
        ? parsed.lastSyncedAt
        : null,
    cachedChatContext:
      parsed?.cachedChatContext && typeof parsed.cachedChatContext === 'object'
        ? {
            channelId:
              typeof (parsed.cachedChatContext as Record<string, unknown>).channelId === 'string'
                ? String((parsed.cachedChatContext as Record<string, unknown>).channelId)
                : '',
            threadId:
              typeof (parsed.cachedChatContext as Record<string, unknown>).threadId === 'string'
                ? String((parsed.cachedChatContext as Record<string, unknown>).threadId)
                : '',
            fetchedAt:
              typeof (parsed.cachedChatContext as Record<string, unknown>).fetchedAt === 'string'
                ? String((parsed.cachedChatContext as Record<string, unknown>).fetchedAt)
                : null,
            context:
              (parsed.cachedChatContext as Record<string, unknown>).context
              && typeof (parsed.cachedChatContext as Record<string, unknown>).context === 'object'
                ? ((parsed.cachedChatContext as Record<string, unknown>).context as AgentChatYokeContext)
                : null,
          }
        : null,
  };
}

async function saveYokeRuntimeState(stateDir: string, state: YokeRuntimeState): Promise<void> {
  await Bun.write(
    getYokeRuntimeStatePath(stateDir),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function hasMatchingYokeConfig(stateDir: string, token: string): boolean {
  const parsed = readJsonFile(getYokeConfigPath(stateDir));
  return typeof parsed?.token === 'string' && parsed.token === token;
}

function shouldRunLazySync(stateDir: string, token: string, minSyncIntervalMs: number): boolean {
  const runtimeState = loadYokeRuntimeState(stateDir);
  if (runtimeState.token !== token) {
    return true;
  }
  if (!runtimeState.lastSyncedAt) {
    return true;
  }
  const lastSyncedAt = Date.parse(runtimeState.lastSyncedAt);
  if (!Number.isFinite(lastSyncedAt)) {
    return true;
  }
  return Date.now() - lastSyncedAt >= minSyncIntervalMs;
}

export function shouldReuseCachedChatContext(params: {
  state: YokeRuntimeState;
  token: string;
  channelId: string;
  threadId: string;
  minSyncIntervalMs: number;
}): boolean {
  const cached = params.state.cachedChatContext;
  if (!cached) {
    return false;
  }
  if (params.state.token !== params.token) {
    return false;
  }
  if (cached.channelId !== params.channelId || cached.threadId !== params.threadId) {
    return false;
  }
  if (!cached.context) {
    return false;
  }
  if (!cached.fetchedAt) {
    return false;
  }
  const fetchedAt = Date.parse(cached.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return false;
  }
  return Date.now() - fetchedAt < params.minSyncIntervalMs;
}

export function appendReplyToCachedChatContext(params: {
  state: YokeRuntimeState;
  channelId: string;
  threadId: string;
  messageId: string;
  body: string;
  senderNpub: string;
  at?: string;
  maxMessages?: number;
}): YokeRuntimeState {
  const cached = params.state.cachedChatContext;
  if (
    !cached
    || cached.channelId !== params.channelId
    || cached.threadId !== params.threadId
    || !cached.context
  ) {
    return params.state;
  }

  const at = params.at ?? new Date().toISOString();
  const maxMessages = Math.max(1, params.maxMessages ?? 20);
  const participants = cached.context.participants.includes(params.senderNpub)
    ? cached.context.participants
    : [...cached.context.participants, params.senderNpub];
  const nextMessages = [
    ...cached.context.recent_messages,
    {
      message_id: params.messageId,
      parent_message_id: params.threadId,
      sender_npub: params.senderNpub,
      body: params.body,
      attachments: [],
      updated_at: at,
    },
  ].slice(-maxMessages);

  return {
    ...params.state,
    cachedChatContext: {
      channelId: cached.channelId,
      threadId: cached.threadId,
      fetchedAt: at,
      context: {
        channel_id: cached.context.channel_id,
        thread_id: cached.context.thread_id,
        participants,
        recent_messages: nextMessages,
      },
    },
  };
}

function parseContextPayload(stdout: string): AgentChatYokeContext {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  return {
    channel_id: String(parsed.channel_id ?? ''),
    thread_id: String(parsed.thread_id ?? ''),
    participants: Array.isArray(parsed.participants)
      ? parsed.participants.map((value) => String(value ?? '')).filter((value) => value.length > 0)
      : [],
    recent_messages: Array.isArray(parsed.recent_messages)
      ? parsed.recent_messages.map((entry) => {
          const value = entry as Record<string, unknown>;
          return {
            message_id: String(value.message_id ?? ''),
            parent_message_id: typeof value.parent_message_id === 'string' ? value.parent_message_id : null,
            sender_npub: typeof value.sender_npub === 'string' ? value.sender_npub : null,
            body: String(value.body ?? ''),
            attachments: Array.isArray(value.attachments) ? value.attachments : [],
            updated_at: String(value.updated_at ?? ''),
          };
        })
      : [],
  };
}

function parseReplyPayload(stdout: string): AgentChatYokeReplyResult {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  return {
    channel_id: String(parsed.channel_id ?? ''),
    thread_id: String(parsed.thread_id ?? ''),
    message_id: String(parsed.message_id ?? ''),
    status: String(parsed.status ?? ''),
  };
}

async function readSpawnedText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return await new Response(stream).text();
}

async function runYokeCommand(input: RunYokeCommandInput): Promise<string> {
  const proc = Bun.spawn([resolveNodeBinary(), YOKE_CLI_PATH, ...input.args], {
    cwd: input.workingDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...Bun.env,
      WINGMAN_YOKE_STATE_DIR: input.stateDir,
      WINGMAN_YOKE_NSEC: encodeSecretHex(input.botIdentity.botSecret),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readSpawnedText(proc.stdout),
    readSpawnedText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || 'Unknown error';
    throw new Error(`flightdeck-cli ${input.args.join(' ')} failed (${exitCode}): ${detail}`);
  }
  return stdout.trim();
}

export async function runAgentWorkspaceYokeCommand(input: RunYokeCommandInput): Promise<string> {
  return await runYokeCommand(input);
}

async function initialiseYokeState(
  workingDirectory: string,
  stateDir: string,
  subscription: WorkspaceSubscriptionRecord,
  botIdentity: RuntimeBotIdentity,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const token = buildConnectionToken(subscription);
  if (hasMatchingYokeConfig(stateDir, token)) {
    if (reconcileCachedWorkspaceKey(stateDir, subscription)) {
      const runtimeState = loadYokeRuntimeState(stateDir);
      await saveYokeRuntimeState(stateDir, {
        token,
        lastSyncedAt: runtimeState.lastSyncedAt,
        cachedChatContext: null,
      });
    }
    return;
  }
  await runYokeCommand({
    args: ['init', '--token', token],
    workingDirectory,
    stateDir,
    botIdentity,
  });
  reconcileCachedWorkspaceKey(stateDir, subscription);
  const runtimeState = loadYokeRuntimeState(stateDir);
  await saveYokeRuntimeState(stateDir, {
    token,
    lastSyncedAt: runtimeState.lastSyncedAt,
    cachedChatContext: null,
  });
}

async function syncYokeState(
  workingDirectory: string,
  stateDir: string,
  subscription: WorkspaceSubscriptionRecord,
  botIdentity: RuntimeBotIdentity,
): Promise<void> {
  await runYokeCommand({
    args: ['sync', '--json'],
    workingDirectory,
    stateDir,
    botIdentity,
  });
  await saveYokeRuntimeState(stateDir, {
    token: buildConnectionToken(subscription),
    lastSyncedAt: new Date().toISOString(),
    cachedChatContext: null,
  });
}

function buildCommandPrefix(stateDir: string): string {
  return `WINGMAN_YOKE_STATE_DIR=${shellQuote(stateDir)} ${shellQuote(resolveNodeBinary())} ${shellQuote(YOKE_CLI_PATH)}`;
}

export async function prepareAgentWorkspaceYokeRuntime(params: {
  sessionId: string;
  workingDirectory: string;
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  options?: PrepareYokeRuntimeOptions;
}): Promise<AgentWorkspaceYokeRuntime> {
  const stateDir = join(YOKE_STATE_ROOT, params.sessionId);
  await initialiseYokeState(
    params.workingDirectory,
    stateDir,
    params.subscription,
    params.botIdentity,
  );
  const syncMode = params.options?.syncMode ?? 'eager';
  const minSyncIntervalMs = Math.max(0, params.options?.minSyncIntervalMs ?? DEFAULT_LAZY_SYNC_MIN_INTERVAL_MS);
  let didSync = false;
  if (syncMode === 'eager' || shouldRunLazySync(stateDir, buildConnectionToken(params.subscription), minSyncIntervalMs)) {
    await syncYokeState(params.workingDirectory, stateDir, params.subscription, params.botIdentity);
    didSync = true;
  }
  return {
    stateDir,
    commandPrefix: buildCommandPrefix(stateDir),
    didSync,
  };
}

export function buildAgentChatYokeCommands(stateDir: string, channelId: string, threadId: string) {
  const prefix = buildCommandPrefix(stateDir);
  return {
    context: `${prefix} chat context --channel ${shellQuote(channelId)} --thread ${shellQuote(threadId)} --format json`,
    history: `${prefix} chat history --format json`,
    search: `${prefix} chat search --query ${shellQuote('<term>')} --format json`,
    related: `${prefix} chat related --format json`,
    replyCurrent: `${prefix} chat reply-current --body ${shellQuote('<reply>')} --format json`,
  };
}

export function buildAgentTaskCommentYokeCommands(stateDir: string, taskId: string, commentId: string) {
  const prefix = buildCommandPrefix(stateDir);
  return {
    sync: `${prefix} sync --json`,
    show: `${prefix} tasks show ${shellQuote(taskId)} --json`,
    reply: `${prefix} tasks reply ${shellQuote(commentId)} --body ${shellQuote('<reply>')} --json`,
  };
}

export function buildAgentDocumentCommentYokeCommands(stateDir: string, documentId: string, commentId: string) {
  const prefix = buildCommandPrefix(stateDir);
  return {
    sync: `${prefix} sync --json`,
    show: `${prefix} docs show ${shellQuote(documentId)} --json`,
    reply: `${prefix} docs reply ${shellQuote(commentId)} --body ${shellQuote('<reply>')} --json`,
  };
}

export async function prepareAgentChatYokeRuntime(params: {
  sessionId: string;
  workingDirectory: string;
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
  options?: PrepareYokeRuntimeOptions;
}): Promise<AgentChatYokeRuntime> {
  try {
    const minSyncIntervalMs = Math.max(0, params.options?.minSyncIntervalMs ?? DEFAULT_LAZY_SYNC_MIN_INTERVAL_MS);
    const token = buildConnectionToken(params.subscription);
    const workspace = await prepareAgentWorkspaceYokeRuntime({
      sessionId: params.sessionId,
      workingDirectory: params.workingDirectory,
      subscription: params.subscription,
      botIdentity: params.botIdentity,
      options: params.options,
    });
    const runtimeState = loadYokeRuntimeState(workspace.stateDir);
    if (
      params.options?.syncMode === 'lazy'
      && !workspace.didSync
      && shouldReuseCachedChatContext({
        state: runtimeState,
        token,
        channelId: params.channelId,
        threadId: params.threadId,
        minSyncIntervalMs,
      })
    ) {
      return {
        stateDir: workspace.stateDir,
        commandPrefix: workspace.commandPrefix,
        context: runtimeState.cachedChatContext?.context ?? null,
        contextError: null,
      };
    }
    const stdout = await runYokeCommand({
      args: [
        'chat',
        'context',
        '--channel',
        params.channelId,
        '--thread',
        params.threadId,
        '--format',
        'json',
      ],
      workingDirectory: params.workingDirectory,
      stateDir: workspace.stateDir,
      botIdentity: params.botIdentity,
    });
    const context = parseContextPayload(stdout);
    await saveYokeRuntimeState(workspace.stateDir, {
      ...runtimeState,
      token,
      cachedChatContext: {
        channelId: params.channelId,
        threadId: params.threadId,
        fetchedAt: new Date().toISOString(),
        context,
      },
    });
    return {
      stateDir: workspace.stateDir,
      commandPrefix: workspace.commandPrefix,
      context,
      contextError: null,
    };
  } catch (error) {
    const stateDir = join(YOKE_STATE_ROOT, params.sessionId);
    return {
      stateDir,
      commandPrefix: buildCommandPrefix(stateDir),
      context: null,
      contextError: error instanceof Error ? error.message : 'Failed to prepare chat context.',
    };
  }
}

export async function handoffAgentChatReply(params: {
  workingDirectory: string;
  stateDir: string;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
  body: string;
}): Promise<AgentChatYokeReplyResult> {
  const stdout = await runYokeCommand({
    args: [
      'chat',
      'reply-current',
      '--body',
      params.body,
      '--skip-refresh',
      '--channel',
      params.channelId,
      '--thread',
      params.threadId,
      '--format',
      'json',
    ],
    workingDirectory: params.workingDirectory,
    stateDir: params.stateDir,
    botIdentity: params.botIdentity,
  });
  const reply = parseReplyPayload(stdout);
  const runtimeState = loadYokeRuntimeState(params.stateDir);
  await saveYokeRuntimeState(
    params.stateDir,
    appendReplyToCachedChatContext({
      state: runtimeState,
      channelId: params.channelId,
      threadId: params.threadId,
      messageId: reply.message_id,
      body: params.body,
      senderNpub: params.botIdentity.botNpub,
    }),
  );
  return reply;
}
