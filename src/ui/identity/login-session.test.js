import { describe, expect, test } from "bun:test";

import { createLoginEventTemplate, persistServerSession } from "./login-session.js";

describe("login session", () => {
  test("binds the server challenge into the login event", () => {
    const event = createLoginEventTemplate("single-use-nonce", "https://wingman.example/home");

    expect(event.content).toBe("single-use-nonce");
    expect(event.tags).toContainEqual(["u", "https://wingman.example/api/auth/session"]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual(["purpose", "wingman-login"]);
    expect(event.tags).toContainEqual(["challenge", "single-use-nonce"]);
  });

  test("fetches a challenge, signs it, and submits the signed login", async () => {
    const requests = [];
    const signedEvents = [];
    const fetchImpl = async (input, init) => {
      requests.push({ input, init });
      if (input === "/api/auth/challenge") {
        return Response.json({ challenge: "single-use-nonce", expiresAt: Date.now() + 60_000 });
      }
      return Response.json({ expiresAt: 12345 });
    };
    const signEvent = async (event) => {
      signedEvents.push(event);
      return { ...event, id: "event-id", pubkey: "pubkey", sig: "signature" };
    };

    const result = await persistServerSession("npub1example", null, signEvent, {
      fetchImpl,
      pageUrl: "https://wingman.example/home",
    });

    expect(result).toEqual({ expiresAt: 12345 });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.input).toBe("/api/auth/challenge");
    expect(signedEvents[0]?.content).toBe("single-use-nonce");
    const loginBody = JSON.parse(requests[1]?.init?.body);
    expect(loginBody.challenge).toBe("single-use-nonce");
    expect(loginBody.signedEvent.content).toBe("single-use-nonce");
  });

  test("refuses to authenticate without a signer", async () => {
    await expect(persistServerSession("npub1example", null, null)).rejects.toThrow("A login signer is required");
  });
});
