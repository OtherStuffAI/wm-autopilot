import { describe, expect, test } from "bun:test";

import {
  INSECURE_SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
  mintSessionCookie,
  readSessionCookie,
} from "./session-cookie";

const TEST_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
const TEST_NPUB = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqshp52w2";

if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Object.defineProperty(Bun.env, "IDENTITY_SESSION_SECRET", {
    value: TEST_SECRET,
    writable: true,
    configurable: true,
  });
  process.env.IDENTITY_SESSION_SECRET = TEST_SECRET;
}

describe("session cookies", () => {
  test("mints host-prefixed secure cookies for HTTPS deployments", () => {
    const { cookie } = mintSessionCookie(TEST_NPUB, { secure: true });

    expect(cookie).toStartWith(`${SECURE_SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("; Secure");
  });

  test("mints non-prefixed cookies for local HTTP deployments", () => {
    const { cookie } = mintSessionCookie(TEST_NPUB, { secure: false });

    expect(cookie).toStartWith(`${INSECURE_SESSION_COOKIE_NAME}=`);
    expect(cookie).not.toContain("; Secure");
  });

  test("reads local HTTP session cookies", () => {
    const { cookie } = mintSessionCookie(TEST_NPUB, { secure: false });
    const payload = readSessionCookie(cookie);

    expect(payload?.npub).toBe(TEST_NPUB);
  });
});
