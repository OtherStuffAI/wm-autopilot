import { describe, expect, mock, test } from "bun:test";
import { handleSessionDispatchApi } from "./session-dispatch-routes";

describe("session dispatch inbox API", () => {
  test("requires caller identity even when a monitored callback is explicitly supplied", async () => {
    const request = new Request("http://localhost/api/session-dispatches", { method: "POST",
      body: JSON.stringify({ callback: { sessionId: "other" }, prompt: "Work" }) });
    expect((await handleSessionDispatchApi(request, new URL(request.url), "POST", {} as any))?.status).toBe(400);
  });
  test("passes caller separately from a supplied callback and reporting hints", async () => {
    const create = mock(async () => ({ dispatchId: "dispatch" }));
    const request = new Request("http://localhost/api/session-dispatches", { method: "POST",
      headers: { "x-wingman-session-id": "caller", "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", prompt: "Work", callback: { sessionId: "parent" },
        reportingContext: { ownerNpub: "forged" } }) });
    const response = await handleSessionDispatchApi(request, new URL(request.url), "POST", { create } as any);
    expect(response?.status).toBe(201);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ callerSessionId: "caller", callbackSessionId: "parent" });
  });
  test("routes the exact calling session to the inbox service", async () => {
    const getInbox = mock((sessionId: string) => ({ callbacks: [{ dispatchId: "dispatch-1" }],
      wake: null, inboxFingerprint: "fingerprint" }));
    const service = { getInbox } as any;
    const request = new Request("http://localhost/api/session-dispatches/inbox", {
      headers: { "x-wingman-session-id": "supervisor-session" },
    });
    const response = await handleSessionDispatchApi(request, new URL(request.url), "GET", service);
    expect(response?.status).toBe(200);
    expect(getInbox).toHaveBeenCalledWith("supervisor-session");
    expect(await response?.json()).toMatchObject({ callbacks: [{ dispatchId: "dispatch-1" }] });
  });

  test("requires a session identity for inbox access", async () => {
    const request = new Request("http://localhost/api/session-dispatches/inbox?sessionId=another-session");
    const response = await handleSessionDispatchApi(request, new URL(request.url), "GET", {} as any);
    expect(response?.status).toBe(400);
  });
});
