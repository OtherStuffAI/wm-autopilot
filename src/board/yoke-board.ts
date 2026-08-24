import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import { collectWappScopeGroupRefs } from '../wapps/scope-access';

const YOKE_CLI_PATH = compactText(Bun.env.AGENT_CHAT_YOKE_CLI_PATH)
  || compactText(Bun.env.FLIGHTDECK_CLI_PATH)
  || new URL('../../../wingman-yoke/src/cli.js', import.meta.url).pathname;
const DEFAULT_CONFIG_RELATIVE_PATH = join('.wingmen', 'board.json');

export interface RepoBoardConfig {
  backendBaseUrl: string;
  workspaceOwnerNpub: string;
  sourceAppNpub: string;
  stateDir?: string | null;
}

export interface RepoBoardConfigWithPaths extends RepoBoardConfig {
  repoRoot: string;
  configPath: string;
  stateDir: string;
}

export interface BoardTaskRecord {
  taskId: string;
  title: string;
  description: string;
  state: string | null;
  assignedTo: string | null;
  parentTaskId: string | null;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: number | null;
  predecessorTaskIds: string[];
  scopeId: string | null;
  scopeLineage: Array<string | null>;
  references: Array<{ type: string; id: string }>;
  tags: string[];
}

export interface BoardTaskCreateInput {
  title: string;
  description?: string | null;
  state?: string | null;
  assignedTo?: string | null;
  parentTaskId?: string | null;
  predecessorTaskIds?: string[];
  scopeId?: string | null;
  tags?: string[];
}

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compactStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => compactText(entry)).filter(Boolean)
    : [];
}

function compactStringArrayMaybeJson(value: unknown): string[] {
  if (Array.isArray(value)) {
    return compactStringArray(value);
  }
  const text = compactText(value);
  if (!text) {
    return [];
  }
  if (text.startsWith('[')) {
    try {
      return compactStringArray(JSON.parse(text));
    } catch {
      return [];
    }
  }
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function compactReferenceArrayMaybeJson(value: unknown): Array<{ type: string; id: string }> {
  const parsed = (() => {
    if (Array.isArray(value)) {
      return value;
    }
    const text = compactText(value);
    if (!text.startsWith('[')) {
      return [];
    }
    try {
      const decoded = JSON.parse(text);
      return Array.isArray(decoded) ? decoded : [];
    } catch {
      return [];
    }
  })();
  const seen = new Set<string>();
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const type = compactText((entry as Record<string, unknown>).type);
    const id = compactText((entry as Record<string, unknown>).id);
    if (!type || !id) {
      return [];
    }
    const key = `${type}:${id}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ type, id }];
  });
}

function normaliseStateDir(repoRoot: string, config: RepoBoardConfig): string {
  const configured = compactText(config.stateDir);
  return configured
    ? resolve(repoRoot, configured)
    : join(repoRoot, '.wingmen', 'board-state');
}

function parseJsonOutput<T>(output: string): T {
  return JSON.parse(output) as T;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveNodeBinary(): string {
  return Bun.which('node') ?? process.execPath;
}

export function resolveBoardConfigPath(startDir = process.cwd()): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, DEFAULT_CONFIG_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function loadRepoBoardConfig(startDir = process.cwd()): RepoBoardConfigWithPaths {
  const configPath = resolveBoardConfigPath(startDir);
  if (!configPath) {
    throw new Error('Board config not found. Run `bun clis/wingman.ts init ...` in the repo first.');
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RepoBoardConfig;
  const repoRoot = dirname(dirname(configPath));
  return {
    backendBaseUrl: compactText(raw.backendBaseUrl),
    workspaceOwnerNpub: compactText(raw.workspaceOwnerNpub),
    sourceAppNpub: compactText(raw.sourceAppNpub),
    stateDir: normaliseStateDir(repoRoot, raw),
    repoRoot,
    configPath,
  };
}

export function saveRepoBoardConfig(repoRoot: string, input: RepoBoardConfig): RepoBoardConfigWithPaths {
  const configPath = join(repoRoot, DEFAULT_CONFIG_RELATIVE_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  const next = {
    backendBaseUrl: compactText(input.backendBaseUrl),
    workspaceOwnerNpub: compactText(input.workspaceOwnerNpub),
    sourceAppNpub: compactText(input.sourceAppNpub),
    stateDir: compactText(input.stateDir),
  };
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  return {
    ...next,
    repoRoot,
    configPath,
    stateDir: normaliseStateDir(repoRoot, next),
  };
}

export function resolveAgentSigningKey(): string {
  const existing = compactText(process.env.WINGMAN_YOKE_NSEC)
    || compactText(process.env.WINGMAN_NSEC)
    || compactText(process.env.NOSTR_NSEC);
  if (existing) {
    return existing;
  }
  if (!compactText(process.env.SESSION_ID)) {
    throw new Error('Missing operator signing key. Set WINGMAN_YOKE_NSEC only for an explicit operator recovery workflow.');
  }
  throw new Error('Agent key export is disabled. Use the Flight Deck PG capability-aware client instead of Yoke.');
}

function buildConnectionToken(config: RepoBoardConfigWithPaths): string {
  return Buffer.from(JSON.stringify({
    // Deprecated, PG-unsupported discriminator retained for the external Yoke token decoder.
    // It does not enable the removed Autopilot HTTP routes or MCP tools.
    type: 'superbased_connection',
    direct_https_url: config.backendBaseUrl,
    workspace_owner_npub: config.workspaceOwnerNpub,
    app_npub: config.sourceAppNpub,
  })).toString('base64');
}

function parseTaskRecord(raw: Record<string, unknown>): BoardTaskRecord {
  return {
    taskId: compactText(raw.record_id),
    title: compactText(raw.title),
    description: compactText(raw.description),
    state: compactText(raw.state) || null,
    assignedTo: compactText(raw.assigned_to_npub) || null,
    parentTaskId: compactText(raw.parent_task_id) || null,
    flowId: compactText(raw.flow_id) || null,
    flowRunId: compactText(raw.flow_run_id) || null,
    flowStep: Number.isFinite(Number(raw.flow_step)) ? Number(raw.flow_step) : null,
    predecessorTaskIds: compactStringArray(raw.predecessor_task_ids),
    scopeId: compactText(raw.scope_id) || null,
    scopeLineage: [
      compactText(raw.scope_l1_id) || null,
      compactText(raw.scope_l2_id) || null,
      compactText(raw.scope_l3_id) || null,
      compactText(raw.scope_l4_id) || null,
      compactText(raw.scope_l5_id) || null,
    ],
    references: compactReferenceArrayMaybeJson(raw.references ?? raw.references_json),
    tags: compactText(raw.tags)
      ? compactText(raw.tags).split(',').map((entry) => entry.trim()).filter(Boolean)
      : [],
  };
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  const text = compactText(value);
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseGroupAccessRow(row: Record<string, unknown>): Record<string, unknown> {
  const raw = parseMaybeJsonObject(row.raw_json) ?? {};
  return {
    ...raw,
    group_id: compactText(row.group_id) || compactText(raw.group_id),
    current_group_npub: compactText(row.current_group_npub) || compactText(raw.current_group_npub),
    current_epoch: Number.isFinite(Number(row.current_epoch)) ? Number(row.current_epoch) : raw.current_epoch,
    owner_npub: compactText(row.owner_npub) || compactText(raw.owner_npub),
    name: compactText(row.name) || compactText(raw.name),
    group_kind: compactText(row.group_kind) || compactText(raw.group_kind),
    private_member_npub: compactText(row.private_member_npub) || compactText(raw.private_member_npub),
    member_npubs: compactStringArrayMaybeJson(row.member_npubs_json ?? raw.member_npubs),
    member_npubs_json: compactText(row.member_npubs_json),
  };
}

function encodeTaskPatchFlags(patch: Partial<BoardTaskRecord> & { predecessorTaskIds?: string[]; tags?: string[] }): string[] {
  const args: string[] = [];
  if (patch.title !== undefined) args.push('--title', patch.title);
  if (patch.description !== undefined) args.push('--description', patch.description);
  if (patch.state !== undefined && patch.state !== null) args.push('--state', patch.state);
  if (patch.assignedTo !== undefined) {
    if (patch.assignedTo) {
      args.push('--assign', patch.assignedTo);
    } else {
      args.push('--clear-assignee');
    }
  }
  if (patch.tags !== undefined) {
    args.push('--tags', patch.tags.join(','));
  }
  if (patch.scopeId !== undefined) {
    if (patch.scopeId) {
      args.push('--scope', patch.scopeId);
    } else {
      args.push('--clear-scope');
    }
  }
  if (patch.predecessorTaskIds !== undefined) {
    args.push('--predecessor', ...patch.predecessorTaskIds);
  }
  return args;
}

export class YokeBoardClient {
  readonly config: RepoBoardConfigWithPaths;

  constructor(config: RepoBoardConfigWithPaths) {
    this.config = config;
  }

  async initialise(): Promise<void> {
    mkdirSync(this.config.stateDir, { recursive: true });
    await this.runYoke(['init', '--token', buildConnectionToken(this.config)]);
    await this.sync();
  }

  async sync(): Promise<unknown> {
    return await this.runYokeJson(['sync', '--json']);
  }

  async status(): Promise<unknown> {
    return await this.runYokeJson(['status', '--json']);
  }

  async getTask(taskId: string): Promise<BoardTaskRecord> {
    const task = await this.runYokeJson<Record<string, unknown>>(['tasks', 'show', taskId, '--json']);
    return parseTaskRecord(task);
  }

  async updateTask(taskId: string, patch: Partial<BoardTaskRecord> & { predecessorTaskIds?: string[]; tags?: string[] }): Promise<BoardTaskRecord> {
    await this.runYoke(['tasks', 'update', taskId, ...encodeTaskPatchFlags(patch), '--json']);
    return await this.getTask(taskId);
  }

  async commentTask(taskId: string, body: string): Promise<void> {
    await this.runYoke(['tasks', 'comment', taskId, '--body', body, '--json']);
  }

  async createTask(input: BoardTaskCreateInput): Promise<BoardTaskRecord> {
    const args = ['tasks', 'create', '--title', input.title];
    if (input.description) args.push('--description', input.description);
    if (input.state) args.push('--state', input.state);
    if (input.assignedTo) args.push('--assign', input.assignedTo);
    if (input.parentTaskId) args.push('--parent', input.parentTaskId);
    if (input.predecessorTaskIds && input.predecessorTaskIds.length > 0) {
      args.push('--predecessor', ...input.predecessorTaskIds);
    }
    if (input.scopeId) args.push('--scope', input.scopeId);
    if (input.tags && input.tags.length > 0) args.push('--tags', input.tags.join(','));
    args.push('--json');
    const result = await this.runYokeJson<Record<string, unknown>>(args);
    const created = Array.isArray((result as { records?: unknown[] }).records)
      ? ((result as { records: Array<Record<string, unknown>> }).records[0] ?? null)
      : null;
    if (created?.record_id) {
      return await this.getTask(compactText(created.record_id));
    }
    throw new Error(`Unable to locate created task "${input.title}".`);
  }

  async getDocument(documentId: string): Promise<Record<string, unknown>> {
    return await this.runYokeJson<Record<string, unknown>>(['docs', 'show', documentId, '--json']);
  }

  async listScopes(): Promise<Record<string, unknown>[]> {
    return await this.runYokeJson<Record<string, unknown>[]>(['scopes', 'list', '--json']);
  }

  async getScope(scopeId: string): Promise<Record<string, unknown>> {
    return await this.runYokeJson<Record<string, unknown>>(['scopes', 'show', scopeId, '--json']);
  }

  async getScopeAccess(scopeId: string): Promise<Record<string, unknown>> {
    const scope = await this.getScope(scopeId);
    const groupRefs = collectWappScopeGroupRefs(scope);
    if (groupRefs.length === 0) {
      return { ...scope, accessGroups: [] };
    }
    const placeholders = groupRefs.map(() => '?').join(', ');
    const db = this.openDb();
    const rows = db.prepare(
      `SELECT * FROM groups_cache WHERE group_id IN (${placeholders}) OR current_group_npub IN (${placeholders})`,
    ).all(...groupRefs, ...groupRefs) as Array<Record<string, unknown>>;
    return {
      ...scope,
      accessGroups: rows.map((row) => parseGroupAccessRow(row)),
    };
  }

  async getChatContext(input: { channelId?: string; threadId?: string; messageId?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const args = ['chat', 'context'];
    if (input.channelId) args.push('--channel', input.channelId);
    if (input.threadId) args.push('--thread', input.threadId);
    if (input.messageId) args.push('--message', input.messageId);
    if (input.limit != null) args.push('--limit', String(input.limit));
    args.push('--format', 'json');
    return await this.runYokeJson<Record<string, unknown>>(args);
  }

  async runYoke(args: string[]): Promise<string> {
    mkdirSync(this.config.stateDir, { recursive: true });
    const proc = Bun.spawn(
      [resolveNodeBinary(), YOKE_CLI_PATH, ...args],
      {
        cwd: this.config.repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...Bun.env,
          WINGMAN_YOKE_STATE_DIR: this.config.stateDir,
          WINGMAN_YOKE_NSEC: resolveAgentSigningKey(),
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || 'Unknown error';
      throw new Error(`flightdeck-cli ${args.join(' ')} failed (${exitCode}): ${detail}`);
    }
    return stdout.trim();
  }

  async runYokeJson<T>(args: string[]): Promise<T> {
    return parseJsonOutput<T>(await this.runYoke(args));
  }

  openDb(): Database {
    const db = new Database(join(this.config.stateDir, 'yoke.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
}

export function createBoardClient(startDir = process.cwd()): YokeBoardClient {
  return new YokeBoardClient(loadRepoBoardConfig(startDir));
}

export function describeBoardContract(config: RepoBoardConfigWithPaths): string {
  return [
    `Board config: ${config.configPath}`,
    `Workspace owner: ${config.workspaceOwnerNpub}`,
    `Backend: ${config.backendBaseUrl}`,
    `Source app: ${config.sourceAppNpub}`,
    `State dir: ${config.stateDir}`,
    'Available commands:',
    `- bun clis/wingman.ts board task show <task-id>`,
    `- bun clis/wingman.ts board task patch <task-id> --state <state>`,
    `- bun clis/wingman.ts board task comment <task-id> --body "<text>"`,
    `- bun clis/wingman.ts board task create --title "<title>"`,
    `- bun clis/wingman.ts board scope list`,
    `- bun clis/wingman.ts board doc show <doc-id>`,
    `- bun clis/wingman.ts board chat context --channel <channel-id> --thread <message-id>`,
  ].join('\n');
}

export function buildInitSummary(config: RepoBoardConfigWithPaths): string {
  return [
    `Initialised board wrapper for ${config.repoRoot}`,
    describeBoardContract(config),
  ].join('\n\n');
}

export function buildWrappedCommand(config: RepoBoardConfigWithPaths, args: string[]): string {
  return `WINGMAN_YOKE_STATE_DIR=${shellQuote(config.stateDir)} WINGMAN_YOKE_NSEC=${shellQuote(resolveAgentSigningKey())} ${shellQuote(resolveNodeBinary())} ${shellQuote(YOKE_CLI_PATH)} ${args.map(shellQuote).join(' ')}`;
}
