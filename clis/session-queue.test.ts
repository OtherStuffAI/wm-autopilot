import { describe, expect, test } from "bun:test";
import { runSessionQueueCli } from "./session-queue";

describe("session queue CLI", () => {
  test("defaults to exact SESSION_ID without listing sessions and prints IDs/revisions intact", async () => {
    const calls: unknown[][] = [];
    const output: string[] = [];
    const deps = { env: { SESSION_ID: "current-session", WINGMAN_URL: "http://localhost:3600" },
      request: async (...args: unknown[]) => { calls.push(args); return { queue: { prompts: [{ id: "full-id", revision: "12" }] } }; },
      stdout: (text: string) => output.push(text) };
    await runSessionQueueCli(["list"], deps);
    await runSessionQueueCli(["acknowledge", "full-id", "--revision", "12", "--reason", "Handled in active turn"], deps);
    expect(calls).toEqual([
      ["http://localhost:3600", "GET", "/api/sessions/current-session/queue"],
      ["http://localhost:3600", "POST", "/api/sessions/current-session/queue/full-id/acknowledge", { revision: "12", reason: "Handled in active turn" }],
    ]);
    expect(JSON.parse(output[0]!).queue.prompts[0]).toEqual({ id: "full-id", revision: "12" });
  });
  test("requires a read revision and reason and refuses raw signing options", async () => {
    for (const args of [["acknowledge", "id", "--reason", "handled"], ["acknowledge", "id", "--revision", "1"], ["list", "--key", "value"]]) {
      await expect(runSessionQueueCli(args, { env: { SESSION_ID: "self" } })).rejects.toThrow();
    }
  });
});

test("reconcile carries exact version and claim identity and requires explicit retry decision", async () => {
  let call: unknown[] = [];
  const deps = { env: { SESSION_ID: "self" }, request: async (...args: unknown[]) => { call = args; return {}; }, stdout: () => {} };
  await runSessionQueueCli(["reconcile", "id", "--revision", "2", "--claim-token", "token", "--resolution", "retry", "--reason", "receiver inspected; accept duplicate risk"], deps);
  expect(call.slice(1)).toEqual(["POST", "/api/sessions/self/queue/id/reconcile", { revision: "2", reason: "receiver inspected; accept duplicate risk", claimToken: "token", resolution: "retry" }]);
  await expect(runSessionQueueCli(["reconcile", "id", "--revision", "2", "--reason", "no decision"], deps)).rejects.toThrow();
});

test("consume explicitly incorporates the exact read revision without exposing raw signing", async () => {
  const calls: unknown[] = [];
  await runSessionQueueCli(["consume", "item", "--revision", "3", "--reason", "Incorporated current steering"], {
    env: { SESSION_ID: "self" }, stdout: () => {},
    request: async (...args) => { calls.push(args); return {}; },
  });
  expect(calls).toEqual([["http://127.0.0.1:3600", "POST", "/api/sessions/self/queue/item/consume",
    { revision: "3", reason: "Incorporated current steering" }]]);
});
