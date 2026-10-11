import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletedTurnStore } from "./completed-turn-store.ts";
import { IsolatedTurnStore } from "./isolated-turn-store.ts";
import { executeCompletedTurn } from "./completed-turn-service.ts";
import { parseCompletedTurnRequest } from "./completed-turn-contract.ts";
import { createIsolatedCompletedTurnRuntime, isolatedTurnConfiguration } from "./isolated-completed-turn-runtime.ts";
import type { runIsolatedCodex } from "../isolation/isolated-codex.ts";
import type { ProjectFile } from "../isolation/project-profile.ts";

let directory: string;
let db: Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "isolated-turns-"));
  db = new Database(join(directory, "turns.sqlite"));
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const image = `sha256:${"a".repeat(64)}`;
const nativeId = "11111111-2222-3333-4444-555555555555";
const file = (path: string, text: string): ProjectFile => ({ path, base64: Buffer.from(text).toString("base64") });
const request = (id = "one") => parseCompletedTurnRequest({ conversationKey: "conversation", projectId: "project",
  requestId: id, prompt: `  ${id}\nexact  `, executionProfile: "isolated-codex", projectFiles: [file("index.html", id)] });
function fixture(run?: typeof runIsolatedCodex) {
  const receipts = new CompletedTurnStore(db);
  const native = new IsolatedTurnStore(db);
  const calls: Array<{ prompt: string; nativeReference?: string; continuity: ProjectFile[] }> = [];
  const invoke: typeof runIsolatedCodex = run ?? (async (selectedImage, input, provider) => {
    expect(selectedImage).toBe(image);
    expect(provider.model).toBe("fixture-model");
    calls.push(input);
    return { containerName: `actual-container-${calls.length}`, image, exitCode: 0, stdout: "", stderr: "",
      project: [file("index.html", `edited ${input.prompt}`)], continuity: [file(".codex/sessions/native.jsonl", "PRIVATE native history")],
      nativeReference: input.nativeReference ?? nativeId, reply: `final ${input.prompt}` };
  });
  const runtime = createIsolatedCompletedTurnRuntime(native, { image, provider: { model: "fixture-model", responses: async () => { throw new Error("unused fixture provider"); } } }, invoke);
  const execute = (id = "one") => executeCompletedTurn({ store: receipts, storeKey: directory, runtime, owner: "owner",
    request: request(id), runId: `run-${id}`, stepId: `step-${id}` });
  return { execute, runtime, native, receipts, calls };
}

test("isolated runtime carries exact ordered prompts and private native resume with no fake session", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.execute(), f.execute("two")]);
  expect(first).toMatchObject({ status: "completed", sessionId: null, nativeSessionId: nativeId, executionId: expect.any(String) });
  expect(second).toMatchObject({ status: "completed", executionId: first.executionId, sessionId: null, nativeSessionId: nativeId, sequence: 2 });
  expect(f.calls.map((call) => call.prompt)).toEqual(["  one\nexact  ", "  two\nexact  "]);
  expect(f.calls[0]!.nativeReference).toBeUndefined();
  expect(f.calls[1]!.nativeReference).toBe(nativeId);
  expect(f.calls[1]!.continuity[0]?.path).toBe(".codex/sessions/native.jsonl");
  expect(JSON.stringify(second)).not.toContain("PRIVATE native history");
  expect(second.output).toMatchObject({ executionProfile: "isolated-codex", projectFiles: expect.any(Array) });
  expect(await f.execute("two")).toEqual(second);
  expect(f.calls).toHaveLength(2);
});

test("isolated completion and snapshots survive reopen and recover lost generic receipt without resending", async () => {
  const f = fixture();
  const first = await f.execute();
  // Simulate loss of generic receipt persistence after private native completion persisted.
  db.query("UPDATE completed_turn_receipts SET status='uncertain',reply=NULL,outputJson=NULL WHERE receiptId=?").run(first.receiptId);
  const reopened = new Database(join(directory, "turns.sqlite"));
  try {
    const runtime = createIsolatedCompletedTurnRuntime(new IsolatedTurnStore(reopened), { image,
      provider: { model: "fixture-model", responses: async () => { throw new Error("No resend allowed"); } } },
      async () => { throw new Error("No new native process allowed"); });
    const recovered = await executeCompletedTurn({ store: new CompletedTurnStore(reopened), storeKey: directory,
      runtime, owner: "owner", request: request(), runId: "retry", stepId: "retry-step" });
    expect(recovered).toEqual(first);
    expect(f.calls).toHaveLength(1);
  } finally { reopened.close(); }
});

test("uncertain isolated native side effect blocks later requests and cannot restore from model assertions", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error("Container outcome uncertain"); });
  const first = await f.execute();
  expect(first).toMatchObject({ status: "uncertain", sessionId: null, reply: null });
  expect(await f.execute()).toMatchObject({ status: "uncertain", receiptId: first.receiptId });
  expect(await f.execute("two")).toMatchObject({ status: "queued", blockedBy: first.receiptId });
  expect(calls).toBe(1);
});

test("profile denies host sessions, changed models/images and cross-owner recovery", async () => {
  const f = fixture();
  expect(() => parseCompletedTurnRequest({ ...request(), sessionId: "host-session" })).toThrow("no Wingman session");
  await expect(f.runtime.authorize({ ...request(), model: "other" }, "owner")).rejects.toThrow("model selection denied");
  const first = await f.execute();
  const changed = createIsolatedCompletedTurnRuntime(f.native, { image: `sha256:${"b".repeat(64)}`,
    provider: { model: "fixture-model", responses: async () => { throw new Error("unused"); } } });
  const second = await executeCompletedTurn({ store: f.receipts, storeKey: directory, runtime: changed, owner: "owner",
    request: request("two"), runId: "two", stepId: "two" });
  expect(second).toMatchObject({ status: "preparing", error: expect.stringContaining("image/model binding changed") });
  const row = f.receipts.get(first.receiptId)!;
  await expect(f.runtime.recover({ ...row, owner: "other" })).rejects.toThrow("ownership denied");
});

test("missing dedicated runtime configuration cannot borrow ambient provider credentials", () => {
  expect(() => isolatedTurnConfiguration({ OPENAI_API_KEY: "synthetic unrelated key", CODEX_API_KEY: "synthetic unrelated key" })).toThrow("dedicated authorized WINGMAN_ISOLATED_CODEX_API_KEY");
  expect(() => isolatedTurnConfiguration({ WINGMAN_ISOLATED_CODEX_IMAGE: "latest", WINGMAN_ISOLATED_CODEX_MODEL: "fixture",
    WINGMAN_ISOLATED_CODEX_API_KEY: "synthetic dedicated" })).toThrow("Invalid isolated");
});
