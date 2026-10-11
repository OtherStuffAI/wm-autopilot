import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "../pipelines/pipeline-store.ts";
import { createIsolatedCompletedTurnRuntime } from "./isolated-completed-turn-runtime.ts";
import { parseCompletedTurnRequest } from "./completed-turn-contract.ts";
import { executeCompletedTurn } from "./completed-turn-service.ts";
import type { ProjectProvider } from "../isolation/provider-policy.ts";

// Explicit fixture-only image: this never reads a credential or calls a real model.
const image = process.env.WINGMAN_ISOLATION_NATIVE_TEST_IMAGE;
const nativeTest = image ? test : test.skip;

nativeTest("durable completed turns use actual isolated CLI native resume and exact prompts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "completed-native-cli-"));
  const path = join(directory, "pipeline.sqlite");
  const prompts = ["  First exact prompt\nmarker-639  ", "  Second exact prompt\nmarker-920  "];
  const calls: Record<string, unknown>[] = [];
  const provider: ProjectProvider = {
    model: "fixture-model",
    responses: async (body) => {
      calls.push(body);
      const id = `response-fixture-${calls.length}`;
      const item = { type: "message", id: `message-fixture-${calls.length}`, role: "assistant",
        content: [{ type: "output_text", text: `native-continuity-reply-${calls.length}` }] };
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      return { contentType: "text/event-stream", body: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") };
    },
  };
  function run(index: number) {
    // Reopening simulates a stopped host executor, while actual containers exit each turn.
    const store = new PipelineStore(path);
    const request = parseCompletedTurnRequest({ conversationKey: "native-fixture", projectId: "project-fixture",
      requestId: `request-${index}`, prompt: prompts[index], executionProfile: "isolated-codex", projectFiles: [], durationMs: 30000 });
    return executeCompletedTurn({ store: store.completedTurns, storeKey: path,
      runtime: createIsolatedCompletedTurnRuntime(store.isolatedTurns, { image: image!, provider }),
      owner: "fixture-owner", request, runId: `run-${index}`, stepId: `step-${index}` });
  }
  try {
    const first = await run(0);
    expect(first.status).toBe("completed");
    const retry = await run(0);
    expect(retry).toEqual(first);
    expect(calls).toHaveLength(1);
    const second = await run(1);
    expect(second).toMatchObject({ status: "completed", executionId: first.executionId, sessionId: null,
      nativeSessionId: first.nativeSessionId, requestId: "request-1", runId: "run-1", sequence: 2 });
    expect(calls).toHaveLength(2);
    for (let index = 0; index < calls.length; index++) {
      const input = calls[index]!.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
      expect(input.some((item) => item.role === "user" && item.content?.some((part) => part.text === prompts[index]))).toBe(true);
    }
    expect(JSON.stringify(calls[1]!.input)).toContain("native-continuity-reply-1");
    console.log(JSON.stringify({ image, provider: "synthetic fixture; no live model", first, second }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 65000);
