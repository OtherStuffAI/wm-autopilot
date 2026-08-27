import { describe, expect, test } from "bun:test";

import {
  applyBrowserSecurityHeaders,
  createBrowserSecurityHeadersContext,
} from "./browser-security-headers";

describe("browser security header policy", () => {
  test("keeps control-plane responses unframeable", () => {
    const response = applyBrowserSecurityHeaders(
      new Response("Autopilot", {
        headers: { "X-Frame-Options": "SAMEORIGIN" },
      }),
      "control-plane",
    );

    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("defaults managed apps to same-origin framing", () => {
    const response = applyBrowserSecurityHeaders(new Response("WApp"), "managed-app");

    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("X-Frame-Options")).not.toBeNull();
  });

  test("adds the managed-app default alongside a CSP without frame-ancestors", () => {
    const response = applyBrowserSecurityHeaders(
      new Response("WApp", {
        headers: { "Content-Security-Policy": "default-src 'self'" },
      }),
      "managed-app",
    );

    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  test("preserves an upstream managed app X-Frame-Options policy", () => {
    const response = applyBrowserSecurityHeaders(
      new Response("WApp", {
        headers: { "X-Frame-Options": "DENY" },
      }),
      "managed-app",
    );

    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("preserves an upstream managed app CSP frame-ancestors policy", () => {
    const response = applyBrowserSecurityHeaders(
      new Response("WApp", {
        headers: { "Content-Security-Policy": "default-src 'self'; frame-ancestors https://review.example" },
      }),
      "managed-app",
    );

    expect(response.headers.get("Content-Security-Policy"))
      .toBe("default-src 'self'; frame-ancestors https://review.example");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  test("keeps shared browser protections on both security boundaries", () => {
    for (const boundary of ["control-plane", "managed-app"] as const) {
      const response = applyBrowserSecurityHeaders(new Response(), boundary);

      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("Permissions-Policy"))
        .toBe("camera=(), microphone=(), geolocation=()");
    }
  });

  test.each([
    ["hostname/subdomain", "hostname"],
    ["/host/<alias>", "path"],
  ] as const)(
    "%s managed-app proxy uses the same frame policy",
    (_label, proxyForm) => {
      const securityHeaders = createBrowserSecurityHeadersContext();
      const proxiedResponse = securityHeaders.markManagedAppResponse(new Response("WApp"), proxyForm);
      const response = securityHeaders.apply(proxiedResponse);

      expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    },
  );
});
