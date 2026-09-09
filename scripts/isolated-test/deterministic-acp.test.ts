import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PiAcpAdapter } from "../../src/agents/pi-acp-adapter";

const executable = new URL("./deterministic-acp.ts", import.meta.url).pathname;

describe("isolated deterministic process boundary", () => {
  test("refuses to run without explicit opt-in", async () => {
    const child = Bun.spawn(["bun", executable], {
      env: { PATH: process.env.PATH, WINGMAN_ISOLATED_TEST_RUNTIME: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("requires WINGMAN_ISOLATED_TEST_RUNTIME=1");
  });

  test("real ACP transport completes two distinct turns in the same session", async () => {
    const adapter = new PiAcpAdapter({
      id: "isolated-test", port: 47989, agent: "pi", host: "localhost",
      workingDirectory: "/tmp", piAcpCli: executable,
      env: { WINGMAN_ISOLATED_TEST_RUNTIME: "1" },
    });
    try {
      await adapter.waitForReady();
      await adapter.sendMessage("Human A first message");
      await adapter.sendMessage("Human B continuing message");
      const replies = (await adapter.fetchMessages()).filter((message) => message.role === "assistant");
      expect(replies.map((reply) => reply.content)).toEqual(
        ["Human A first message", "Human B continuing message"].map((prompt) =>
          `Isolated release test reply. Prompt SHA-256: ${createHash("sha256").update(prompt).digest("hex")}`),
      );
      expect((await adapter.getPromptReadiness()).state).toBe("ready");
    } finally {
      await adapter.dispose();
    }
  });
});
