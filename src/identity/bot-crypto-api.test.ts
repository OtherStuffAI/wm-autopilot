import { describe, expect, test } from "bun:test";

import { createBotCryptoApiHandler } from "./bot-crypto-api";

describe("retired bot crypto API", () => {
  test("a live session UUID no longer authorizes cryptographic operations", async () => {
    const handler = createBotCryptoApiHandler({
      getSession: () => ({ npub: "npub1owner", status: "running" }) as never,
    });
    for (const operation of ["encrypt", "decrypt", "sign-event"]) {
      const url = new URL(`http://localhost/api/mcp/bot-crypto/${operation}`);
      const response = await handler(new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "known-live-session" }),
      }), url, "POST");
      expect(response?.status).toBe(410);
      expect(await response?.json()).toEqual({
        error: "Bot crypto API retired; use the scoped capability broker",
      });
    }
  });
});
