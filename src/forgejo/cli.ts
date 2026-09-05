import { readFileSync } from 'node:fs';

import { callCapabilityBroker, type CapabilityClientContext } from '../mcp/capability-client';
import { TowerForgejoIssueError, TowerForgejoIssuesClient } from './issues-client';

export interface ForgejoCliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

type FlagMap = Map<string, string | boolean>;

export async function runForgejoCli(argv: string[], io: {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetchImpl?: typeof fetch;
  capabilityContext?: CapabilityClientContext;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ForgejoCliResult> {
  try {
    const parsed = parseFlags(argv);
    if (parsed.positionals.length === 0 || parsed.positionals[0] === 'help' || parsed.flags.has('--help')) {
      const output = usageText();
      io.stdout?.(output);
      return { exitCode: 0, stdout: output };
    }
    for (const forbidden of ['--key', '--nsec', '--forgejo-token', '--token']) {
      if (parsed.flags.has(forbidden)) {
        throw new Error(`${forbidden} is not supported. Forgejo issue commands use the agent session capability. Private signing keys and provider tokens are not accepted.`);
      }
    }

    const env = io.env ?? Bun.env;
    const [area, action] = parsed.positionals;
    if (['bootstrap', 'username', 'repositories'].includes(area ?? '')) {
      const operation = area === 'bootstrap' && ['request', 'status'].includes(action ?? '') ? action
        : area === 'username' && ['get', 'set'].includes(action ?? '') ? 'username'
        : area === 'repositories' && action === 'list' ? 'repositories' : null;
      if (!operation) throw new Error('Use bootstrap request|status, username get|set, or repositories list.');
      const result = await callCapabilityBroker('/api/mcp/capabilities/git-bootstrap', {
        action: operation,
        ...(area === 'username' && action === 'set' ? { username: requiredFlag(parsed.flags, '--username', 'username') } : {}),
        ...(stringFlag(parsed.flags, '--workspace') ? { workspaceId: stringFlag(parsed.flags, '--workspace') } : {}),
        ...(stringFlag(parsed.flags, '--tower-url') ? { towerOrigin: new URL(stringFlag(parsed.flags, '--tower-url')!).origin } : {}),
      }, io.capabilityContext ?? resolveCapabilityContext(parsed.flags, env, io.fetchImpl));
      const output = JSON.stringify(result, null, 2);
      io.stdout?.(output);
      return { exitCode: 0, stdout: output };
    }
    const towerUrl = stringFlag(parsed.flags, '--tower-url') ?? env.TOWER_URL?.trim();
    if (!towerUrl) throw new Error('Missing Tower URL. Pass --tower-url or set TOWER_URL.');
    const capabilityContext = io.capabilityContext ?? resolveCapabilityContext(parsed.flags, env, io.fetchImpl);
    const client = new TowerForgejoIssuesClient({ towerUrl, capabilityContext, fetchImpl: io.fetchImpl });
    const result = await dispatch(client, parsed.positionals, parsed.flags);
    const output = JSON.stringify(result, null, 2);
    io.stdout?.(output);
    return { exitCode: 0, stdout: output };
  } catch (error) {
    const payload: Record<string, unknown> = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof TowerForgejoIssueError) {
      payload.status = error.status;
      payload.code = error.code;
    }
    const output = JSON.stringify(payload, null, 2);
    io.stderr?.(output);
    return { exitCode: 1, stderr: output };
  }
}

async function dispatch(client: TowerForgejoIssuesClient, positionals: string[], flags: FlagMap): Promise<unknown> {
  const [area, action, id] = positionals;
  if (area !== 'issues') throw new Error(`Unknown forgejo command: ${positionals.join(' ')}`);
  const workspaceId = requiredFlag(flags, '--workspace', 'workspace id');
  const repositoryId = requiredFlag(flags, '--repo', 'repository id');

  if (action === 'list') {
    const state = stringFlag(flags, '--state') ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) throw new Error('--state must be open, closed, or all.');
    return await client.listIssues(workspaceId, repositoryId, {
      state: state as 'open' | 'closed' | 'all',
      page: integerFlag(flags, '--page', 1),
      limit: integerFlag(flags, '--limit', 30, 100),
    });
  }
  if (action === 'read') {
    return await client.readIssue(workspaceId, repositoryId, positiveInteger(id, 'issue number'));
  }
  if (action === 'create') {
    return await client.createIssue(workspaceId, repositoryId, {
      title: requiredFlag(flags, '--title', 'title'),
      body: bodyFlag(flags, false),
      correlationId: stringFlag(flags, '--correlation-id'),
    });
  }
  if (action === 'comment') {
    return await client.commentIssue(workspaceId, repositoryId, positiveInteger(id, 'issue number'), {
      body: bodyFlag(flags, true),
      correlationId: stringFlag(flags, '--correlation-id'),
    });
  }
  throw new Error(`Unknown forgejo issues command: ${action ?? ''}`.trim());
}

function resolveCapabilityContext(flags: FlagMap, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): CapabilityClientContext {
  const wingmanUrl = stringFlag(flags, '--wingman-url')
    ?? stringFlag(flags, '--url')
    ?? env.WINGMAN_BROKER_URL?.trim()
    ?? env.WINGMAN_URL?.trim();
  const sessionId = stringFlag(flags, '--session-id') ?? env.SESSION_ID?.trim();
  const capabilityToken = env.WINGMAN_CAPABILITY?.trim();
  if (!wingmanUrl || !sessionId || !capabilityToken) {
    throw new Error('Forgejo issue commands require WINGMAN_URL, SESSION_ID, and WINGMAN_CAPABILITY from an agent session. Private signing keys are not accepted.');
  }
  return { wingmanUrl: wingmanUrl.replace(/\/+$/, ''), sessionId, capabilityToken, fetch: fetchImpl };
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

function requiredFlag(flags: FlagMap, name: string, label: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`Missing required ${label}. Pass ${name}.`);
  return value;
}

function integerFlag(flags: FlagMap, name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function bodyFlag(flags: FlagMap, required: boolean): string {
  const inline = stringFlag(flags, '--body');
  const file = stringFlag(flags, '--body-file');
  if (inline && file) throw new Error('Pass only one of --body or --body-file.');
  const body = file ? readFileSync(file, 'utf8') : inline ?? '';
  if (required && !body.trim()) throw new Error('Missing required comment body. Pass --body or --body-file.');
  return body;
}

function usageText(): string {
  return `Wingman Tower-backed Forgejo issue client

Usage:
  bun clis/wingman.ts forgejo bootstrap request|status [--workspace <id>] [--tower-url <origin>]
  bun clis/wingman.ts forgejo username get|set [--username <name>] [--workspace <id>]
  bun clis/wingman.ts forgejo repositories list [--workspace <id>]
  bun clis/wingman.ts forgejo issues list --workspace <id> --repo <id> [--state open|closed|all] [--page <n>] [--limit <n>]
  bun clis/wingman.ts forgejo issues read <number> --workspace <id> --repo <id>
  bun clis/wingman.ts forgejo issues create --workspace <id> --repo <id> --title <text> [--body <text> | --body-file <path>] [--correlation-id <id>]
  bun clis/wingman.ts forgejo issues comment <number> --workspace <id> --repo <id> (--body <text> | --body-file <path>) [--correlation-id <id>]

Options:
  --tower-url <url>    Tower origin; defaults to TOWER_URL
  --wingman-url <url>  Autopilot broker origin; defaults to WINGMAN_BROKER_URL or WINGMAN_URL
  --session-id <id>    Agent session; defaults to SESSION_ID

All commands use the session capability to obtain a short-lived NIP-98 proof.
The CLI calls Tower only and never accepts a Forgejo token or private key.`;
}
