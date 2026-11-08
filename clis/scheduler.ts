#!/usr/bin/env bun

/**
 * Wingman scheduler trigger CLI (NIP-98 authenticated).
 *
 * Commands: list, create, update, delete, trigger, runs
 */

import { parseCommonFlags, buildAuthConfig, requestJsonWithAuth } from './lib/auth';
import { describeSchedulerRun } from '../src/scheduler/run-outcome';

type TriggerType = 'cron' | 'file_watcher';

import { validateCommandArguments } from "./lib/command-options";
import { formatSchedulerOutcome } from "./lib/scheduler-output";

import { parseSchedulerCommand } from "./lib/scheduler-options";
import { buildCreatePayload, buildUpdatePayload } from "./lib/scheduler-payload";

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
  --flightdeck-context-file <path> Exact scheduled Flight Deck binding JSON (null clears it)
  --bot-npub <npub>         Bind the trigger to an active bot identity owned by the scheduler owner
  --enabled <true|false>     Enable/disable trigger

Common options:
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3600)
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
    const outcome = describeSchedulerRun(run as Parameters<typeof describeSchedulerRun>[0]);
    const status = String(run.statusLabel ?? outcome.statusLabel);
    const started = String(run.startedAt ?? '-');
    const finished = String(run.finishedAt ?? '-');
    const session = String(run.sessionId ?? '-').slice(0, 8);
    const error = String(run.error ?? '-');
    console.log(`${id}\t${status}\t${started}\t${finished}\t${session}\t${error}`);
    console.log(`  ${String(run.statusDetail ?? outcome.statusDetail)}`);
  }
}

async function run(): Promise<void> {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  const { options, owner } = parseSchedulerCommand(args);

  const command = options.positional[0]?.toLowerCase() ?? 'help';
  const id = options.positional[1];

  if (help || command === 'help') {
    console.log(USAGE);
    return;
  }

  validateCommandArguments(command, options.positional, { list: 1, create: 1, update: 2, delete: 2, trigger: 2, runs: 2 });
  if (command !== "create" && command !== "update" && Object.keys(options).some(key => key !== "positional")) throw new Error("Job configuration options require create or update");
  const auth = buildAuthConfig(urlInput, keyInput, botCrypto);
  const schedulerPath = (path: string): string => owner
    ? `/api/owners/${encodeURIComponent(owner)}/scheduler${path.slice('/api/scheduler'.length)}`
    : path;
  const req = <T>(method: string, path: string, body?: unknown) => requestJsonWithAuth<T>(auth, method, path, body);

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
        console.log(`Triggered: ${id} (${formatSchedulerOutcome(payload)})`);
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
