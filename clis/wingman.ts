#!/usr/bin/env bun

import { runFlightDeckPgCli } from '../src/flightdeck-pg/cli';
import { runDispatchCli } from './dispatch';

function usage(): never {
  console.log(`Wingman CLI

Usage:
  bun clis/wingman.ts flightdeck <command> [options]
  bun clis/wingman.ts dispatch [create|status|list|inbox|acknowledge|close|retry] [options]

The retired board/sync command path has been removed from production CLI handling.
Use the PG-native Flight Deck command group instead.`);
  process.exit(1);
}

async function main() {
  if (process.execArgv.includes('--check')) {
    return;
  }
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'dispatch') {
    process.exit(await runDispatchCli(rest));
  }
  if (command !== 'flightdeck') usage();
  const result = await runFlightDeckPgCli(rest, {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
  });
  process.exit(result.exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
