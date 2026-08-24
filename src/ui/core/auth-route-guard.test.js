import { describe, expect, test } from "bun:test";

import {
  isProtectedRoute,
  resolveRouteForAuth,
  shouldHoldProtectedRoute,
} from "./auth-route-guard.js";

describe("auth route guard", () => {
  test("classifies session and app surfaces as protected", () => {
    expect(isProtectedRoute("live")).toBe(true);
    expect(isProtectedRoute("apps")).toBe(true);
    expect(isProtectedRoute("files")).toBe(true);
    expect(isProtectedRoute("pipelines")).toBe(true);
  });

  test("leaves public routes available while logged out", () => {
    expect(isProtectedRoute("home")).toBe(false);
    expect(isProtectedRoute("privacy")).toBe(false);
    expect(isProtectedRoute("settings")).toBe(false);
  });

  test("holds protected routes while auth restoration is unresolved", () => {
    expect(shouldHoldProtectedRoute("live", { authenticated: false, authResolved: false })).toBe(true);
    expect(resolveRouteForAuth("live", { authenticated: false, authResolved: false })).toBe("live");
  });

  test("redirects protected routes after auth resolves logged out", () => {
    expect(resolveRouteForAuth("live", { authenticated: false, authResolved: true })).toBe("home");
    expect(resolveRouteForAuth("pipelines", { authenticated: false, authResolved: true })).toBe("home");
  });

  test("keeps protected routes when authenticated", () => {
    expect(shouldHoldProtectedRoute("live", { authenticated: true, authResolved: false })).toBe(false);
    expect(resolveRouteForAuth("live", { authenticated: true, authResolved: true })).toBe("live");
  });
});
