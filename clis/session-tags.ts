#!/usr/bin/env bun

/**
 * Generate and maintain archive session metadata tags.
 */

import { sessionArchiveStore } from "../src/storage/session-archive-store";
import { generateArchivedSessionTags, mergeSessionTags } from "../src/sessions/session-tag-generator";

const USAGE = `Wingman session tag maintenance

Usage:
  bun clis/session-tags.ts backfill [options]

Options:
  --hours <n>       Look back this many hours (default: 24)
  --limit <n>       Maximum archived sessions to scan (default: 200)
  --replace         Replace existing tags instead of merging
  --dry-run         Print planned changes without writing
  --json            Print JSON output
  -h, --help        Show help`;

interface Options {
  hours: number;
  limit: number;
  replace: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  command: string;
}

const parsePositiveInteger = (value: string | undefined, flag: string): number => {
  if (!value) throw new Error(`${flag} requires a value`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
};

const parseArgs = (args: string[]): Options => {
  const options: Options = {
    hours: 24,
    limit: 200,
    replace: false,
    dryRun: false,
    json: false,
    help: false,
    command: "backfill",
  };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--hours") {
      options.hours = parsePositiveInteger(args[++i], "--hours");
    } else if (token === "--limit") {
      options.limit = Math.min(parsePositiveInteger(args[++i], "--limit"), 200);
    } else if (token === "--replace") {
      options.replace = true;
    } else if (token === "--dry-run") {
      options.dryRun = true;
    } else if (token === "--json") {
      options.json = true;
    } else if (token === "-h" || token === "--help") {
      options.help = true;
    } else {
      positional.push(token);
    }
  }

  options.command = positional[0]?.toLowerCase() ?? "backfill";
  return options;
};

const runBackfill = (options: Options) => {
  const since = new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString();
  const sessions = sessionArchiveStore.listArchivedSessions({
    limit: options.limit,
    offset: 0,
    since,
  });
  const results = [];

  for (const session of sessions) {
    const messages = sessionArchiveStore.getArchivedMessages(session.id);
    const generated = generateArchivedSessionTags(session, messages);
    const nextTags = options.replace
      ? generated
      : mergeSessionTags(session.metadata.tags, generated);
    const changed = JSON.stringify(session.metadata.tags ?? []) !== JSON.stringify(nextTags);
    if (changed && !options.dryRun) {
      sessionArchiveStore.updateArchivedSessionMetadata(session.id, { tags: nextTags });
    }
    results.push({
      id: session.id,
      name: session.name,
      previousTags: session.metadata.tags ?? [],
      tags: nextTags,
      changed,
    });
  }

  return { since, scanned: sessions.length, updated: results.filter((result) => result.changed).length, results };
};

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help || options.command === "help") {
    console.log(USAGE);
    return;
  }
  if (options.command !== "backfill") {
    throw new Error(`Unknown command: ${options.command}`);
  }

  const summary = runBackfill(options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Scanned ${summary.scanned} archived sessions since ${summary.since}`);
  console.log(`${options.dryRun ? "Would update" : "Updated"} ${summary.updated} session(s)`);
  for (const result of summary.results) {
    if (!result.changed) continue;
    console.log(`${result.id.slice(0, 8)}\t${result.name ?? "-"}\t${result.tags.join(",")}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
