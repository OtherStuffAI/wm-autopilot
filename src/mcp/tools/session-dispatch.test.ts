import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleSessionDispatch, sessionDispatchDescription, sessionDispatchSchema } from "./session-dispatch";

describe("session_dispatch inbox action", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("requests the calling session's exact inbox", async () => {
    const fetchMock = mock(async () => Response.json({ callbacks: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await handleSessionDispatch({ action: "inbox" }, "http://wingman.test", "session-1");
    expect(result.isError).toBeFalse();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://wingman.test/api/session-dispatches/inbox");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET",
      headers: { "x-wingman-session-id": "session-1" } });
    expect(sessionDispatchSchema.action.safeParse("inbox").success).toBeTrue();
    expect(sessionDispatchDescription).toContain("exact session's callback inbox");
  });
});
