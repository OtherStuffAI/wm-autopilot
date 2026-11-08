import { realpathSync } from "node:fs";
import { runPushGuard, validatePushReview, type PushReview, type PushGuardResult } from "./push-guard";

export interface GitResult { exitCode: number; stdout: string; stderr: string }
export type GitRunner = (args: string[]) => Promise<GitResult>;

export class PushGuardError extends Error {
  constructor(public guard: PushGuardResult) {
    super(guard.issues.filter((issue) => issue.severity === "block").map((issue) => [issue.message, ...(issue.details || [])].join("\n")).join("\n"));
  }
}

export async function guardedCommitAndPush(options: {
  directory: string;
  remote: string;
  branch: string;
  message?: string;
  commit?: boolean;
  review?: PushReview;
  run: GitRunner;
  onGuard?: (guard: PushGuardResult) => void;
}): Promise<GitResult> {
  const { run, directory, remote, branch, review = {} } = options;
  validatePushReview(review);
  if (!remote || remote.startsWith("-") || !branch || branch.startsWith("-") || remote.includes(":") || remote.includes("/")) {
    throw new Error("An explicit configured remote name and branch are required");
  }
  async function checked(args: string[]) {
    const result = await run(args);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  }
  const root = await checked(["rev-parse", "--show-toplevel"]);
  if (realpathSync(directory) !== realpathSync(root)) {
    throw new Error("Explicit directory must be the repository root; refusing to modify a parent repository");
  }
  await checked(["check-ref-format", `refs/heads/${branch}`]);
  await checked(["remote", "get-url", remote]);
  if (options.commit) {
    const current = await checked(["symbolic-ref", "--short", "HEAD"]);
    if (current !== branch) throw new Error(`Current branch ${current} does not match explicit target ${branch}`);
    await checked(["add", "--all"]);
    // Scan staged content, including new files, before creating a commit.
    const tree = await checked(["write-tree"]);
    const stagedGuard = await runPushGuard(directory, review, tree);
    if (!stagedGuard.allowed) throw new PushGuardError(stagedGuard);
    const diff = await run(["diff", "--cached", "--quiet"]);
    if (diff.exitCode === 1) await checked(["commit", "-m", options.message || "updates"]);
    else if (diff.exitCode !== 0) throw new Error(`Cannot inspect staged changes: ${diff.stderr}`);
  }
  // Hooks may change the commit. Inspect and push this exact immutable revision.
  const revision = await checked(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const guard = await runPushGuard(directory, review, revision);
  if (!guard.allowed) throw new PushGuardError(guard);
  options.onGuard?.(guard);
  return run(["push", "--", remote, `${revision}:refs/heads/${branch}`]);
}
