#!/usr/bin/env bun

import type { ReadableStream } from "node:stream/web";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type WarmRestartMarker = {
  createdAt: string;
  sessionIds?: string[];
  reason?: string;
  version?: number;
  status?: string;
  message?: string;
  mode?: "preserve" | "native-resume" | "resume-or-fresh";
};

const args = process.argv.slice(2);
if (args.length < 6) {
  console.error(
    "Usage: bun run scripts/warm-restart-manager.ts <wingman-pid> <project-root> <server-port> <marker-path> <tmux-session> <tmux-window>",
  );
  process.exit(1);
}

const [pidArg, projectRootInput, portArg, markerPathInput, tmuxSessionInput, tmuxWindowInput] = args;
const targetPid = Number.parseInt(pidArg ?? "", 10);
const serverPort = Number.parseInt(portArg ?? "", 10);
const projectRoot = resolve(projectRootInput ?? ".");
const markerPath = resolve(markerPathInput ?? "./restart-marker.json");
const tmuxSession = tmuxSessionInput && tmuxSessionInput.trim().length > 0 ? tmuxSessionInput.trim() : "wingman-apps";
const tmuxWindow = tmuxWindowInput && tmuxWindowInput.trim().length > 0 ? tmuxWindowInput.trim() : "wingman-core";
const tmuxTarget = `${tmuxSession}:${tmuxWindow}`;
const managedByPm2 = typeof Bun.env.pm_id === "string" && Bun.env.pm_id.trim().length > 0;

if (!Number.isFinite(targetPid) || targetPid <= 0) {
  console.error(`[manager] Invalid Wingman PID: ${pidArg}`);
  process.exit(1);
}

if (!Number.isFinite(serverPort) || serverPort <= 0) {
  console.error(`[manager] Invalid Wingman port: ${portArg}`);
  process.exit(1);
}

const bunCommand = Bun.env.WINGMAN_RESTART_COMMAND?.trim() || "bun";
const bunArgs =
  Bun.env.WINGMAN_RESTART_ARGS?.trim()?.split(/\s+/).filter(Boolean) || ["run", "src/index.ts"];
const logDirectory = resolve(projectRoot, "data", "app-logs");
const logPath = resolve(logDirectory, "wingman-core.log");

const log = (message: string) => {
  console.log(`[manager] ${message}`);
};

const updateMarker = async (updates: Partial<WarmRestartMarker>) => {
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as WarmRestartMarker;
    const next: WarmRestartMarker = { ...parsed, ...updates };
    await writeFile(markerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    log(`Failed to update restart marker: ${(error as Error).message}`);
  }
};

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      output += decoder.decode(value, { stream: true });
    }
  }
  output += decoder.decode();
  return output;
};

const runTmux = async (args: string[]) => {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exited] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited]);
  return {
    exitCode: exited ?? 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

const ensureTmuxSession = async () => {
  const result = await runTmux(["has-session", "-t", tmuxSession]);
  if (result.exitCode === 0) return;
  const created = await runTmux(["new-session", "-d", "-s", tmuxSession, "-c", projectRoot]);
  if (created.exitCode !== 0) {
    throw new Error(created.stderr || created.stdout || `Failed to create tmux session ${tmuxSession}`);
  }
  await runTmux(["rename-window", "-t", `${tmuxSession}:0`, tmuxWindow]).catch(() => undefined);
  await runTmux(["set-option", "-t", tmuxSession, "remain-on-exit", "on"]).catch(() => undefined);
};

const ensureTmuxWindow = async () => {
  await ensureTmuxSession();
  const windows = await runTmux(["list-windows", "-t", tmuxSession, "-F", "#{window_name}"]);
  if (windows.exitCode !== 0) {
    throw new Error(windows.stderr || windows.stdout || `Failed to list windows for ${tmuxSession}`);
  }
  const names = windows.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (names.includes(tmuxWindow)) {
    return;
  }
  const created = await runTmux(["new-window", "-t", tmuxSession, "-n", tmuxWindow, "-c", projectRoot]);
  if (created.exitCode !== 0) {
    throw new Error(created.stderr || created.stdout || `Failed to create tmux window ${tmuxTarget}`);
  }
  await runTmux(["set-option", "-t", tmuxTarget, "remain-on-exit", "on"]).catch(() => undefined);
};

const attachLogPipe = async () => {
  try {
    await mkdir(logDirectory, { recursive: true });
    const escaped = logPath.replace(/"/g, '\\"');
    await runTmux(["pipe-pane", "-t", tmuxTarget, "-o", `cat >> "${escaped}"`]).catch(() => undefined);
  } catch (error) {
    log(`Failed to attach log pipe: ${(error as Error).message}`);
  }
};

const isProcessAlive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

const waitForExit = async (pid: number, timeoutMs: number) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(250);
  }
  return !isProcessAlive(pid);
};

const waitForServer = async (port: number, timeoutMs: number) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/config`, {
        method: "GET",
        headers: {
          "cache-control": "no-cache",
        },
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Ignore until timeout.
    }
    await delay(500);
  }
  return false;
};

const main = async () => {
  await updateMarker({ status: "stopping" });

  if (isProcessAlive(targetPid)) {
    try {
      process.kill(targetPid, "SIGTERM");
      log(`Sent SIGTERM to Wingman process ${targetPid}`);
    } catch (error) {
      log(`Unable to signal Wingman process ${targetPid}: ${(error as Error).message}`);
    }
  }

  const exited = await waitForExit(targetPid, 30_000);
  if (!exited) {
    await updateMarker({
      status: "failed",
      message: `Wingman process ${targetPid} did not exit within timeout`,
    });
    console.error(`[manager] Wingman process ${targetPid} did not exit within timeout`);
    process.exit(1);
  }

  await updateMarker({ status: "starting" });

  if (managedByPm2) {
    log("Wingman is PM2-managed; waiting for PM2 to restart the process");
  } else {
    try {
      await ensureTmuxWindow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateMarker({ status: "failed", message });
      console.error(`[manager] ${message}`);
      process.exit(1);
    }

    const commandString = [bunCommand, ...bunArgs].join(" ");
    const respawn = await runTmux(["respawn-window", "-k", "-t", tmuxTarget, "-c", projectRoot, commandString]);
    if (respawn.exitCode !== 0) {
      await updateMarker({
        status: "failed",
        message: respawn.stderr || respawn.stdout || "Failed to respawn Wingman tmux window",
      });
      console.error(`[manager] Failed to respawn tmux window: ${respawn.stderr || respawn.stdout}`);
      process.exit(1);
    }

    await attachLogPipe();
    log(`Respawned Wingman in tmux window ${tmuxTarget}`);
  }

  const ready = await waitForServer(serverPort, 30_000);
  if (!ready) {
    await updateMarker({
      status: "failed",
      message: "Wingman restart launched but new server did not respond in time",
    });
    console.error("[manager] New Wingman instance did not respond within timeout");
    process.exit(1);
  }

  await updateMarker({ status: "completed", message: "Autopilot restart completed" });
  await rm(markerPath, { force: true }).catch(() => undefined);
  log("Autopilot restart completed");
};

void main().catch((error) => {
  console.error(`[manager] Unexpected failure: ${(error as Error).message}`);
  process.exit(1);
});
