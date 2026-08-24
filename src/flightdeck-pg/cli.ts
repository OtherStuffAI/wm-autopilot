import { readFileSync } from 'node:fs';

import { resolveSecretKey } from '../../clis/lib/auth';
import { callCapabilityBroker } from '../mcp/capability-client';
import { FlightDeckPgClient, MissingFlightDeckPgRouteError, resolveFlightDeckPgConfig } from './client';

export interface FlightDeckPgCliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

type FlagMap = Map<string, string | boolean>;

interface FlightDeckPgCliDefaults {
  workspaceId?: string;
  channelId?: string;
  threadId?: string;
  taskId?: string;
  scopeId?: string;
}

export async function runFlightDeckPgCli(argv: string[], io: {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetchImpl?: typeof fetch;
} = {}): Promise<FlightDeckPgCliResult> {
  try {
    const parsed = parseFlags(argv);
    const flags = parsed.flags;
    const keyInput = stringFlag(flags, '--key') ?? undefined;
    const sessionId = stringFlag(flags, '--session-id') ?? Bun.env.SESSION_ID ?? null;
    const wingmanUrl = stringFlag(flags, '--url') ?? Bun.env.WINGMAN_URL ?? null;
    const hasBrokerContext = Boolean(sessionId && Bun.env.WINGMAN_CAPABILITY?.trim());
    const useBotCrypto = flags.has('--bot-crypto') || (!keyInput && hasBrokerContext);
    if (useBotCrypto && keyInput) throw new Error('--bot-crypto cannot be combined with --key.');

    const explicitTowerUrl = stringFlag(flags, '--tower-url');
    const explicitAppNpub = stringFlag(flags, '--app-npub');
    let towerUrl = explicitTowerUrl ?? Bun.env.TOWER_URL ?? Bun.env.FLIGHTDECK_TOWER_URL ?? null;
    let appNpub = explicitAppNpub ?? Bun.env.FLIGHTDECK_APP_NPUB ?? null;
    let initialContext: Record<string, unknown> | null = null;
    // In broker mode the live dispatch context is authoritative over inherited
    // environment defaults. Explicit CLI flags remain an intentional override.
    if (sessionId && useBotCrypto) {
      initialContext = await fetchFlightDeckDispatchContext({
        wingmanUrl,
        sessionId,
        fetchImpl: io.fetchImpl,
      });
      const workspace = objectValue(initialContext.workspace);
      towerUrl = explicitTowerUrl ?? stringValue(workspace.backendBaseUrl) ?? towerUrl;
      appNpub = explicitAppNpub ?? stringValue(workspace.sourceAppNpub) ?? appNpub;
    }
    if (parsed.positionals[0] === 'context' && initialContext && (!towerUrl || !appNpub)) {
      const output = formatOutput(initialContext, flags.has('--json'));
      io.stdout?.(output);
      return { exitCode: 0, stdout: output };
    }
    const client = new FlightDeckPgClient(resolveFlightDeckPgConfig({
      towerUrl,
      wingmanUrl,
      appNpub,
      secretKey: useBotCrypto ? null : resolveSecretKey(keyInput),
      botCrypto: useBotCrypto,
      sessionId,
      initialContext,
      fetchImpl: io.fetchImpl,
    }));
    const defaults = await resolveCommandDefaults(client, parsed.positionals, flags);
    const result = await dispatch(client, parsed.positionals, flags, defaults);
    const text = formatOutput(result, flags.has('--json'));
    io.stdout?.(text);
    return { exitCode: 0, stdout: text };
  } catch (error) {
    const payload = serializeError(error);
    const text = JSON.stringify(payload, null, 2);
    io.stderr?.(text);
    return { exitCode: 1, stderr: text };
  }
}

export async function fetchFlightDeckDispatchContext(input: {
  wingmanUrl?: string | null;
  sessionId: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const targetWingmanUrl = input.wingmanUrl?.trim().replace(/\/$/, '') ?? '';
  const brokerUrl = Bun.env.WINGMAN_BROKER_URL?.trim().replace(/\/$/, '') || targetWingmanUrl;
  if (!brokerUrl) {
    throw new Error('Missing Wingman URL for Flight Deck PG dispatch context. Pass --url or set WINGMAN_URL.');
  }
  try {
    return await callCapabilityBroker<Record<string, unknown>>(
      '/api/mcp/wingman/flightdeck',
      { action: 'context' },
      {
        wingmanUrl: brokerUrl,
        sessionId: input.sessionId,
        capabilityToken: Bun.env.WINGMAN_CAPABILITY?.trim() ?? '',
        fetch: input.fetchImpl,
      },
    );
  } catch (error) {
    throw new Error(`Autopilot Flight Deck context helper failed: ${(error as Error).message}`);
  }
}

async function dispatch(client: FlightDeckPgClient, args: string[], flags: FlagMap, defaults: FlightDeckPgCliDefaults): Promise<unknown> {
  const [area, action, id] = args;
  if (!area || area === 'help') return usageText();
  const limit = optionalNumber(flags, '--limit');

  if (area === 'context') return await client.context();
  if (area === 'status') return await client.status();
  if (area === 'workspaces' && action === 'list') return await client.listWorkspaces();
  if (area === 'workspace' && action === 'show') return await client.showWorkspace(requiredArg(id, 'workspace id'));
  if (area === 'workspace' && action === 'me') return await client.workspaceMe(requiredArg(id, 'workspace id'));

  const workspaceId = requiredValue(flags, defaults, '--workspace', 'workspace id');
  if (area === 'scopes' && action === 'list') return await client.listScopes(workspaceId);
  if (area === 'scope' && action === 'show') return await client.showScope(workspaceId, requiredArg(id ?? defaults.scopeId, 'scope id'));
  if (area === 'channels' && action === 'list') return await client.listChannels(workspaceId, requiredValue(flags, defaults, '--scope', 'scope id'), limit);
  if (area === 'channel' && action === 'show') return await client.showChannel(workspaceId, requiredArg(id ?? defaults.channelId, 'channel id'));
  if (area === 'threads' && action === 'list') return await client.listThreads(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), limit);
  if (area === 'thread' && action === 'read') return await client.readThread(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredArg(id ?? defaults.threadId, 'thread id'), limit);
  if (area === 'chat' && action === 'reply') return await client.reply(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredValue(flags, defaults, '--thread', 'thread id'), requiredFlag(flags, '--body', 'body'));
  if (area === 'tasks' && action === 'list') return await client.listTasks(workspaceId, {
    channelId: valueFromFlagOrDefault(flags, defaults, '--channel'),
    scopeId: valueFromFlagOrDefault(flags, defaults, '--scope'),
    limit,
  });
  if (area === 'task' && action === 'show') return await client.showTask(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'));
  if (area === 'task' && action === 'create') return await client.createTask(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), {
    title: requiredFlag(flags, '--title', 'title'),
    description: stringFlag(flags, '--body') ?? stringFlag(flags, '--description'),
    state: stringFlag(flags, '--state') ?? undefined,
    priority: stringFlag(flags, '--priority') ?? undefined,
    threadId: valueFromFlagOrDefault(flags, defaults, '--thread'),
  });
  if (area === 'task' && action === 'patch') return await client.patchTask(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), readJsonFile(requiredFlag(flags, '--json-file', 'json file')));
  if (area === 'task' && action === 'move') return await client.moveTask(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), requiredFlag(flags, '--destination-channel', 'destination channel id'), stringFlag(flags, '--destination-scope'));
  if (area === 'task' && action === 'state') return await client.updateTaskState(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), requiredFlag(flags, '--state', 'state'));
  if (area === 'task' && action === 'comments') return await client.listTaskComments(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), limit);
  if (area === 'task' && action === 'comment') return await client.commentTask(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), requiredFlag(flags, '--body', 'body'), valueFromFlagOrDefault(flags, defaults, '--thread'));
  if (area === 'task' && action === 'assign') return await client.assignTask(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), requiredFlag(flags, '--agent', 'agent actor id'));
  if (area === 'docs' && action === 'list') return await client.listDocs(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), limit);
  if (area === 'doc' && action === 'create') return await client.createDoc(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredFlag(flags, '--title', 'title'), readTextFile(requiredFlag(flags, '--body-file', 'body file')));
  if (area === 'doc' && action === 'show') return await client.showDoc(workspaceId, requiredArg(id, 'doc id'), flags.has('--body'));
  if (area === 'doc' && action === 'download') return await client.downloadDoc(workspaceId, requiredArg(id, 'doc ref'), requiredFlag(flags, '--out', 'output path'), {
    includeComments: !flags.has('--no-comments'),
    downloadStorage: !flags.has('--no-storage'),
  });
  if (area === 'doc-download') return await client.downloadDoc(workspaceId, requiredArg(action, 'doc ref'), requiredArg(id ?? stringFlag(flags, '--out') ?? undefined, 'output path'), {
    includeComments: !flags.has('--no-comments'),
    downloadStorage: !flags.has('--no-storage'),
  });
  if (area === 'doc' && action === 'update') return await client.updateDoc(workspaceId, requiredArg(id, 'doc id'), readTextFile(requiredFlag(flags, '--body-file', 'body file')));
  if (area === 'doc' && action === 'move') return await client.moveDoc(workspaceId, requiredArg(id, 'doc id'), requiredFlag(flags, '--destination-channel', 'destination channel id'), stringFlag(flags, '--destination-scope'));
  if (area === 'doc' && action === 'comments') return await client.listDocComments(workspaceId, requiredArg(id, 'doc id'), limit);
  if (area === 'doc' && action === 'reply') return await client.replyDoc(workspaceId, requiredArg(id, 'doc id'), requiredFlag(flags, '--body', 'body'), stringFlag(flags, '--comment'));
  if (area === 'files' && action === 'list') return await client.listFiles(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), limit);
  if (area === 'file' && action === 'upload') return await client.uploadFile(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredFlag(flags, '--path', 'path'), stringFlag(flags, '--content-type'));
  if (area === 'file' && action === 'show') return await client.showFile(workspaceId, requiredArg(id, 'file id'), flags.has('--object'));
  if (area === 'audio' && action === 'create') return await client.createAudio(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredFlag(flags, '--file', 'file'), stringFlag(flags, '--content-type'));
  if (area === 'reactions' && action === 'create') return await client.createReaction(workspaceId, requiredFlag(flags, '--target', 'target'), requiredFlag(flags, '--emoji', 'emoji'));
  if (area === 'events' && action === 'poll') return await client.pollEvents(workspaceId, stringFlag(flags, '--since'), limit);
  if (area === 'members' && action === 'list') return await client.listMembers(workspaceId);
  if (area === 'workrooms' && action === 'list') return await client.listWorkrooms(workspaceId, {
    scopeId: valueFromFlagOrDefault(flags, defaults, '--scope'),
    channelId: valueFromFlagOrDefault(flags, defaults, '--channel'),
    status: stringFlag(flags, '--status'),
    limit,
  });
  if (area === 'workrooms' && action === 'search') return await client.searchWorkrooms(workspaceId, {
    query: requiredFlag(flags, '--query', 'query'),
    scopeId: valueFromFlagOrDefault(flags, defaults, '--scope'),
    channelId: valueFromFlagOrDefault(flags, defaults, '--channel'),
    limit,
  });
  if (area === 'workroom' && action === 'show') return await client.showWorkroom(workspaceId, requiredArg(id, 'workroom id'), limit);
  if (area === 'workroom' && action === 'events') return await client.listWorkroomEvents(workspaceId, requiredArg(id, 'workroom id'), limit);
  if (area === 'workroom' && action === 'event') return await client.appendWorkroomEvent(workspaceId, requiredArg(id, 'workroom id'), {
    eventType: requiredFlag(flags, '--type', 'event type'),
    title: stringFlag(flags, '--title'),
    body: stringFlag(flags, '--body'),
    targetType: stringFlag(flags, '--target-type'),
    targetRef: stringFlag(flags, '--target-ref'),
    visibility: stringFlag(flags, '--visibility'),
    payload: readOptionalJsonFile(flags, '--payload-file'),
  });
  if (area === 'workroom' && action === 'links') return await client.listWorkroomLinks(workspaceId, requiredArg(id, 'workroom id'), limit);
  if (area === 'workroom' && action === 'link') return await client.appendWorkroomLink(workspaceId, requiredArg(id, 'workroom id'), {
    linkType: requiredFlag(flags, '--link-type', 'link type'),
    targetType: requiredFlag(flags, '--target-type', 'target type'),
    targetId: stringFlag(flags, '--target-id'),
    externalUrl: stringFlag(flags, '--external-url'),
    label: stringFlag(flags, '--label'),
    status: stringFlag(flags, '--status'),
    metadata: readOptionalJsonFile(flags, '--metadata-file'),
  });
  if (area === 'workroom' && action === 'approval-request') return await client.requestProductionMergeApproval(workspaceId, requiredArg(id, 'workroom id'), {
    repo: stringFlag(flags, '--repo'),
    fromBranch: stringFlag(flags, '--from-branch'),
    toBranch: requiredFlag(flags, '--to-branch', 'production branch'),
    commit: requiredFlag(flags, '--commit', 'commit'),
    previewUrl: stringFlag(flags, '--preview-url'),
    validationEvidence: commaListFlag(flags, '--validation'),
    title: stringFlag(flags, '--title'),
    summary: stringFlag(flags, '--summary'),
    reviewerNpub: stringFlag(flags, '--reviewer-npub'),
    metadata: readOptionalJsonFile(flags, '--metadata-file'),
  });
  if (area === 'workroom' && action === 'production-merge-check') return await client.checkProductionMergeApproval(workspaceId, requiredArg(id, 'workroom id'), {
    repo: stringFlag(flags, '--repo'),
    toBranch: requiredFlag(flags, '--to-branch', 'production branch'),
    commit: requiredFlag(flags, '--commit', 'commit'),
  });
  if (area === 'approvals' && action === 'list') return await client.listApprovals(workspaceId, {
    targetType: stringFlag(flags, '--target-type'),
    targetId: stringFlag(flags, '--target-id'),
    action: stringFlag(flags, '--action'),
    status: stringFlag(flags, '--status'),
    limit,
  });
  if (area === 'approval' && action === 'show') return await client.showApproval(workspaceId, requiredArg(id, 'approval id'));
  throw new Error(`Unknown flightdeck command: ${[area, action, id].filter(Boolean).join(' ')}`);
}

async function resolveCommandDefaults(client: FlightDeckPgClient, args: string[], flags: FlagMap): Promise<FlightDeckPgCliDefaults> {
  if (!commandUsesDispatchContext(args) || hasAllRequiredDispatchFlags(args, flags)) return {};
  const context = await client.context();
  return parseDispatchDefaults(context);
}

function commandUsesDispatchContext(args: string[]): boolean {
  const [area, action] = args;
  if (area === 'doc-download') return true;
  return [
    'scopes:list',
    'scope:show',
    'channels:list',
    'channel:show',
    'threads:list',
    'thread:read',
    'chat:reply',
    'tasks:list',
    'task:show',
    'task:create',
    'task:patch',
    'task:move',
    'task:state',
    'task:comments',
    'task:comment',
    'task:assign',
    'docs:list',
    'doc:create',
    'doc:show',
    'doc:download',
    'doc:update',
    'doc:move',
    'doc:comments',
    'doc:reply',
    'files:list',
    'file:upload',
    'file:show',
    'audio:create',
    'reactions:create',
    'events:poll',
    'members:list',
    'workrooms:list',
    'workrooms:search',
    'workroom:show',
    'workroom:events',
    'workroom:event',
    'workroom:links',
    'workroom:link',
    'workroom:approval-request',
    'workroom:production-merge-check',
    'approvals:list',
    'approval:show',
  ].includes(`${area}:${action}`);
}

function hasAllRequiredDispatchFlags(args: string[], flags: FlagMap): boolean {
  const [area, action, id] = args;
  if (!stringFlag(flags, '--workspace')) return false;
  if (['channels:list'].includes(`${area}:${action}`)) return Boolean(stringFlag(flags, '--scope'));
  if (['threads:list', 'docs:list', 'files:list'].includes(`${area}:${action}`)) return Boolean(stringFlag(flags, '--channel'));
  if (['thread:read'].includes(`${area}:${action}`)) return Boolean(stringFlag(flags, '--channel') && id);
  if (['chat:reply'].includes(`${area}:${action}`)) return Boolean(stringFlag(flags, '--channel') && stringFlag(flags, '--thread'));
  if (['task:show', 'task:patch', 'task:move', 'task:state', 'task:comments', 'task:comment', 'task:assign'].includes(`${area}:${action}`)) return Boolean(id);
  if (['doc:download'].includes(`${area}:${action}`)) return Boolean(id);
  if (area === 'doc-download') return Boolean(action);
  if (['task:create', 'doc:create', 'file:upload', 'audio:create'].includes(`${area}:${action}`)) return Boolean(stringFlag(flags, '--channel'));
  if (['workroom:show', 'workroom:events', 'workroom:event', 'workroom:links', 'workroom:link', 'workroom:approval-request', 'workroom:production-merge-check', 'approval:show'].includes(`${area}:${action}`)) return Boolean(id);
  return true;
}

function parseDispatchDefaults(context: Record<string, unknown>): FlightDeckPgCliDefaults {
  const workspace = objectValue(context.workspace);
  const chat = objectValue(context.chat);
  const routing = objectValue(context.routing);
  const record = objectValue(context.record);
  const bindingType = stringValue(routing.bindingType);
  const bindingId = stringValue(routing.bindingId);
  const recordFamily = stringValue(record.recordFamily);
  const recordId = stringValue(record.recordId);
  return {
    workspaceId: stringValue(workspace.workspaceId),
    channelId: stringValue(chat.channelId) ?? stringValue(routing.channelId),
    threadId: stringValue(chat.threadId) ?? stringValue(routing.threadId),
    scopeId: stringValue(routing.scopeId) ?? stringValue(workspace.scopeId),
    taskId: bindingType === 'task' ? bindingId : recordFamily === 'task' ? recordId : undefined,
  };
}

function parseFlags(argv: string[]): { positionals: string[]; flags: FlagMap } {
  const flags: FlagMap = new Map();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(arg, true);
      continue;
    }
    flags.set(arg, next);
    index += 1;
  }
  return { positionals, flags };
}

function stringFlag(flags: FlagMap, name: string): string | null {
  const value = flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredValue(flags: FlagMap, defaults: FlightDeckPgCliDefaults, name: string, label: string): string {
  const value = valueFromFlagOrDefault(flags, defaults, name);
  if (!value) throw new Error(`Missing required ${label}. Pass ${name} or run from a SESSION_ID with Flight Deck dispatch context.`);
  return value;
}

function requiredFlag(flags: FlagMap, name: string, label: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`Missing required ${label}. Pass ${name}.`);
  return value;
}

function valueFromFlagOrDefault(flags: FlagMap, defaults: FlightDeckPgCliDefaults, name: string): string | null {
  return stringFlag(flags, name) ?? defaultForFlag(defaults, name) ?? null;
}

function defaultForFlag(defaults: FlightDeckPgCliDefaults, name: string): string | undefined {
  if (name === '--workspace') return defaults.workspaceId;
  if (name === '--channel') return defaults.channelId;
  if (name === '--thread') return defaults.threadId;
  if (name === '--task') return defaults.taskId;
  if (name === '--scope') return defaults.scopeId;
  return undefined;
}

function requiredArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing required ${label}.`);
  return value;
}

function optionalNumber(flags: FlagMap, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function readJsonFile(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readTextFile(path)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed as Record<string, unknown>;
}

function readOptionalJsonFile(flags: FlagMap, name: string): Record<string, unknown> | null {
  const path = stringFlag(flags, name);
  return path ? readJsonFile(path) : null;
}

function commaListFlag(flags: FlagMap, name: string): string[] {
  const value = stringFlag(flags, name);
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function formatOutput(result: unknown, json: boolean): string {
  if (json || typeof result !== 'string') return JSON.stringify(result, null, 2);
  return result;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof MissingFlightDeckPgRouteError) {
    return { ok: false, error: error.message, missingRoute: error.routeGap };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function usageText(): string {
  return `Wingman Flight Deck PG CLI

Usage:
  bun clis/wingman.ts flightdeck context --json
  bun clis/wingman.ts flightdeck status --json
  bun clis/wingman.ts flightdeck workspaces list --json
  bun clis/wingman.ts flightdeck tasks list --workspace <workspace-id> --channel <channel-id> --json
  bun clis/wingman.ts flightdeck task show <task-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck task comment <task-id> --workspace <workspace-id> --body "..." --json
  bun clis/wingman.ts flightdeck task state <task-id> --workspace <workspace-id> --state in_progress --json
  bun clis/wingman.ts flightdeck task move <task-id> --workspace <workspace-id> --destination-channel <channel-id> [--destination-scope <scope-id>] --json
  bun clis/wingman.ts flightdeck thread read <thread-id> --workspace <workspace-id> --channel <channel-id> --json
  bun clis/wingman.ts flightdeck chat reply --workspace <workspace-id> --channel <channel-id> --thread <thread-id> --body "..." --json
  bun clis/wingman.ts flightdeck doc create --workspace <workspace-id> --channel <channel-id> --title "..." --body-file file.md --json
  bun clis/wingman.ts flightdeck doc download <doc-ref> --workspace <workspace-id> --out ./tmp/design.md --json
  bun clis/wingman.ts flightdeck doc move <doc-id> --workspace <workspace-id> --destination-channel <channel-id> [--destination-scope <scope-id>] --json
  bun clis/wingman.ts flightdeck file upload --workspace <workspace-id> --channel <channel-id> --path ./artifact.png --json
  bun clis/wingman.ts flightdeck workroom show <workroom-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck workroom event <workroom-id> --workspace <workspace-id> --type pr_ready --title "PR ready" --json
  bun clis/wingman.ts flightdeck workroom link <workroom-id> --workspace <workspace-id> --link-type pull_request --target-type pull_request --external-url https://github.com/org/repo/pull/1 --json
  bun clis/wingman.ts flightdeck workroom approval-request <workroom-id> --workspace <workspace-id> --repo org/repo --to-branch deployed --commit abc123 --json

Agent sessions automatically use the capability broker and hydrate omitted
Tower, app, workspace, channel, thread, task, and scope values from dispatch
context. Use --bot-crypto to require broker mode explicitly. --key and
WINGMAN_NSEC are operator-only.`;
}
