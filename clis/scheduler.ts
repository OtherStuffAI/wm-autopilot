#!/usr/bin/env bun

/**
 * Wingman scheduler trigger CLI (NIP-98 authenticated).
 *
 * Commands: list, create, update, delete, trigger, runs
 */

import { parseCommonFlags, buildConfig, requestJson, requestJsonBotCrypto, resolveBaseUrl } from './lib/auth';
import { readFileSync } from 'node:fs';

type TriggerType = 'cron' | 'file_watcher';

const USAGE = `Wingman scheduler trigger CLI (NIP-98)

Usage:
  bun clis/scheduler.ts <command> [id] [options]

Commands:
  list                       List triggers/jobs
  create                     Create a trigger/job
  update <id>                Update a trigger/job
  delete <id>                Delete a trigger/job
  trigger <id>               Manually run a trigger/job
  runs <id>                  List run history for a trigger/job

Required create options:
  --name <name>              Trigger name
  --agent <agent>            Agent for session jobs: codex|claude|goose|opencode|gemini
  --model <model>            Optional model override for the selected agent
  --working-directory <path> Working directory for session jobs
  --prompt <text>            Initial prompt for session jobs
  --prompt-file <path>      Read the initial prompt from a file

Action options:
  --action-type <type>       session|pipeline (default: session)
  --pipeline-definition-id <id> Pipeline definition id/slug/name for pipeline jobs
  --pipeline-input <json>    Pipeline input JSON object
  --pipeline-input-json <json> Alias for --pipeline-input
  --pipeline-agent <agent>   Default agent override for pipeline agent steps

Trigger options:
  --trigger-type <type>      cron|file_watcher (default: cron)
  --cron <expr>              Cron expression (required for cron create)
  --timezone <tz>            Timezone (default: UTC)
  --watch-directory <path>   Watch directory (required for file_watcher create)
  --file-pattern <glob>      File pattern for file_watcher (default: *)

Active window options:
  --active-start <HH:MM>     Start of active window (e.g. 22:00)
  --active-end <HH:MM>       End of active window (e.g. 05:00)

Update options:
  --bot-npub <npub>         Bind the trigger to an active bot identity owned by the scheduler owner
  --enabled <true|false>     Enable/disable trigger

Common options:
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --owner <npub>             Operate in an owner's delegated scheduler space
  --key <nsec|hex>           Operator-only Nostr private key (env: WINGMAN_NSEC)
  --bot-crypto               Sign via bot-crypto API (for agent sessions)
  --json                     Print raw JSON response
  -h, --help                 Show help

Examples:
  bun clis/scheduler.ts list
  bun clis/scheduler.ts create --name "Daily build" --agent codex --model gpt-5.5 --working-directory /tmp/app --prompt "check repo" --trigger-type cron --cron "0 * * * *"
  bun clis/scheduler.ts update job_123 --enabled false
  bun clis/scheduler.ts delete job_123
  bun clis/scheduler.ts trigger job_123
  bun clis/scheduler.ts runs job_123`;

interface SchedulerJob {
  id?: string;
  name?: string;
  agent?: string;
  model?: string;
  triggerType?: TriggerType;
  enabled?: boolean;
  cronExpression?: string | null;
  watchDirectory?: string | null;
  filePattern?: string | null;
  [key: string]: unknown;
}

interface SchedulerRun {
  id?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  sessionId?: string;
  error?: string | null;
  [key: string]: unknown;
}

interface ParsedOptions {
  name?: string;
  agent?: string;
  model?: string;
  workingDirectory?: string;
  prompt?: string;
  actionType?: 'session' | 'pipeline';
  pipelineDefinitionId?: string | null;
  pipelineInput?: Record<string, unknown>;
  pipelineAgent?: string | null;
  triggerType?: TriggerType;
  cronExpression?: string;
  timezone?: string;
  watchDirectory?: string;
  filePattern?: string;
  activeStartTime?: string;
  activeEndTime?: string;
  enabled?: boolean;
  botNpub?: string;
  positional: string[];
}

function parseBooleanFlag(value: string | undefined, flagName: string): boolean {
  if (value === undefined) {
    throw new Error(`${flagName} requires a value: true or false`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${flagName} must be true or false`);
}

function parseJsonObjectFlag(value: string, flagName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${flagName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseSchedulerOptions(args: string[]): ParsedOptions {
  const parsed: ParsedOptions = { positional: [] };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    switch (token) {
      case '--name': {
        const value = args[++i];
        if (!value) throw new Error('--name requires a value');
        parsed.name = value;
        break;
      }
      case '--agent': {
        const value = args[++i];
        if (!value) throw new Error('--agent requires a value');
        parsed.agent = value;
        break;
      }
      case '--model': {
        const value = args[++i];
        if (!value) throw new Error('--model requires a value');
        parsed.model = value;
        break;
      }
      case '--bot-npub': {
        const value = args[++i];
        if (!value) throw new Error('--bot-npub requires a value');
        parsed.botNpub = value;
        break;
      }
      case '--working-directory':
      case '--directory': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.workingDirectory = value;
        break;
      }
      case '--prompt':
      case '--initial-prompt': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.prompt = value;
        break;
      }
      case '--prompt-file': {
        const value = args[++i];
        if (!value) throw new Error('--prompt-file requires a path');
        parsed.prompt = readFileSync(value, 'utf8');
        break;
      }
      case '--action-type': {
        const value = args[++i];
        if (!value) throw new Error('--action-type requires a value');
        if (value === 'session' || value === 'pipeline') {
          parsed.actionType = value;
        } else {
          throw new Error('--action-type must be session or pipeline');
        }
        break;
      }
      case '--pipeline-definition-id':
      case '--pipeline':
      case '--pipeline-id': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.pipelineDefinitionId = value;
        break;
      }
      case '--pipeline-input':
      case '--pipeline-input-json': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a JSON object value`);
        parsed.pipelineInput = parseJsonObjectFlag(value, token);
        break;
      }
      case '--pipeline-agent': {
        const value = args[++i];
        if (!value) throw new Error('--pipeline-agent requires a value');
        parsed.pipelineAgent = value;
        break;
      }
      case '--trigger-type': {
        const value = args[++i];
        if (!value) throw new Error('--trigger-type requires a value');
        if (value === 'cron' || value === 'file_watcher') {
          parsed.triggerType = value;
        } else {
          throw new Error('--trigger-type must be cron or file_watcher; Nostr relay triggers are unsupported');
        }
        break;
      }
      case '--cron':
      case '--cron-expression': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.cronExpression = value;
        break;
      }
      case '--timezone': {
        const value = args[++i];
        if (!value) throw new Error('--timezone requires a value');
        parsed.timezone = value;
        break;
      }
      case '--watch-directory': {
        const value = args[++i];
        if (!value) throw new Error('--watch-directory requires a value');
        parsed.watchDirectory = value;
        break;
      }
      case '--file-pattern': {
        const value = args[++i];
        if (!value) throw new Error('--file-pattern requires a value');
        parsed.filePattern = value;
        break;
      }
      case '--active-start': {
        const value = args[++i];
        if (!value) throw new Error('--active-start requires a value (HH:MM)');
        parsed.activeStartTime = value;
        break;
      }
      case '--active-end': {
        const value = args[++i];
        if (!value) throw new Error('--active-end requires a value (HH:MM)');
        parsed.activeEndTime = value;
        break;
      }
      case '--enabled': {
        parsed.enabled = parseBooleanFlag(args[++i], '--enabled');
        break;
      }
      default:
        parsed.positional.push(token);
    }
  }

  return parsed;
}

function printJobList(jobs: SchedulerJob[]): void {
  if (jobs.length === 0) {
    console.log('No triggers found.');
    return;
  }

  console.log('ID\tNAME\tACTION\tAGENT\tTYPE\tENABLED\tSCHEDULE');
  for (const job of jobs) {
    const id = String(job.id ?? '').slice(0, 8);
    const name = String(job.name ?? '-');
    const action = String(job.actionType ?? 'session');
    const agent = String(job.agent ?? '-');
    const type = String(job.triggerType ?? 'cron');
    const enabled = job.enabled === false ? 'no' : 'yes';

    let schedule = '-';
    if (type === 'cron') schedule = String(job.cronExpression ?? '-');
    if (type === 'file_watcher') {
      const watchDir = String(job.watchDirectory ?? '-');
      const pattern = String(job.filePattern ?? '*');
      schedule = `${watchDir} (${pattern})`;
    }

    console.log(`${id}\t${name}\t${action}\t${agent}\t${type}\t${enabled}\t${schedule}`);
  }
}

function printRunList(runs: SchedulerRun[]): void {
  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }

  console.log('ID\tSTATUS\tSTARTED\tFINISHED\tSESSION\tERROR');
  for (const run of runs) {
    const id = String(run.id ?? '').slice(0, 8);
    const status = String(run.status ?? '-');
    const started = String(run.startedAt ?? '-');
    const finished = String(run.finishedAt ?? '-');
    const session = String(run.sessionId ?? '-').slice(0, 8);
    const error = String(run.error ?? '-');
    console.log(`${id}\t${status}\t${started}\t${finished}\t${session}\t${error}`);
  }
}

function buildCreatePayload(options: ParsedOptions): Record<string, unknown> {
  const name = options.name?.trim();
  const agent = options.agent?.trim();
  const workingDirectory = options.workingDirectory?.trim();
  const initialPrompt = options.prompt?.trim();
  const actionType = options.actionType ?? 'session';

  if (!name) throw new Error('create requires --name <name>');
  if (actionType === 'pipeline') {
    if (!options.pipelineDefinitionId) throw new Error('create requires --pipeline-definition-id <id> for pipeline jobs');
  } else {
    if (!agent) throw new Error('create requires --agent <agent>');
    if (!workingDirectory) throw new Error('create requires --working-directory <path>');
    if (!initialPrompt) throw new Error('create requires --prompt <text>');
  }

  const triggerType = options.triggerType ?? 'cron';
  if (triggerType === 'cron' && !options.cronExpression) {
    throw new Error('create requires --cron <expr> when --trigger-type cron');
  }
  if (triggerType === 'file_watcher' && !options.watchDirectory) {
    throw new Error('create requires --watch-directory <path> when --trigger-type file_watcher');
  }

  const payload: Record<string, unknown> = {
    name,
    actionType,
    triggerType,
  };
  if (options.botNpub) payload.botNpub = options.botNpub;

  if (actionType === 'pipeline') {
    payload.pipelineDefinitionId = options.pipelineDefinitionId;
    payload.pipelineInput = options.pipelineInput ?? {};
    if (options.pipelineAgent !== undefined) payload.pipelineAgent = options.pipelineAgent;
  } else {
    payload.agent = agent;
    if (options.model) payload.model = options.model;
    payload.workingDirectory = workingDirectory;
    payload.initialPrompt = initialPrompt;
  }

  if (options.cronExpression) payload.cronExpression = options.cronExpression;
  if (options.timezone) payload.timezone = options.timezone;
  if (options.watchDirectory) payload.watchDirectory = options.watchDirectory;
  if (options.filePattern) payload.filePattern = options.filePattern;
  if (options.activeStartTime) payload.activeStartTime = options.activeStartTime;
  if (options.activeEndTime) payload.activeEndTime = options.activeEndTime;
  if (options.enabled !== undefined) payload.enabled = options.enabled;

  return payload;
}

function buildUpdatePayload(options: ParsedOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (options.name !== undefined) payload.name = options.name;
  if (options.botNpub !== undefined) payload.botNpub = options.botNpub;
  if (options.actionType !== undefined) payload.actionType = options.actionType;
  if (options.agent !== undefined) payload.agent = options.agent;
  if (options.model !== undefined) payload.model = options.model;
  if (options.workingDirectory !== undefined) payload.workingDirectory = options.workingDirectory;
  if (options.prompt !== undefined) payload.initialPrompt = options.prompt;
  if (options.pipelineDefinitionId !== undefined) payload.pipelineDefinitionId = options.pipelineDefinitionId;
  if (options.pipelineInput !== undefined) payload.pipelineInput = options.pipelineInput;
  if (options.pipelineAgent !== undefined) payload.pipelineAgent = options.pipelineAgent;
  if (options.triggerType !== undefined) payload.triggerType = options.triggerType;
  if (options.cronExpression !== undefined) payload.cronExpression = options.cronExpression;
  if (options.timezone !== undefined) payload.timezone = options.timezone;
  if (options.watchDirectory !== undefined) payload.watchDirectory = options.watchDirectory;
  if (options.filePattern !== undefined) payload.filePattern = options.filePattern;
  if (options.activeStartTime !== undefined) payload.activeStartTime = options.activeStartTime;
  if (options.activeEndTime !== undefined) payload.activeEndTime = options.activeEndTime;
  if (options.enabled !== undefined) payload.enabled = options.enabled;

  if (Object.keys(payload).length === 0) {
    throw new Error('update requires at least one field to change');
  }

  return payload;
}

async function run(): Promise<void> {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  const ownerIndex = args.indexOf('--owner');
  const owner = ownerIndex >= 0 ? args[ownerIndex + 1]?.trim() : undefined;
  if (ownerIndex >= 0) {
    if (!owner) throw new Error('--owner requires an npub');
    args.splice(ownerIndex, 2);
  }
  const options = parseSchedulerOptions(args);

  const command = options.positional[0]?.toLowerCase() ?? 'help';
  const id = options.positional[1];

  if (help || command === 'help') {
    console.log(USAGE);
    return;
  }

  const baseUrl = resolveBaseUrl(urlInput);
  const config = botCrypto ? null : buildConfig(urlInput, keyInput);
  const req = <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => botCrypto
    ? requestJsonBotCrypto<T>(baseUrl, method, path, body)
    : requestJson<T>(config!.baseUrl, config!.secretKey, method, path, body);
  const schedulerPath = (path: string): string => owner
    ? `/api/owners/${encodeURIComponent(owner)}/scheduler${path.slice('/api/scheduler'.length)}`
    : path;

  switch (command) {
    case 'list': {
      const payload = await req<{ jobs?: SchedulerJob[] }>(
        'GET',
        schedulerPath('/api/scheduler/jobs'),
      );
      const jobs = Array.isArray(payload.jobs)
        ? payload.jobs
        : Array.isArray(payload)
          ? (payload as unknown as SchedulerJob[])
          : [];

      if (asJson) {
        console.log(JSON.stringify(jobs, null, 2));
      } else {
        printJobList(jobs);
      }
      break;
    }

    case 'create': {
      const payload = await req<Record<string, unknown>>(
        'POST',
        schedulerPath('/api/scheduler/jobs'),
        buildCreatePayload(options),
      );

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const job = (payload.job ?? payload) as Record<string, unknown>;
        console.log(`Created trigger: ${String(job.id ?? '?')}`);
      }
      break;
    }

    case 'update': {
      if (!id) throw new Error('update requires <id>');

      const payload = await req<Record<string, unknown>>(
        'PATCH',
        schedulerPath(`/api/scheduler/jobs/${encodeURIComponent(id)}`),
        buildUpdatePayload(options),
      );

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const job = (payload.job ?? payload) as Record<string, unknown>;
        console.log(`Updated trigger: ${String(job.id ?? id)}`);
      }
      break;
    }

    case 'delete': {
      if (!id) throw new Error('delete requires <id>');
      await req('DELETE', schedulerPath(`/api/scheduler/jobs/${encodeURIComponent(id)}`));
      console.log(`Deleted trigger: ${id}`);
      break;
    }

    case 'trigger': {
      if (!id) throw new Error('trigger requires <id>');
      const payload = await req<Record<string, unknown>>(
        'POST',
        schedulerPath(`/api/scheduler/jobs/${encodeURIComponent(id)}/trigger`),
        {},
      );

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Triggered: ${id} (session ${String(payload.sessionId ?? '?')})`);
      }
      break;
    }

    case 'runs': {
      if (!id) throw new Error('runs requires <id>');
      const payload = await req<{ runs?: SchedulerRun[] }>(
        'GET',
        schedulerPath(`/api/scheduler/jobs/${encodeURIComponent(id)}/runs`),
      );

      const runs = Array.isArray(payload.runs)
        ? payload.runs
        : Array.isArray(payload)
          ? (payload as unknown as SchedulerRun[])
          : [];

      if (asJson) {
        console.log(JSON.stringify(runs, null, 2));
      } else {
        printRunList(runs);
      }
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
