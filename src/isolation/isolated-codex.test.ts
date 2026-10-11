import { expect, test } from "bun:test";
import { runIsolatedCodex } from "./isolated-codex.ts";
import type { ProviderReply } from "./provider-policy.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletedTurnStore } from "../sessions/completed-turn-store.ts";
import { IsolatedTurnStore } from "../sessions/isolated-turn-store.ts";
import { executeCompletedTurn } from "../sessions/completed-turn-service.ts";
import { parseCompletedTurnRequest } from "../sessions/completed-turn-contract.ts";
import { createIsolatedCompletedTurnRuntime } from "../sessions/isolated-completed-turn-runtime.ts";
const image = process.env.WINGMAN_ISOLATION_NATIVE_TEST_IMAGE;
const nativeTest = image ? test : test.skip;
function response(item: Record<string, unknown>, id: string): ProviderReply {
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return { contentType: "text/event-stream", body: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") };
}
function message(text: string) {
  return { type: "message", id: "message-fixture", role: "assistant", content: [{ type: "output_text", text }] };
}

nativeTest("actual native CLI edits and resumes from private snapshots with fixture inference", async () => {
  let calls = 0;
  const first = await runIsolatedCodex(image!, { project: [], continuity: [], prompt: "Make the scoped edit", durationMs: 30000 }, {
    model: "fixture-model",
    async responses(body) {
      calls++;
      if (calls === 1) {
        const tools = body.tools as Array<{ name?: string; type: string }>;
        if (!tools.some((tool) => tool.name === "exec_command")) throw new Error(`Native command tool unavailable: ${JSON.stringify(tools.map((tool) => ({ name: tool.name, type: tool.type })))}`);
        return response({ type: "function_call", id: "fc-fixture", call_id: "call-fixture", name: "exec_command",
          arguments: JSON.stringify({ cmd: "printf isolated-native > native.txt", workdir: "/workspace", max_output_tokens: 1000 }) }, "response-fixture-1");
      }
      return response(message("continuity-marker-719"), "response-fixture-2");
    },
  });
  expect(first.project.find((file) => file.path === "native.txt")?.base64).toBe(Buffer.from("isolated-native").toString("base64"));
  expect(first.reply).toContain("continuity-marker-719");
  expect(calls).toBe(2);
  let resumed = false;
  const second = await runIsolatedCodex(image!, { project: first.project, continuity: first.continuity,
    nativeReference: first.nativeReference, prompt: "Follow-up proof", durationMs: 30000 }, {
    model: "fixture-model",
    async responses(body) {
      resumed = JSON.stringify(body.input).includes("continuity-marker-719");
      return response(message("native-second-reply"), "response-fixture-3");
    },
  });
  expect(resumed).toBe(true);
  expect(second.nativeReference).toBe(first.nativeReference);
  expect(second.reply).toContain("native-second-reply");
  console.log(JSON.stringify({ first: first.containerName, second: second.containerName, nativeReference: first.nativeReference,
    image, provider: "fixture; live model acceptance pending" }));
}, 65000);

nativeTest("actual native resume is bound to durable generic completed-turn receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-receipt-fixture-"));
  const databasePath = join(directory, "receipts.sqlite");
  let db = new Database(databasePath);
  let calls = 0;
  let historySeen = false;
  const mappings: Array<{ container: string; nativeReference: string }> = [];
  const config = { image: image!, provider: { model: "fixture-model", async responses(body: Record<string, unknown>) {
    calls++;
    if (calls === 2) historySeen = JSON.stringify(body.input).includes("durable-native-marker");
    return response(message(calls === 1 ? "durable-native-marker" : "durable-native-followup"), `durable-response-${calls}`);
  } } };
  const invoke: typeof runIsolatedCodex = async (...args) => {
    const result = await runIsolatedCodex(...args);
    mappings.push({ container: result.containerName, nativeReference: result.nativeReference });
    return result;
  };
  const runtime = createIsolatedCompletedTurnRuntime(new IsolatedTurnStore(db), config, invoke);
  let store = new CompletedTurnStore(db);
  const execute = (id: string, selectedRuntime = runtime) => executeCompletedTurn({ store, storeKey: directory,
    runtime: selectedRuntime, owner: "synthetic-owner", request: parseCompletedTurnRequest({ conversationKey: "native-conversation",
      projectId: "synthetic-project", requestId: id, prompt: `Exact ${id} prompt`, executionProfile: "isolated-codex", projectFiles: [], durationMs: 30000 }),
    runId: `fixture-run-${id}`, stepId: `fixture-step-${id}` });
  try {
    const first = await execute("one");
    expect(first).toMatchObject({ status: "completed", sessionId: null, reply: "durable-native-marker" });
    // Reopen disk state; no prepared in-memory binding survives.
    db.close();
    db = new Database(databasePath);
    store = new CompletedTurnStore(db);
    const second = await execute("two", createIsolatedCompletedTurnRuntime(new IsolatedTurnStore(db), config, invoke));
    expect(second).toMatchObject({ status: "completed", sessionId: null, executionId: first.executionId,
      nativeSessionId: first.nativeSessionId, sequence: 2, reply: "durable-native-followup" });
    expect(historySeen).toBe(true);
    expect(await execute("two")).toEqual(second);
    expect(calls).toBe(2);
    expect(JSON.stringify(second)).not.toContain("continuity");
    console.log(JSON.stringify({ mappings, first, second, provider: "fixture; hosted acceptance pending" }));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}, 65000);
