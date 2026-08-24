import { spawn } from "bun";
import { posix } from "node:path";

export function normaliseRepositoryPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Repository path escapes its root: ${path}`);
  }
  return normalized;
}

async function git(root: string, args: string[]): Promise<string> {
  const child = spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout;
}

export async function listFilesAt(root: string, sha: string): Promise<string[]> {
  return (await git(root, ["ls-tree", "-r", "--name-only", sha]))
    .split("\n").filter(Boolean).map(normaliseRepositoryPath).sort();
}

export async function readFileAt(root: string, sha: string, path: string): Promise<string> {
  return git(root, ["show", `${sha}:${normaliseRepositoryPath(path)}`]);
}

export interface GitChanges {
  added: string[];
  changed: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export async function diffFiles(root: string, base: string, head: string): Promise<GitChanges> {
  const result: GitChanges = { added: [], changed: [], deleted: [], renamed: [] };
  const output = await git(root, ["diff", "--name-status", "--find-renames", `${base}..${head}`]);
  for (const line of output.split("\n").filter(Boolean)) {
    const [status, first, second] = line.split("\t");
    if (!status || !first) throw new Error(`Unexpected git diff --name-status row: ${line}`);
    if (status === "A") result.added.push(normaliseRepositoryPath(first));
    else if (status === "D") result.deleted.push(normaliseRepositoryPath(first));
    else if (status.startsWith("R")) {
      if (!second) throw new Error(`Rename row is missing its destination: ${line}`);
      result.renamed.push({ from: normaliseRepositoryPath(first), to: normaliseRepositoryPath(second) });
    }
    else result.changed.push(normaliseRepositoryPath(first));
  }
  return result;
}
