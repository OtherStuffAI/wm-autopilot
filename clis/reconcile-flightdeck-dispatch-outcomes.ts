#!/usr/bin/env bun

import { resolve } from 'node:path';

import { resolveSecretKey } from './lib/auth';
import { loadAuthoritativeFlightDeckSourceLabels } from '../src/agent-chat/flightdeck-dispatch-source-loader';
import { reconcileHistoricalFlightDeckDispatchOutcomes } from '../src/agent-chat/flightdeck-dispatch-reconciler';

const flags = parseFlags(Bun.argv.slice(2));
if (flags.has('--help')) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (flags.has('--dry-run') && flags.has('--apply')) fail('Pass either --dry-run or --apply, not both.');

const databasePath = resolve(stringFlag(flags, '--db') ?? 'data/wingman.db');
const dryRun = !flags.has('--apply');
const hydrateSources = !flags.has('--no-source-hydration');
const secretKey = hydrateSources ? resolveSecretKey(stringFlag(flags, '--key') ?? undefined) : null;

try {
  const report = await reconcileHistoricalFlightDeckDispatchOutcomes({
    databasePath,
    dryRun,
    loadSourceLabels: secretKey
      ? async (rows) => await loadAuthoritativeFlightDeckSourceLabels({ databasePath, rows, secretKey })
      : undefined,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function parseFlags(argv: string[]): Map<string, string | boolean> {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) fail(`Unknown argument: ${flag}`);
    if (['--dry-run', '--apply', '--no-source-hydration', '--help'].includes(flag)) {
      parsed.set(flag, true);
      continue;
    }
    if (!['--db', '--key'].includes(flag)) fail(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${flag} requires a value.`);
    parsed.set(flag, value);
    index += 1;
  }
  return parsed;
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | null {
  const value = flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function usage(): string {
  return `Reconcile historical Flight Deck dispatch outcomes

Usage:
  bun clis/reconcile-flightdeck-dispatch-outcomes.ts --dry-run [--db data/wingman.db]
  bun clis/reconcile-flightdeck-dispatch-outcomes.ts --apply [--db data/wingman.db]

The command defaults to dry-run. --apply creates a timestamped SQLite backup before updating rows.
Source labels are bulk-loaded and cached from authoritative Flight Deck collections. Pass
--no-source-hydration only when Tower is intentionally unavailable; unrecoverable sources retain
the explicit "Source label not recorded" fallback.`;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
