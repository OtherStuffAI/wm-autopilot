#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";

import { runHeartbeatWake } from "../src/heartbeat/heartbeat-wake";

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
async function main(): Promise<void> {
  if (process.argv.includes("--smoke")) {
    process.stdout.write(`${JSON.stringify({ ok: true, runtime: "bun", sqlite: "bun-native-or-none" })}\n`);
    return;
  }
  const hours = Number(value("--hours") ?? "12");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("--hours must be between 1 and 168");
  const towerUrl = (value("--tower-url") ?? process.env.FLIGHTDECK_TOWER_URL ?? process.env.TOWER_URL ?? "http://127.0.0.1:3100").trim();
  const appNpub = (value("--app-npub") ?? process.env.FLIGHTDECK_APP_NPUB ?? "").trim();
  if (!appNpub) throw new Error("FLIGHTDECK_APP_NPUB or --app-npub is required");
  const result = await runHeartbeatWake({ hours, towerUrl, appNpub });
  const output = JSON.stringify(result, null, 2);
  const outputPath = value("--output");
  if (outputPath) await writeFile(outputPath, `${output}\n`, "utf8");
  process.stdout.write(`${output}\n`);
}

if (!process.execArgv.includes("--check")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
