import { afterEach, describe, expect, mock, test } from "bun:test";
import { runDispatchCli } from "./dispatch";

describe("dispatch CLI inbox", () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  afterEach(() => { globalThis.fetch = originalFetch; console.log = originalLog; });

  test("reads the exact SESSION_ID inbox", async () => {
    const fetchMock = mock(async () => Response.json({ callbacks: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    console.log = mock(() => {});
    expect(await runDispatchCli(["inbox"], { WINGMAN_URL: "http://wingman.test", SESSION_ID: "session-1" } as any)).toBe(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://wingman.test/api/session-dispatches/inbox");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      "x-wingman-session-id": "session-1",
    });
  });
});
