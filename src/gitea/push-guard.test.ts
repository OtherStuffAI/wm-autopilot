import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitAndPushToGitea, pushToGitea } from "./gitea-operations";
import { runPushGuard } from "./push-guard";

const dirs: string[] = [];
const cli = resolve("clis/git-push.ts");
function git(dir: string, args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reviewed-push-")); dirs.push(dir);
  const repo = join(dir, "repo"); const remote = join(dir, "remote.git");
  mkdirSync(repo); git(dir, ["init", "--bare", remote]); git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, ".gitignore"), "ignored/\n"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  return { repo, remote };
}
function invoke(repo: string, reviewed = false, extra: string[] = []) {
  return Bun.spawnSync(["bun", cli, reviewed ? "reviewed-commit-and-push" : "commit-and-push",
    "--directory", repo, "--remote", "origin", "--branch", "main", "--message", "test: reviewed content",
    ...extra], { stdout: "pipe", stderr: "pipe" });
}
const ack = ["--acknowledge-large-files", "--review-reason", "Pete reviewed intended binary"];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("default blocks committed size, reviewed size passes; patterns and gitignore remain blocking", async () => {
  const { repo } = fixture();
  writeFileSync(join(repo, "installer.bin"), Buffer.alloc(6 * 1024 * 1024));
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "large"]);
  const blocked = await runPushGuard(repo);
  expect(blocked.allowed).toBe(false);
  expect(blocked.issues[0]?.message).toContain("bun clis/git-push.ts reviewed-commit-and-push");
  expect((await runPushGuard(repo, { reviewedLargeFiles: true, reviewReason: "Reviewed installer" })).allowed).toBe(true);
  // Working tree size cannot conceal a committed blob.
  writeFileSync(join(repo, "installer.bin"), "small");
  expect((await runPushGuard(repo)).allowed).toBe(false);
  writeFileSync(join(repo, "secret.key"), "secret"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "pattern"]);
  expect((await runPushGuard(repo, { reviewedLargeFiles: true, reviewReason: "review" })).allowed).toBe(false);
  git(repo, ["rm", "secret.key", ".gitignore"]); git(repo, ["commit", "-m", "missing ignore"]);
  expect((await runPushGuard(repo, { reviewedLargeFiles: true, reviewReason: "review" })).issues.some(i => i.category === "gitignore")).toBe(true);
});

test("new/staged big file blocks publication, reviewed CLI commits and pushes exact content", () => {
  const { repo, remote } = fixture();
  writeFileSync(join(repo, "new big.bin"), Buffer.alloc(6 * 1024 * 1024));
  const before = git(repo, ["rev-parse", "HEAD"]);
  expect(invoke(repo).exitCode).toBe(1);
  expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
  expect(Bun.spawnSync(["git", "--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).exitCode).not.toBe(0);
  expect(invoke(repo, true).exitCode).toBe(1);
  expect(invoke(repo, true, ["--review-reason", "reason only"]).exitCode).toBe(1);
  const accepted = invoke(repo, true, ack);
  expect(accepted.exitCode).toBe(0);
  expect(accepted.stderr.toString()).toContain("Pete reviewed intended binary");
  expect(accepted.stderr.toString()).toContain("new big.bin");
  expect(git(remote, ["rev-parse", "main"])).toBe(git(repo, ["rev-parse", "HEAD"]));
});

test("commit failure prevents push; ordinary small changes still commit/push", () => {
  const { repo, remote } = fixture();
  writeFileSync(join(repo, "small.txt"), "ordinary");
  writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(invoke(repo, true, ack).exitCode).toBe(1);
  expect(Bun.spawnSync(["git", "--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).exitCode).not.toBe(0);
  rmSync(join(repo, ".git/hooks/pre-commit"));
  expect(invoke(repo).exitCode).toBe(0);
  expect(git(remote, ["show", "main:small.txt"])).toBe("ordinary");
});

test("invalid review and scan failures fail closed", async () => {
  const { repo } = fixture();
  await expect(runPushGuard(repo, { reviewedLargeFiles: true })).rejects.toThrow("reviewReason");
  await expect(runPushGuard(repo, { reviewReason: "no acknowledgement" })).rejects.toThrow("acknowledgement");
  await expect(runPushGuard(repo, {}, "refs/heads/missing")).rejects.toThrow("Cannot inspect");
  expect(invoke(repo, true, [...ack, "--force"]).exitCode).toBe(1);
});

 test("post-commit hook-added dangerous committed file is caught before push", () => {
  const { repo, remote } = fixture();
  writeFileSync(join(repo, "small.txt"), "ordinary");
  writeFileSync(join(repo, ".git/hooks/post-commit"), '#!/bin/sh\nrm "$0"\nprintf secret > secret.key\ngit add secret.key\ngit commit --amend --no-edit\n', { mode: 0o755 });
  const result = invoke(repo, true, ack);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("gitignored");
  expect(Bun.spawnSync(["git", "--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).exitCode).not.toBe(0);
});


test("CLI child directory cannot stage or push parent repository", () => {
  const { repo, remote } = fixture();
  const child = join(repo, "child"); mkdirSync(child);
  writeFileSync(join(child, "untracked.txt"), "parent must not stage");
  const before = git(repo, ["rev-parse", "HEAD"]);
  const result = invoke(child, true, ack);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("repository root");
  expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
  expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
  expect(Bun.spawnSync(["git", "--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).exitCode).not.toBe(0);
});

test("Gitea push preserves explicit noncurrent branch and scans that branch", async () => {
  const { repo, remote } = fixture();
  git(repo, ["remote", "add", "gitea", remote]); git(repo, ["branch", "other"]);
  // Current branch contains a blocked file, while the explicit branch is safe.
  writeFileSync(join(repo, "secret.key"), "secret"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "blocked current"]);
  const result = await pushToGitea({ directory: repo, branch: "other", opConfig: {
    wingmanConfig: { giteaUrl: "https://example.com", giteaApiToken: "test-token", giteaOwner: "test" } as any,
    dataDir: repo,
  } });
  expect(result.success).toBe(true);
  expect(git(remote, ["rev-parse", "other"])).toBe(git(repo, ["rev-parse", "other"]));
  expect(git(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
});


test("Gitea commit-and-push initializes child repo without staging its parent", async () => {
  const { repo } = fixture();
  const child = join(repo, "project"); mkdirSync(child);
  writeFileSync(join(child, "new.txt"), "child");
  const before = git(repo, ["rev-parse", "HEAD"]);
  await expect(commitAndPushToGitea({ directory: child, opConfig: {
    wingmanConfig: { giteaUrl: "https://example.com", giteaApiToken: "test-token", giteaOwner: "test" } as any,
    dataDir: repo,
  } })).rejects.toThrow();
  expect(git(child, ["rev-parse", "--show-toplevel"])).toBe(realpathSync(child));
  expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
  expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
});
