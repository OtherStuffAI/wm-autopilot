import { describe, expect, mock, test } from "bun:test";
import { handleSessionDispatchApi } from "./session-dispatch-routes";

describe("session dispatch inbox API", () => {
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
