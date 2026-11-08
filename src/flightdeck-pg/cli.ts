import { usageText } from "./cli-help.ts";
import { parseCliMentions, withCliMentions } from "./mentions.ts";
import { parseFlightDeckOptions } from "./cli-options.ts";
import { contextCliHelp, runContextCli } from "./context-cli.ts";
import { FlightDeckPgResponseError } from "./response-error.ts";
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { resolveSecretKey } from '../../clis/lib/auth';
import { callCapabilityBroker } from '../mcp/capability-client';
import { SESSION_FILE_UPLOAD_MAX_BYTES } from '../mcp/flightdeck-file-upload';
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
    const parsed = parseFlightDeckOptions(argv);
    if (!parsed.positionals.length || parsed.positionals[0] === "help" || parsed.flags.has("--help") ||
      (parsed.positionals[0] === "context-tree" && parsed.positionals[1] === "help")) {
      const stdout = parsed.positionals[0] === "context-tree" ? contextCliHelp : usageText();
      io.stdout?.(stdout);
      return { exitCode: 0, stdout };
    }
    const flags = parsed.flags;
    if (flags.has("--mentions-json") || (typeof flags.get("--body") === "string" && String(flags.get("--body")).match(/mention:(agent|person):/))) {
      const message = withCliMentions(requiredFlag(flags, "--body", "body"), mentionsFlag(flags).mentions);
      flags.set("--body", message.body);
    }
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
    const inboxSession = objectValue(initialContext?.agentInbox).mode === 'inbox_required';
    const helperWrite = inboxSession && sessionId
      ? await dispatchInboxSessionWrite(parsed.positionals, flags, defaults, {
        sessionId, wingmanUrl, fetchImpl: io.fetchImpl, workspaceId: stringValue(objectValue(initialContext?.workspace).workspaceId) ?? null,
      })
      : undefined;
    const result = helperWrite ?? await dispatch(client, parsed.positionals, flags, defaults);
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

// Strict-inbox agent sessions write through the Autopilot helper (the session's own bot key, structured mentions and
// instruction signatures, origin provenance inside the notified location). Reads and every other command use the
// ordinary signed Tower client: Tower authorizes the bot by its own ACL.
async function dispatchInboxSessionWrite(
  args: string[], flags: FlagMap, defaults: FlightDeckPgCliDefaults,
  broker: { sessionId: string; wingmanUrl: string | null; fetchImpl?: typeof fetch; workspaceId: string | null },
): Promise<unknown> {
  const [area, action, id] = args;
  const command = `${area ?? ''} ${action ?? ''}`.trim();
  // The helper writes into the session's own workspace; another workspace goes through the ordinary signed client.
  const workspaceFlag = stringFlag(flags, '--workspace');
  if (workspaceFlag && workspaceFlag !== broker.workspaceId) return undefined;
  const helper = async (helperAction: string, params: Record<string, unknown>) => {
    const brokerUrl = Bun.env.WINGMAN_BROKER_URL?.trim().replace(/\/$/, '') || broker.wingmanUrl?.trim().replace(/\/$/, '') || '';
    return callCapabilityBroker<Record<string, unknown>>('/api/mcp/wingman/flightdeck', { action: helperAction, ...params }, {
      wingmanUrl: brokerUrl, sessionId: broker.sessionId, capabilityToken: Bun.env.WINGMAN_CAPABILITY?.trim() ?? '', fetch: broker.fetchImpl,
    });
  };
  const threadId = id ?? defaults.threadId ?? null;
  const taskId = id ?? defaults.taskId ?? null;
  if (command === "chat create" || command === "thread create") {
    return helper("chat_reply", { channelId: stringFlag(flags, "--channel") ?? defaults.channelId ?? null,
      createThread: true, body: requiredFlag(flags, "--body", "body"), ...mentionsFlag(flags) });
  }
  if (command === 'chat reply') {
    return helper('chat_reply', {
      channelId: stringFlag(flags, '--channel') ?? defaults.channelId ?? null, threadId: stringFlag(flags, '--thread') ?? defaults.threadId ?? null,
      body: requiredFlag(flags, '--body', 'body'), ...mentionsFlag(flags),
    });
  }
  if (command === 'task comment') {
    return helper('task_comment', { taskId, body: requiredFlag(flags, '--body', 'body'), threadId: stringFlag(flags, '--thread') ?? null, ...mentionsFlag(flags) });
  }
  if (command === 'doc reply') return helper('doc_reply', { documentId: requiredArg(id, 'doc id'), body: requiredFlag(flags, '--body', 'body'), commentId: stringFlag(flags, '--comment') ?? null, ...mentionsFlag(flags) });
  if (command === 'doc create') {
    return helper('doc_create', {
      channelId: stringFlag(flags, '--channel') ?? defaults.channelId ?? null, title: requiredFlag(flags, '--title', 'title'),
      body: readTextFile(requiredFlag(flags, '--body-file', 'body file')),
    });
  }
  if (command === 'task create') {
    return helper('task_create', {
      channelId: stringFlag(flags, '--channel') ?? defaults.channelId ?? null, title: requiredFlag(flags, '--title', 'title'),
      description: stringFlag(flags, '--body') ?? stringFlag(flags, '--description') ?? null,
      state: stringFlag(flags, '--state') ?? null, priority: stringFlag(flags, '--priority') ?? null, threadId: stringFlag(flags, '--thread') ?? null,
    });
  }
  if (command === 'file upload') {
    const path = requiredFlag(flags, '--path', 'path');
    const file = Bun.file(path);
    if (file.size > SESSION_FILE_UPLOAD_MAX_BYTES) throw new Error(`File exceeds the ${SESSION_FILE_UPLOAD_MAX_BYTES} byte session upload limit.`);
    return helper('file_upload', {
      channelId: stringFlag(flags, '--channel') ?? defaults.channelId ?? null, fileName: basename(path),
      contentType: stringFlag(flags, '--content-type') ?? (file.type || 'application/octet-stream'),
      base64_data: Buffer.from(await file.arrayBuffer()).toString('base64'),
    });
  }
  if (command === 'task state') return helper('task_state', { taskId, state: requiredFlag(flags, '--state', 'state') });
  if (command === 'doc update') {
    const hasBase = flags.get('--base-row-version') || flags.get('--base-version-id') || flags.get('--base-body-sha256-hex');
    return helper('doc_update', {
      documentId: id, body: readTextFile(requiredFlag(flags, '--body-file', 'body file')),
      ...(hasBase ? { captured_base: { row_version: Number(flags.get('--base-row-version')), base_version_id: String(flags.get('--base-version-id') ?? ''), base_body_sha256_hex: String(flags.get('--base-body-sha256-hex') ?? '') } } : {}),
    });
  }
  return undefined;
}

/** `--mentions-json '[{"type":"agent","npub":"npub1…","label":"Name"}]'`: explicit structured mentions (validated by the helper). */
function mentionsFlag(flags: FlagMap) {
  return { mentions: parseCliMentions(stringFlag(flags, "--mentions-json")) };
}

async function dispatch(client: FlightDeckPgClient, args: string[], flags: FlagMap, defaults: FlightDeckPgCliDefaults): Promise<unknown> {
  const [area, action, id] = args;
  if (!area || area === 'help') return usageText();
  const limit = optionalNumber(flags, '--limit');

  if (area === "context-tree") return runContextCli(client.contextTree, args, flags);
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
  if (area === 'threads' && action === 'list') return await client.listThreads(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), limit, stringFlag(flags, '--cursor'));
  if (area === 'thread' && action === 'read') return await client.readThread(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredArg(id ?? defaults.threadId, 'thread id'), limit);
  if (area === 'chat' && action === 'reply') return await client.reply(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredValue(flags, defaults, '--thread', 'thread id'), requiredFlag(flags, '--body', 'body'), mentionsFlag(flags).mentions);
  if ((area === "chat" || area === "thread") && action === "create") return client.reply(workspaceId, requiredValue(flags, defaults, "--channel", "channel id"), null, requiredFlag(flags, "--body", "body"), mentionsFlag(flags).mentions, true);
  if (area === "thread" && action === "rename") return client.renameThread(workspaceId, requiredArg(id, "thread id"), requiredFlag(flags, "--title", "title"));
  if (area === 'tasks' && action === 'list') return await client.listTasks(workspaceId, {
    channelId: valueFromFlagOrDefault(flags, defaults, '--channel'),
    scopeId: valueFromFlagOrDefault(flags, defaults, '--scope'),
    cursor: stringFlag(flags, "--cursor"),
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
  if (area === 'task' && action === 'comments') return await client.listTaskComments(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), limit, stringFlag(flags, '--cursor'), flags.has('--all'));
  if (area === 'task' && action === 'comment') return await client.commentTask(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), requiredFlag(flags, '--body', 'body'), valueFromFlagOrDefault(flags, defaults, '--thread'), mentionsFlag(flags).mentions);
  if (area === 'task' && action === 'assign') return await client.assignTask(workspaceId, requiredArg(id ?? defaults.taskId, 'task id'), requiredFlag(flags, '--agent', 'agent actor id'));
  if (area === 'docs' && action === 'list') return await client.listDocs(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), limit, stringFlag(flags, '--cursor'));
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
  if (area === 'doc' && action === 'update') return await client.updateDoc(workspaceId, requiredArg(id, 'doc id'), readTextFile(requiredFlag(flags, '--body-file', 'body file')),
    flags.get('--base-row-version') || flags.get('--base-version-id') || flags.get('--base-body-sha256-hex') ? {
      row_version: Number(flags.get('--base-row-version')), base_version_id: String(flags.get('--base-version-id') ?? ''), base_body_sha256_hex: String(flags.get('--base-body-sha256-hex') ?? ''),
    } : undefined);
  if (area === 'doc' && action === 'move') return await client.moveDoc(workspaceId, requiredArg(id, 'doc id'), requiredFlag(flags, '--destination-channel', 'destination channel id'), stringFlag(flags, '--destination-scope'));
  if (area === 'doc' && action === 'comments') return await client.listDocComments(workspaceId, requiredArg(id, 'doc id'), limit, stringFlag(flags, '--cursor'), flags.has('--all'));
  if (area === 'doc' && action === 'reply') return await client.replyDoc(workspaceId, requiredArg(id, 'doc id'), requiredFlag(flags, '--body', 'body'), stringFlag(flags, '--comment'), mentionsFlag(flags).mentions);
  if (area === 'files' && action === 'list') return await client.listFiles(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), limit, stringFlag(flags, '--cursor'));
  if (area === 'file' && action === 'upload') return await client.uploadFile(workspaceId, requiredValue(flags, defaults, '--channel', 'channel id'), requiredFlag(flags, '--path', 'path'), stringFlag(flags, '--content-type'));
  if (area === 'attachment' && ['blossom', 'publish', 'unpublish'].includes(action || '')) {
    if (action === 'publish' && !flags.has('--public')) throw new Error('--public is required to acknowledge anonymous downloading and copying.');
    return await client.attachmentBlossom(workspaceId, requiredFlag(flags, '--message', 'source message id'),
      requiredArg(id, 'storage object id'), action === 'blossom' ? 'status' : action as 'publish' | 'unpublish');
  }
  if (area === 'file' && ['blossom', 'publish', 'unpublish'].includes(action || '')) {
    if (action === 'publish' && !flags.has('--public')) throw new Error('Publishing makes these bytes anonymously public. Pass --public to confirm this consequence.');
    return await client.fileBlossom(workspaceId, requiredArg(id, 'file id'), action === 'blossom' ? 'status' : action as 'publish' | 'unpublish',
      action === 'blossom' ? undefined : requiredFlag(flags, '--version', 'selected file version id'));
  }
  if (area === "file" && action === "download") return client.downloadFile(workspaceId, requiredArg(id, "file id"), requiredFlag(flags, "--out", "output path"));
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
    'chat:create',
    'thread:create',
    'thread:rename',
    'file:download',
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
    'attachment:blossom',
    'attachment:publish',
    'attachment:unpublish',
    'file:blossom',
    'file:publish',
    'file:unpublish',
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
  if (['task:create', 'doc:create', 'file:upload', 'audio:create', 'chat:create', 'thread:create'].includes(`${area}:${action}`)) return Boolean(stringFlag(flags, '--channel'));
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
  if (error instanceof FlightDeckPgResponseError) return { ok: false, ...error.envelope, status: error.status };
  if (error instanceof Error && "envelope" in error && "status" in error) return { ok: false, ...(error.envelope as Record<string, unknown>), status: error.status };
  if (error instanceof MissingFlightDeckPgRouteError) {
    return { ok: false, error: error.message, missingRoute: error.routeGap };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
