#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import {
  runHeartbeatWake,
  type HeartbeatWakeOptions,
} from "../src/heartbeat/heartbeat-wake.ts";
import { runHeartbeatCatchUp } from "../src/heartbeat/heartbeat-catch-up.ts";

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return result;
}
async function main(): Promise<void> {
  if (process.argv.includes("--smoke")) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, runtime: "bun", sqlite: "bun-native-or-none" })}\n`,
    );
    return;
  }
  const options: HeartbeatWakeOptions = {
    cacheRoot: value("--cache-dir"),
    hours: Number(value("--hours") ?? "12"),
    workspaceId: value("--workspace"),
    towerUrl: value("--tower-url"),
    appNpub: value("--app-npub"),
    maxPages: Number(value("--max-pages") ?? 100),
    maxTimeMs: Number(value("--max-time-ms") ?? 120000),
    requestTimeoutMs: Number(value("--request-timeout-ms") ?? 30000),
    reviewOnly: process.argv.includes("--review-only"),
    reviewCursor: value("--review-cursor"),
  };
  const outputPath = value("--output");
  if (process.argv.includes("--catch-up")) {
    const result = await runHeartbeatCatchUp(
      options,
      Number(value("--max-wakes") ?? 100),
      async (wake, n) => {
        // Replace only the requested evidence file; do not accumulate whole summaries in memory.
        if (outputPath)
          await writeFile(
            outputPath,
            `${JSON.stringify(wake, null, 2)}\n`,
            "utf8",
          );
        process.stdout.write(
          `${JSON.stringify({
            wake: n,
            syncComplete: wake.syncComplete,
            syncOutcome: wake.syncOutcome,
            coverage: wake.coverage,
            errors: wake.errors,
            output: outputPath,
          })}\n`,
        );
      },
    );
    process.stdout.write(
      `${JSON.stringify({ outcome: result.outcome, wakes: result.wakes, blocker: "blocker" in result ? result.blocker : undefined })}\n`,
    );
    if (result.outcome !== "certified")
      process.exitCode = result.outcome === "blocked" ? 1 : 2;
    return;
  }
  const result = await runHeartbeatWake(options);
  const output = JSON.stringify(result, null, 2);
  if (outputPath) await writeFile(outputPath, `${output}\n`, "utf8");
  process.stdout.write(
    `${
      outputPath
        ? JSON.stringify({
            complete: result.complete,
            syncComplete: result.syncComplete,
            review: result.review,
            coverage: result.coverage,
            errors: result.errors,
            output: outputPath,
          })
        : output
    }\n`,
  );
  if (!result.complete) process.exitCode = 2;
}
if (!process.execArgv.includes("--check")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
