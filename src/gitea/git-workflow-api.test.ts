import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createGitWorkflowApiHandler } from "./git-workflow-api";

function runGit(directory: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || `git ${args.join(" ")} failed`);
  }
}

describe("createGitWorkflowApiHandler", () => {
  test("POST /api/git/push uses the session working directory and origin remote", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "git-workflow-api-"));
    try {
      runGit(repoDir, ["init", "-b", "main"]);
      writeFileSync(join(repoDir, ".gitignore"), "node_modules/\n");
      runGit(repoDir, ["add", ".gitignore"]);
      runGit(repoDir, [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "Initial commit",
      ]);
      runGit(repoDir, ["remote", "add", "origin", "https://github.com/openai/wingmen.git"]);

      const calls: Array<Record<string, unknown>> = [];
      const handler = createGitWorkflowApiHandler({
        getSession: (sessionId) =>
          sessionId === "session-1"
            ? ({
                id: "session-1",
                npub: "npub1viewer",
                workingDirectory: repoDir,
              } as any)
            : undefined,
        config: {
          port: 3600,
          agentPortStart: 3700,
          agentPortMax: 10,
          directoryDef: repoDir,
          folderAccess: [repoDir],
          agents: {},
          defaultAgent: "codex",
          hostUrlBase: null,
          connectRelays: [],
          giteaUrl: null,
          giteaApiToken: null,
          giteaOwner: null,
        } as any,
        dataDir: join(repoDir, ".wingman-data"),
        executeGitCommand: async (options) => {
          calls.push(options);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      });

      const url = new URL("http://localhost:3600/api/git/push");
      const request = new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1", branch: "main" }),
      });

      const response = await handler(request, url, "POST");
      if (!response) {
        throw new Error("Expected a response");
      }
      const body = await response.json() as { remote: string; branch: string };

      expect(response.status).toBe(200);
      expect(body.remote).toBe("origin");
      expect(body.branch).toBe("main");
      expect(calls).toEqual([
        expect.objectContaining({
          directory: repoDir,
          action: "push",
          remote: "origin",
          branch: "main",
          viewerNpub: "npub1viewer",
        }),
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
