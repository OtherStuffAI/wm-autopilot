import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitWorkflowApiHandler } from "./git-workflow-api";
import { createGiteaApiHandler } from "./gitea-api";
import { handleGitPush } from "../mcp/tools/git-push";

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

test("API size rejection includes reviewed command; review only passes size; acknowledgement required", async () => {
  const dir = mkdtempSync(join(tmpdir(), "push-api-"));
  try {
    git(dir, "init", "-b", "main"); git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.com");
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    writeFileSync(join(dir, "large.bin"), Buffer.alloc(6 * 1024 * 1024));
    git(dir, "add", "."); git(dir, "commit", "-m", "initial");
    git(dir, "remote", "add", "origin", "https://example.com/repo.git");
    let calls = 0;
    const deps = {
      getSession: () => ({ id: "s", workingDirectory: dir } as any),
      config: { giteaUrl: null, giteaApiToken: null, giteaOwner: null } as any,
      dataDir: dir,
      executeGitCommand: async () => { calls++; return { exitCode: 0, stdout: "ok", stderr: "" }; },
    };
    const handler = createGitWorkflowApiHandler(deps);
    async function request(body: object) {
      const url = new URL("http://localhost/api/git/push");
      return (await handler(new Request(url, { method: "POST", body: JSON.stringify({ sessionId: "s", ...body }) }), url, "POST"))!;
    }
    const denied = await request({});
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("reviewed-commit-and-push"); expect(calls).toBe(0);
    expect((await request({ reviewedLargeFiles: true })).status).toBe(400);
    expect((await request({ reviewReason: "no acknowledgement" })).status).toBe(400);
    expect((await request({ reviewedLargeFiles: true, reviewReason: "reviewed" })).status).toBe(200); expect(calls).toBe(1);
    writeFileSync(join(dir, "secret.key"), "secret"); git(dir, "add", "."); git(dir, "commit", "-m", "secret");
    expect((await request({ reviewedLargeFiles: true, reviewReason: "reviewed" })).status).toBe(400); expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Gitea commit-and-push rejects new oversized staged content with exact reviewed command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gitea-push-api-"));
  try {
    git(dir, "init", "-b", "main"); git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.com");
    writeFileSync(join(dir, ".gitignore"), "ignored/\n"); git(dir, "add", "."); git(dir, "commit", "-m", "initial");
    git(dir, "remote", "add", "gitea", "https://example.com/repo.git");
    writeFileSync(join(dir, "new.bin"), Buffer.alloc(6 * 1024 * 1024));
    const handler = createGiteaApiHandler({ getSession: () => ({ workingDirectory: dir } as any),
      config: { giteaUrl: "https://example.com", giteaApiToken: "test-token", giteaOwner: "test" } as any, dataDir: dir });
    const url = new URL("http://localhost/api/gitea/commit-and-push");
    const response = (await handler(new Request(url, { method: "POST", body: JSON.stringify({ sessionId: "s" }) }), url, "POST"))!;
    expect(response.status).toBe(400); expect(await response.text()).toContain("reviewed-commit-and-push");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP renders server-provided reviewed command without inventing override for old host", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: "blocked", issues: [{ severity: "block", category: "large-file", message: "Review then run bun clis/git-push.ts reviewed-commit-and-push --directory repo --remote origin --branch main --acknowledge-large-files --review-reason reviewed" }] }, { status: 400 })) as any;
    const result = await handleGitPush({}, "http://localhost", "s");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("bun clis/git-push.ts reviewed-commit-and-push");
  } finally { globalThis.fetch = original; }
});
