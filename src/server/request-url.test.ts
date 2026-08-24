import { describe, expect, test } from "bun:test";

import {
  configuredPublicRequestUrl,
  forwardedRequestUrl,
  resolveHttpsRedirectUrl,
} from "./request-url";

describe("request URL helpers", () => {
  test("builds the public URL from forwarded headers", () => {
    const request = new Request("http://127.0.0.1:3600/live?session=1", {
      headers: {
        "x-forwarded-host": "agent.example.invalid",
        "x-forwarded-proto": "https",
      },
    });

    expect(forwardedRequestUrl(request, new URL(request.url)).toString()).toBe("https://agent.example.invalid/live?session=1");
  });

  test("uses Cloudflare visitor scheme when forwarded proto is absent", () => {
    const request = new Request("http://agent.example.invalid/live", {
      headers: {
        "cf-visitor": '{"scheme":"https"}',
      },
    });

    expect(forwardedRequestUrl(request, new URL(request.url)).toString()).toBe("https://agent.example.invalid/live");
  });

  test("builds configured public request URLs from the public base", () => {
    const url = configuredPublicRequestUrl(
      new URL("http://127.0.0.1:3600/api/auth/session?fresh=1"),
      "https://agent.example.invalid",
    );

    expect(url?.toString()).toBe("https://agent.example.invalid/api/auth/session?fresh=1");
  });

  test("redirects public HTTP requests to the configured HTTPS host", () => {
    const request = new Request("http://agent.example.invalid/live?session=1");

    expect(resolveHttpsRedirectUrl(request, new URL(request.url), "https://agent.example.invalid")).toBe(
      "https://agent.example.invalid/live?session=1",
    );
  });

  test("redirects proxied public HTTP requests", () => {
    const request = new Request("http://127.0.0.1:3600/live", {
      headers: {
        "x-forwarded-host": "agent.example.invalid",
        "x-forwarded-proto": "http",
      },
    });

    expect(resolveHttpsRedirectUrl(request, new URL(request.url), "https://agent.example.invalid")).toBe(
      "https://agent.example.invalid/live",
    );
  });

  test("does not redirect HTTPS requests", () => {
    const request = new Request("http://127.0.0.1:3600/live", {
      headers: {
        "x-forwarded-host": "agent.example.invalid",
        "x-forwarded-proto": "https",
      },
    });

    expect(resolveHttpsRedirectUrl(request, new URL(request.url), "https://agent.example.invalid")).toBeNull();
  });

  test("does not redirect local development requests for a different configured host", () => {
    const request = new Request("http://localhost:3600/live");

    expect(resolveHttpsRedirectUrl(request, new URL(request.url), "https://agent.example.invalid")).toBeNull();
  });
});
