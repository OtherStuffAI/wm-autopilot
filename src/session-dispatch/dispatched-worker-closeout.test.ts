import { describe, expect, test } from "bun:test";
import { closeDispatchedWorker } from "./dispatched-worker-closeout";

describe("closeDispatchedWorker", () => {
  test("stops a running worker before scheduling its archive", async () => {
    const calls: string[] = [];
    const manager = {
      getSession: () => ({ status: "running" }),
      stopSession: async (sessionId: string) => { calls.push(`stop:${sessionId}`); },
    } as any;

    await closeDispatchedWorker("worker", manager, (sessionId) => calls.push(`archive:${sessionId}`));

    expect(calls).toEqual(["stop:worker", "archive:worker"]);
  });

  test("does not schedule an archive when the worker is already absent", async () => {
    const calls: string[] = [];
    const manager = { getSession: () => undefined } as any;

    await closeDispatchedWorker("worker", manager, (sessionId) => calls.push(sessionId));

    expect(calls).toEqual([]);
  });
});
