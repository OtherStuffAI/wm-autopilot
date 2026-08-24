#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(filename);
const projectRoot = resolve(scriptDir, "..");

const command = (Bun.env.WINGMAN_RESTART_COMMAND ?? "bun").trim();
const argsConfig = Bun.env.WINGMAN_RESTART_ARGS?.trim();
const args = argsConfig && argsConfig.length > 0 ? argsConfig.split(/\s+/) : ["run", "src/index.ts"];

const spawnReplacement = () => {
  return spawn(command, args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
};

try {
  const child = spawnReplacement();
  if (!child.pid) {
    console.error("[restart] Failed to spawn replacement Wingman process");
    process.exit(1);
  }
  child.unref();
  console.log(`[restart] launched replacement Wingman process (pid ${child.pid})`);

  const targetPid = Number.parseInt(process.env.WINGMAN_PID ?? "", 10);
  const delayMs = Number.parseInt(Bun.env.WINGMAN_RESTART_DELAY_MS ?? "", 10) || 750;

  setTimeout(() => {
    if (Number.isFinite(targetPid) && targetPid > 0 && targetPid !== process.pid) {
      try {
        process.kill(targetPid, "SIGTERM");
        console.log(`[restart] sent SIGTERM to current Wingman process (${targetPid})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[restart] failed to signal current process: ${message}`);
      }
    } else {
      console.warn("[restart] WINGMAN_PID not set. Manual shutdown may be required.");
    }
    process.exit(0);
  }, delayMs);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[restart] unable to initiate Wingman restart: ${message}`);
  process.exit(1);
}
