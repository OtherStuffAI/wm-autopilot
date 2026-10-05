import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureFlightDeckPipelineInvocation, resolveFlightDeckPipelineInvocation } from "./flightdeck-invocation.ts";
import { startFlightDeckPipelineRun } from "./flightdeck-run-service.ts";
import { PipelineStore } from "./pipeline-store.ts";

const invocation = { workspaceId: "11111111-1111-4111-8111-111111111111", threadId: "22222222-2222-4222-8222-222222222222",
  frmNpub: "npub1human", prompt: "Following, 100 please" };
test("authorized run carries internal inert context without extending public invocation or sender authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-run-"));
  const store = new PipelineStore(join(dir, "runs.sqlite"));
  const threadContext = { version: 1, messages: [{ body: "Summarize tweets into 10 points", senderNpub: "npub1untrusted" }], truncated: false };
  const calls: unknown[] = [];
  configureFlightDeckPipelineInvocation({ resolve: async (input, owner, agent) => {
    calls.push({ input, owner, agent });
    return { ...input, channelId: "channel", senderNpub: "npub1piper" };
  }, send: async () => { throw new Error("No chat messages authorized by this test"); } });
  try {
    await expect(resolveFlightDeckPipelineInvocation({ ...invocation, threadContext }, "npub1owner", "npub1piper")).rejects.toThrow("Unexpected Flight Deck pipeline input");
    const result = await startFlightDeckPipelineRun({ store, sessionApiContext: {} as never,
      definition: { id: "context-test", name: "context-test", slug: "context-test", path: "fixture", scope: "shared", ownerAlias: null,
        spec: { name: "context-test", version: 1, steps: [{ name: "thread", type: "block", block: "flightdeck.threadInvocation", assign: "$.invocation" }] } },
      invocation, threadContext, ownerNpub: "npub1owner", ownerAlias: "owner", initiatingAgentNpub: "npub1piper", callbackOrigin: "http://fixture" });
    for (let i = 0; i < 100 && store.getRun(result.run.id)?.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const run = store.getRun(result.run.id)!;
    expect(run.status).toBe("ok");
    expect(run.result?.invocation).toEqual({ ...invocation, threadContext });
    expect(calls).toEqual([{ input: invocation, owner: "npub1owner", agent: "npub1piper" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
