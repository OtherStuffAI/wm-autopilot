import { describe, expect, test } from "bun:test";

import { uploadBlossomObject } from "./blossom-client";

describe("broker-authorized Blossom upload", () => {
  test("binds authorization to the exact bytes before uploading to the allowed origin", async () => {
    const requests: Request[] = [];
    const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const request = new Request(requestUrl, init);
      requests.push(request);
      if (request.url.includes("/api/mcp/capabilities/blossom/authorize")) {
        return Response.json({ authorization: "Nostr fake-bounded-authorization" });
      }
      return Response.json({ url: "https://blossom.example/object" });
    }, { preconnect: () => undefined }) as typeof fetch;
    const bytes = new TextEncoder().encode("bounded blossom object");

    const result = await uploadBlossomObject({
      server: "https://blossom.example/path-is-ignored",
      bytes,
      contentType: "text/plain",
      context: { wingmanUrl: "http://localhost:3600", sessionId: "session-a", capabilityToken: "opaque", fetch: fetchImpl },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("http://localhost:3600/api/mcp/capabilities/blossom/authorize");
    const brokerBody = await requests[0]!.json() as Record<string, unknown>;
    expect(brokerBody).toMatchObject({ server: "https://blossom.example", method: "upload", objectSize: bytes.byteLength, sessionId: "session-a" });
    expect(brokerBody.objectHash).toBe(result.objectHash);
    expect(requests[1]!.url).toBe("https://blossom.example/upload");
    expect(requests[1]!.method).toBe("PUT");
    expect(requests[1]!.headers.get("authorization")).toBe("Nostr fake-bounded-authorization");
    expect(Buffer.from(await requests[1]!.arrayBuffer()).toString("utf8")).toBe("bounded blossom object");
  });
});
