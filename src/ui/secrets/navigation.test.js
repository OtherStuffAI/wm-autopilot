import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isProtectedRoute, resolveRouteForAuth } from "../core/auth-route-guard.js";
import { shouldFullRenderOnSessionUpdate } from "../core/app-renderer.js";

test("avatar navigates to Secrets and keeps active sessions out of the menu", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(html).toContain('href="/secrets" data-route="secrets" aria-label="Manage secrets" data-testid="nav-secrets"');
  expect(html).not.toContain('id="menu-tabs"');
  expect(html).toContain('href="/live" data-route="live"');
});

test("Secrets stays protected and session updates preserve an unfinished credential form", () => {
  expect(isProtectedRoute("secrets")).toBe(true);
  expect(resolveRouteForAuth("secrets", { authenticated: false, authResolved: true })).toBe("home");
  expect(shouldFullRenderOnSessionUpdate("secrets")).toBe(false);
});
