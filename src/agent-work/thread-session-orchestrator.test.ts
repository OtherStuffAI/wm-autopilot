import { describe, expect, test } from "bun:test";
import { ensureThreadSessionRoute } from "./thread-session-orchestrator";

describe("ensureThreadSessionRoute", () => {
  test("creates, binds, verifies, and posts exactly once", async () => {
    const calls: string[] = [];
    const deps = {
      createThread: async () => { calls.push("thread"); return { threadId: "thread-1" }; },
      createSession: async () => { calls.push("session"); return { sessionId: "session-1" }; },
      bindSession: async () => { calls.push("bind"); },
      readBinding: async () => { calls.push("verify"); return { bindingType: "thread", bindingId: "thread-1" }; },
      postReviewMessage: async () => { calls.push("message"); return { messageId: "message-1" }; },
    };
    const first = await ensureThreadSessionRoute({}, deps);
    expect(first.bindingVerified).toBe(true);
    expect(calls).toEqual(["thread", "session", "bind", "verify", "message"]);

    calls.length = 0;
    const second = await ensureThreadSessionRoute(first, deps);
    expect(second.created).toEqual({ thread: false, session: false, reviewMessage: false });
    expect(calls).toEqual(["verify"]);
  });

  test("compensates a newly-created session when verification fails", async () => {
    const compensated: string[] = [];
    await expect(ensureThreadSessionRoute({}, {
      createThread: async () => ({ threadId: "thread-1" }),
      createSession: async () => ({ sessionId: "session-1" }),
      bindSession: async () => undefined,
      readBinding: async () => ({ bindingType: "thread", bindingId: "wrong" }),
      postReviewMessage: async () => ({ messageId: "message-1" }),
      compensateSession: async (id) => { compensated.push(id); },
    })).rejects.toThrow("binding verification failed");
    expect(compensated).toEqual(["session-1"]);
  });
});
