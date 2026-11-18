import { mkdir, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMetadata } from "../../sessions/session-metadata.ts";

export function assertInterviewLaunch(agent: string, directory: string, metadata: SessionMetadata): void {
  if (metadata.executionProfile !== "scoped-interview") return;
  if (agent !== "claude" || metadata.agentTransport !== "claude-sdk" || metadata.role !== "completed-turn" || metadata.nativeProjectTools || !/^[a-f0-9]{64}$/.test(metadata.bindingId ?? "") || directory !== join(homedir(),".wingmen","runtime","scoped-interviews",metadata.bindingId!)) throw Error("Invalid scoped interview launch binding");
}
export function assertInterviewMetadataUpdate(current: SessionMetadata, update: Record<string,unknown>): void {
  if ("executionProfile" in update && update.executionProfile !== current.executionProfile) throw Error("Execution profile is immutable");
  if (current.executionProfile === "scoped-interview") for (const key of ["role","bindingId","agentTransport","nativeProjectTools","nativeAgentSession"] as const) {
    if (key in update && JSON.stringify(update[key]) !== JSON.stringify(current[key])) throw Error("Scoped interview binding is immutable");
  }
}

/** Reject pre-existing symlinks or permissive state rather than silently reusing it. */
export async function preparePrivateInterviewDirectory(directory: string): Promise<void> {
  await mkdir(directory,{recursive:true,mode:0o700});
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid() || await realpath(directory) !== directory) throw Error("Interview directory is not private server-owned state");
}
