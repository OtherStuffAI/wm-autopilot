import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { shouldUseSecureCookies } from "./cookie-security";

const ORIGINAL_IDENTITY_COOKIE_SECURE = Bun.env.IDENTITY_COOKIE_SECURE;
const ORIGINAL_COOKIE_SECURE = Bun.env.COOKIE_SECURE;

const restoreEnv = () => {
  if (typeof ORIGINAL_IDENTITY_COOKIE_SECURE === "undefined") {
    delete Bun.env.IDENTITY_COOKIE_SECURE;
  } else {
    Bun.env.IDENTITY_COOKIE_SECURE = ORIGINAL_IDENTITY_COOKIE_SECURE;
  }

  if (typeof ORIGINAL_COOKIE_SECURE === "undefined") {
    delete Bun.env.COOKIE_SECURE;
  } else {
    Bun.env.COOKIE_SECURE = ORIGINAL_COOKIE_SECURE;
  }
};

afterEach(() => {
  restoreEnv();
});

beforeEach(() => {
  delete Bun.env.IDENTITY_COOKIE_SECURE;
  delete Bun.env.COOKIE_SECURE;
});

describe("shouldUseSecureCookies", () => {
  test("uses insecure cookies for plain http requests by default", () => {
    const request = new Request("http://localhost:3600/api/auth/session");

    expect(shouldUseSecureCookies(request)).toBe(false);
  });

  test("uses secure cookies for proxied https requests", () => {
    const request = new Request("http://localhost:3600/api/auth/session", {
      headers: {
        "x-forwarded-proto": "https",
      },
    });

    expect(shouldUseSecureCookies(request)).toBe(true);
  });

  test("honors explicit secure-cookie override", () => {
    Bun.env.IDENTITY_COOKIE_SECURE = "true";
    const request = new Request("http://localhost:3600/api/auth/session");

    expect(shouldUseSecureCookies(request)).toBe(true);
  });
});
