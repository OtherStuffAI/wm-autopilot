#!/usr/bin/env bun

import { parseCommonFlags, buildAuthConfig, requestJsonWithAuth } from './lib/auth';

import { parseCommandOptions, validateCommandArguments, ownerApiPath } from "./lib/command-options";

const USAGE = `Wingman pipelines CLI (NIP-98)

Usage:
  bun clis/pipelines.ts <command> [run-id] [options]

Commands:
  runs | list                List pipeline runs
  show <run-id>              Show a pipeline run with payloads
  steps <run-id>             List steps for a pipeline run
  resume <run-id>            Resume an errored run from its failed step
  compact-completed          Clear duplicate step/event payloads for completed runs

Common options:
  --owner <npub>            Select owner space (requires admin authority)
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3600)
  --key <nsec|hex>           Operator-only Nostr private key (env: WINGMAN_NSEC)
  --bot-crypto               Sign via bot-crypto API (for agent sessions)
  --json                     Print raw JSON response
  -h, --help                 Show help

Compaction options:
  --dry-run                  Count matching rows without clearing payloads
  --name <name>              Compact only runs with this pipeline run name
  --definition-id <id>       Compact only runs for this definition id
  --older-than <iso>         Compact only runs completed before this timestamp
  --limit <n>                Compact at most n matching runs
  --include-errored          Include errored runs as completed history

Examples:
  bun clis/pipelines.ts runs --bot-crypto
  bun clis/pipelines.ts show <run-id> --bot-crypto
  bun clis/pipelines.ts resume <run-id> --bot-crypto
  bun clis/pipelines.ts compact-completed --dry-run --bot-crypto`;

interface PipelineRun {
  id?: string;
  name?: string;
  status?: string;
  definitionSlug?: string | null;
  definitionId?: string | null;
  cursorIndex?: number;
  startedAt?: string;
  completedAt?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

interface PipelineStep {
  id?: string;
  stepIndex?: number;
  name?: string;
  kind?: string;
  status?: string;
  wingmanSessionId?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

interface PipelineCompactionResult {
  ok?: boolean;
  dryRun?: boolean;
  matchedRuns?: number;
  compactedSteps?: number;
  compactedEvents?: number;
}

interface CompactCompletedOptions {
  dryRun?: boolean;
  includeErrored?: boolean;
  name?: string;
  definitionId?: string;
  olderThan?: string;
  limit?: number;
}

function printRunList(runs: PipelineRun[]): void {
  if (runs.length === 0) {
    console.log('No pipeline runs found.');
    return;
  }
  console.log('ID\tSTATUS\tCURSOR\tSTARTED\tDEFINITION\tNAME\tERROR');
  for (const run of runs) {
    const id = String(run.id ?? '').slice(0, 8);
    const status = String(run.status ?? '-');
    const cursor = String(run.cursorIndex ?? '-');
    const started = String(run.startedAt ?? '-');
    const definition = String(run.definitionSlug ?? run.definitionId ?? '-');
    const name = String(run.name ?? '-');
    const error = String(run.error ?? '-');
    console.log(`${id}\t${status}\t${cursor}\t${started}\t${definition}\t${name}\t${error}`);
  }
}

function printCompactionResult(result: PipelineCompactionResult): void {
  const mode = result.dryRun ? 'Dry run' : 'Compacted';
  console.log(`${mode}: ${String(result.matchedRuns ?? 0)} run(s), ${String(result.compactedSteps ?? 0)} step row(s), ${String(result.compactedEvents ?? 0)} event row(s)`);
}

function parseCompactCompletedOptions(args: string[]): CompactCompletedOptions {
  const options: CompactCompletedOptions = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    switch (flag) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--include-errored':
        options.includeErrored = true;
        break;
      case '--name':
      case '--run-name': {
        const value = args[i + 1];
        if (!value) throw new Error(`${flag} requires a value`);
        options.name = value;
        i++;
        break;
      }
      case '--definition-id': {
        const value = args[i + 1];
        if (!value) throw new Error('--definition-id requires a value');
        options.definitionId = value;
        i++;
        break;
      }
      case '--older-than': {
        const value = args[i + 1];
        if (!value) throw new Error('--older-than requires a value');
        options.olderThan = value;
        i++;
        break;
      }
      case '--limit': {
        const value = args[i + 1];
        if (!value) throw new Error('--limit requires a value');
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--limit must be a positive integer');
        options.limit = parsed;
        i++;
        break;
      }
      default:
        throw new Error(`Unknown compact-completed option: ${flag}`);
    }
  }
  return options;
}

function printStepList(steps: PipelineStep[]): void {
  if (steps.length === 0) {
    console.log('No pipeline steps found.');
    return;
  }
  console.log('INDEX\tID\tSTATUS\tKIND\tSESSION\tNAME\tERROR');
  for (const step of steps) {
    const index = String(step.stepIndex ?? '-');
    const id = String(step.id ?? '').slice(0, 8);
    const status = String(step.status ?? '-');
    const kind = String(step.kind ?? '-');
    const session = String(step.wingmanSessionId ?? '-').slice(0, 8);
    const name = String(step.name ?? '-');
    const error = String(step.error ?? '-');
    console.log(`${index}\t${id}\t${status}\t${kind}\t${session}\t${name}\t${error}`);
  }
}

async function run(): Promise<void> {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  const parsed = parseCommandOptions(args, { "--owner": "value", "--dry-run": "boolean", "--include-errored": "boolean", "--name": "value", "--run-name": "value", "--definition-id": "value", "--older-than": "value", "--limit": "value" });
  const owner = parsed.options["--owner"] as string | undefined;
  if (parsed.options["--name"] && parsed.options["--run-name"]) throw new Error("Use only one of --name and --run-name");
  const command = parsed.positional[0]?.toLowerCase() ?? 'help';
  const id = parsed.positional[1];

  if (help || command === 'help') {
    console.log(USAGE);
    return;
  }

  validateCommandArguments(command, parsed.positional, { runs: 1, list: 1, show: 2, steps: 2, resume: 2, "compact-completed": 1 });
  if (command !== "compact-completed" && Object.keys(parsed.options).some(key => key !== "--owner")) throw new Error("Compaction options require compact-completed");
  const compactArgs = Object.entries(parsed.options).filter(([key]) => key !== "--owner").flatMap(([key, value]) => value === true ? [key] : [key, String(value)]);
  const compactOptions = command === "compact-completed" ? parseCompactCompletedOptions(compactArgs) : undefined;
  const auth = buildAuthConfig(urlInput, keyInput, botCrypto);
  const req = <T>(method: string, path: string, body?: unknown) => requestJsonWithAuth<T>(auth, method, ownerApiPath(path, owner), body);

  switch (command) {
    case 'runs':
    case 'list': {
      const payload = await req<{ runs?: PipelineRun[] }>('GET', '/api/pipelines/runs');
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printRunList(runs);
      }
      break;
    }

    case 'show': {
      if (!id) throw new Error('show requires <run-id>');
      const payload = await req<Record<string, unknown>>(
        'GET',
        `/api/pipelines/runs/${encodeURIComponent(id)}?includeRunPayload=1&includePayload=1`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const run = (payload.run ?? {}) as PipelineRun;
        console.log(`${String(run.id ?? id)}\t${String(run.status ?? '-')}\t${String(run.name ?? '-')}`);
        if (run.error) console.log(`Error: ${run.error}`);
        printStepList(Array.isArray(payload.steps) ? payload.steps as PipelineStep[] : []);
      }
      break;
    }

    case 'steps': {
      if (!id) throw new Error('steps requires <run-id>');
      const payload = await req<{ steps?: PipelineStep[] }>(
        'GET',
        `/api/pipelines/runs/${encodeURIComponent(id)}/steps`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printStepList(Array.isArray(payload.steps) ? payload.steps : []);
      }
      break;
    }

    case 'resume': {
      if (!id) throw new Error('resume requires <run-id>');
      const payload = await req<Record<string, unknown>>(
        'POST',
        `/api/pipelines/runs/${encodeURIComponent(id)}/resume-from-failure`,
        {},
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const run = (payload.run ?? {}) as PipelineRun;
        console.log(`Resumed pipeline run: ${String(run.id ?? id)} (${String(run.status ?? 'running')})`);
      }
      break;
    }

    case 'compact-completed': {
      const options = compactOptions!;
      const payload = await req<PipelineCompactionResult>(
        'POST',
        '/api/pipelines/runs/compact-completed',
        options,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printCompactionResult(payload);
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
