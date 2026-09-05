import { readFileSync } from 'node:fs';

import { type CapabilityClientContext } from '../mcp/capability-client';
import { NativeForgejoIssueError, NativeForgejoIssuesClient } from './issues-client';

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
    if (['bootstrap', 'username', 'repositories'].includes(area ?? '')) throw new Error('Tower Forgejo bootstrap is retired. Manage accounts, usernames and repositories in native Forgejo.');
    const forgejoUrl = stringFlag(parsed.flags, '--forgejo-url') ?? env.FORGEJO_URL?.trim();
    if (!forgejoUrl) throw new Error('Missing Forgejo URL. Pass --forgejo-url or set FORGEJO_URL.');
    const capabilityContext = io.capabilityContext ?? resolveCapabilityContext(parsed.flags, env, io.fetchImpl);
    const client = new NativeForgejoIssuesClient({ forgejoUrl, capabilityContext, fetchImpl: io.fetchImpl });
    const result = await dispatch(client, parsed.positionals, parsed.flags);
    const output = JSON.stringify(result, null, 2);
    io.stdout?.(output);
    return { exitCode: 0, stdout: output };
  } catch (error) {
    const payload: Record<string, unknown> = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof NativeForgejoIssueError) {
      payload.status = error.status;
      payload.code = error.code;
    }
    const output = JSON.stringify(payload, null, 2);
    io.stderr?.(output);
    return { exitCode: 1, stderr: output };
  }
}

async function dispatch(client: NativeForgejoIssuesClient, positionals: string[], flags: FlagMap): Promise<unknown> {
  const [area, action, id] = positionals;
  if (!['issues', 'pulls'].includes(area ?? '')) throw new Error(`Unknown forgejo command: ${positionals.join(' ')}`);
  const repositoryId = requiredFlag(flags, '--repo', 'native owner/repository');
  if (area === 'pulls') {
    if (action === 'list') return client.listPulls(repositoryId);
    if (action === 'read') return client.readPull(repositoryId, positiveInteger(id, 'pull request number'));
    if (action === 'create') return client.createPull(repositoryId, { title: requiredFlag(flags, '--title', 'title'), body: bodyFlag(flags, false), head: requiredFlag(flags, '--head', 'head branch'), base: requiredFlag(flags, '--base', 'base branch') });
    throw new Error('Use pulls list|read|create.');
  }

  if (action === 'list') {
    const state = stringFlag(flags, '--state') ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) throw new Error('--state must be open, closed, or all.');
    return await client.listIssues(repositoryId, {
      state: state as 'open' | 'closed' | 'all',
      page: integerFlag(flags, '--page', 1),
      limit: integerFlag(flags, '--limit', 30, 100),
    });
  }
  if (action === 'read') {
    return await client.readIssue(repositoryId, positiveInteger(id, 'issue number'));
  }
  if (action === 'create') {
    return await client.createIssue(repositoryId, {
      title: requiredFlag(flags, '--title', 'title'),
      body: bodyFlag(flags, false),
    });
  }
  if (action === 'comment') {
    return await client.commentIssue(repositoryId, positiveInteger(id, 'issue number'), {
      body: bodyFlag(flags, true),
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
  return `Wingman native Forgejo client

Usage:
  wingman forgejo issues list --repo owner/repository [--state open|closed|all]
  wingman forgejo issues read <number> --repo owner/repository
  wingman forgejo issues create --repo owner/repository --title <text> [--body <text> | --body-file <path>]
  wingman forgejo issues comment <number> --repo owner/repository (--body <text> | --body-file <path>)
  wingman forgejo pulls list --repo owner/repository
  wingman forgejo pulls read <number> --repo owner/repository
  wingman forgejo pulls create --repo owner/repository --title <text> --head <branch> --base <branch> [--body-file <path>]

Options:
  --forgejo-url <origin> Native Forgejo origin; defaults to FORGEJO_URL
  --wingman-url <url> Autopilot broker; defaults to WINGMAN_BROKER_URL or WINGMAN_URL
  --session-id <id> Agent session; defaults to SESSION_ID

The session broker obtains an account OAuth token through stock Forgejo PKCE
and Tower Nostr sign-in. All issue and pull requests call native Forgejo APIs.
Expired credentials trigger a new sign-in; permission denials are final.`;
}
