import { loadConfig } from "../src/config";

const DEFAULT_SIGNAL: NodeJS.Signals = "SIGTERM";
const FALLBACK_SIGNAL: NodeJS.Signals = "SIGKILL";

type KillResult = {
  port: number;
  pids: number[];
  killed: number[];
  failed: { pid: number; error: string }[];
};

const readProcessOutput = async (process: Bun.Subprocess<"ignore", "pipe", "pipe">) => {
  const stdout = await new Response(process.stdout).text();
  return stdout.trim();
};

const listListeningPids = async (port: number): Promise<number[]> => {
  const args = [`-iTCP:${port}`, "-sTCP:LISTEN", "-t"];
  const subprocess = Bun.spawn(["lsof", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, exitCode] = await Promise.all([readProcessOutput(subprocess), subprocess.exited]);
  if (exitCode !== 0) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
};

const tryKill = (pid: number, signal: NodeJS.Signals): string | null => {
  try {
    process.kill(pid, signal);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const killPorts = async (start: number, count: number): Promise<KillResult[]> => {
  const outcomes: KillResult[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const port = start + offset;
    const pids = await listListeningPids(port);
    const killed: number[] = [];
    const failed: { pid: number; error: string }[] = [];
    for (const pid of pids) {
      const error = tryKill(pid, DEFAULT_SIGNAL) ?? tryKill(pid, FALLBACK_SIGNAL);
      if (error) {
        failed.push({ pid, error });
      } else {
        killed.push(pid);
      }
    }
    outcomes.push({ port, pids, killed, failed });
  }
  return outcomes;
};

const main = async () => {
  const config = loadConfig();
  const outcomes = await killPorts(config.agentPortStart, config.agentPortMax);

  let killedTotal = 0;
  for (const outcome of outcomes) {
    const uniquePids = Array.from(new Set(outcome.pids));
    const uniqueKilled = Array.from(new Set(outcome.killed));
    killedTotal += uniqueKilled.length;
    if (uniquePids.length === 0) {
      console.log(`[cleanports] port ${outcome.port}: no listeners`);
      continue;
    }
    console.log(
      `[cleanports] port ${outcome.port}: found ${uniquePids.join(", ")}; killed ${uniqueKilled.join(", ") || "none"}`,
    );
    for (const failure of outcome.failed) {
      console.warn(`[cleanports] failed to kill pid ${failure.pid} on port ${outcome.port}: ${failure.error}`);
    }
  }

  console.log(`[cleanports] done. terminated ${killedTotal} process${killedTotal === 1 ? "" : "es"}.`);
};

main().catch((error) => {
  console.error("[cleanports] unexpected error", error);
  process.exit(1);
});
