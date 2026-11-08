#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { guardedCommitAndPush } from "../src/gitea/guarded-push";

export async function runGitPushCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    directory: { type: "string" }, remote: { type: "string" }, branch: { type: "string" },
    message: { type: "string" }, "acknowledge-large-files": { type: "boolean" },
    "review-reason": { type: "string" },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !["commit-and-push", "reviewed-commit-and-push", "push"].includes(command!)) {
    throw new Error("Usage: bun clis/git-push.ts <push|commit-and-push|reviewed-commit-and-push> --directory <repo> --remote <name> --branch <branch> [--message <message>] [--acknowledge-large-files --review-reason <reviewer and reason>]");
  }
  if (!values.directory || !values.remote || !values.branch) throw new Error("--directory, --remote and --branch are required");
  const reviewed = command === "reviewed-commit-and-push";
  if (reviewed && (!values["acknowledge-large-files"] || !values["review-reason"]?.trim())) {
    throw new Error("Reviewed command requires --acknowledge-large-files and a nonempty --review-reason");
  }
  if (!reviewed && (values["acknowledge-large-files"] || values["review-reason"] !== undefined)) {
    throw new Error("Review flags require the deliberate reviewed-commit-and-push command");
  }
  const directory = resolve(values.directory);
  const result = await guardedCommitAndPush({
    directory, remote: values.remote, branch: values.branch, message: values.message,
    commit: command !== "push",
    review: reviewed ? { reviewedLargeFiles: true, reviewReason: values["review-reason"] } : {},
    onGuard: (guard) => {
      for (const issue of guard.issues) {
        process.stderr.write(`${issue.message}\n${(issue.details || []).join("\n")}\n`);
      }
    },
    run: async (gitArgs) => {
      // Inherit normal Git credentials and host-scoped GIT_CONFIG_* / WINGMAN_* helpers.
      // Arguments are passed directly, never interpreted by a shell.
      const proc = Bun.spawn(["git", ...gitArgs], {
        cwd: directory, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { exitCode: await proc.exited, stdout, stderr };
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) throw new Error(`Push failed (${result.exitCode})`);
}

if (import.meta.main) {
  runGitPushCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
