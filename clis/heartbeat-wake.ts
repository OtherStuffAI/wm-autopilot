#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";

import { runHeartbeatWake } from "../src/heartbeat/heartbeat-wake";

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
}
async function main(): Promise<void> {
  if (process.argv.includes("--smoke")) {
    process.stdout.write(`${JSON.stringify({ ok: true, runtime: "bun", sqlite: "bun-native-or-none" })}\n`);
    return;
  }
  const hours = Number(value("--hours") ?? "12");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("--hours must be between 1 and 168");
  const result = await runHeartbeatWake({
    hours, workspaceId: value("--workspace"), towerUrl: value("--tower-url"), appNpub: value("--app-npub"),
    maxPages: Number(value("--max-pages") ?? 100),
    maxTimeMs: Number(value("--max-time-ms") ?? 120000),
    requestTimeoutMs: Number(value("--request-timeout-ms") ?? 15000),
  });
  const output = JSON.stringify(result, null, 2);
  const outputPath = value("--output");
  if (outputPath) await writeFile(outputPath, `${output}\n`, "utf8");
  process.stdout.write(`${outputPath ? JSON.stringify({ complete: result.complete, coverage: result.coverage, errors: result.errors, output: outputPath }) : output}\n`);
  if (!result.complete) process.exitCode = 2;
}

if (!process.execArgv.includes("--check")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
