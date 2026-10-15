import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentApiProvenancePath } from "./agentapi-build";
import { captureRuntimeIdentity } from "./runtime-identity";

describe("captureRuntimeIdentity", () => {
  test("separates the Bun controller revision from the AgentAPI sidecar identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-runtime-identity-"));
    const binaryPath = join(root, "out", "agentapi");
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(binaryPath, "agentapi");
    await writeFile(getAgentApiProvenancePath(binaryPath), JSON.stringify({
      upstream_commit: "agentapi-commit",
      sha256: "binary-sha",
    }));

    const identity = await captureRuntimeIdentity(root, binaryPath, {
      now: new Date("2026-10-15T07:45:00.000Z"),
      readGit: async (args) => args[0] === "rev-parse" ? "controller-commit" : "",
    });

    expect(identity).toMatchObject({
      controller: {
        execution: "bun-source",
        entrypoint: "src/index.ts",
        gitCommit: "controller-commit",
        sourceState: "clean",
        startedAt: "2026-10-15T07:45:00.000Z",
      },
      agentApi: {
        role: "agent-session-transport",
        upstreamCommit: "agentapi-commit",
        sha256: "binary-sha",
      },
    });
  });
});
