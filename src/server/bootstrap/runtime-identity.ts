import { readFile, stat } from "node:fs/promises";

import {
  getAgentApiProvenancePath,
  type AgentApiProvenance,
} from "./agentapi-build";

export interface RuntimeIdentity {
  controller: {
    execution: "bun-source";
    entrypoint: "src/index.ts";
    gitCommit: string | null;
    sourceState: "clean" | "dirty" | "unavailable";
    startedAt: string;
  };
  agentApi: {
    role: "agent-session-transport";
    upstreamCommit: string;
    sha256: string;
    modifiedAt: string;
  } | null;
}

type GitReader = (args: string[]) => Promise<string>;

async function runGit(projectRootDirectory: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: projectRootDirectory,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed`);
  return stdout.trim();
}

export async function captureRuntimeIdentity(
  projectRootDirectory: string,
  agentApiBinaryPath: string,
  options: { now?: Date; readGit?: GitReader } = {},
): Promise<RuntimeIdentity> {
  const readGit = options.readGit ?? ((args) => runGit(projectRootDirectory, args));
  let gitCommit: string | null = null;
  let sourceState: RuntimeIdentity["controller"]["sourceState"] = "unavailable";
  try {
    [gitCommit, sourceState] = await Promise.all([
      readGit(["rev-parse", "HEAD"]),
      readGit(["status", "--porcelain", "--untracked-files=normal"])
        .then((status) => status ? "dirty" as const : "clean" as const),
    ]);
  } catch {
    gitCommit = null;
    sourceState = "unavailable";
  }

  let agentApi: RuntimeIdentity["agentApi"] = null;
  try {
    const [provenanceText, binaryStat] = await Promise.all([
      readFile(getAgentApiProvenancePath(agentApiBinaryPath), "utf8"),
      stat(agentApiBinaryPath),
    ]);
    const provenance = JSON.parse(provenanceText) as AgentApiProvenance;
    if (provenance.upstream_commit && provenance.sha256) {
      agentApi = {
        role: "agent-session-transport",
        upstreamCommit: provenance.upstream_commit,
        sha256: provenance.sha256,
        modifiedAt: binaryStat.mtime.toISOString(),
      };
    }
  } catch {
    agentApi = null;
  }

  return {
    controller: {
      execution: "bun-source",
      entrypoint: "src/index.ts",
      gitCommit,
      sourceState,
      startedAt: (options.now ?? new Date()).toISOString(),
    },
    agentApi,
  };
}
