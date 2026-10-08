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

test("avatar click dispatches Secrets through SPA navigation and denies guests", async () => {
  const { createNavigation } = await import("../navigation/navigation.js");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let click;
  let route = "home";
  let loginRequests = 0;
  let renders = 0;
  const transitions = [];
  const state = { identity: { authenticated: true } };
  try {
    globalThis.window = {
      location: { pathname: "/home" },
      history: { pushState: (entry, _title, path) => transitions.push({ entry, path }) },
      addEventListener() {},
    };
    globalThis.document = { querySelectorAll: () => [], addEventListener() {} };
    createNavigation({
      state,
      navLinks: [{ dataset: { route: "secrets" }, addEventListener: (_event, handler) => { click = handler; } }],
      getCurrentRoute: () => route,
      setCurrentRoute: (next) => { route = next; },
      openIdentityLoginDialog: () => { loginRequests++; },
      closeIdentityLoginDialog() {},
      closeMenu() {},
      deactivateLiveSessionRefresh() {},
      setLastLoggedSessionId() {},
      render: () => { renders++; },
    }).setupNavListeners();
    let prevented = false;
    click({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(route).toBe("secrets");
    expect(transitions).toEqual([{ entry: { route: "secrets" }, path: "/secrets" }]);
    expect(renders).toBe(1);
    route = "home";
    state.identity.authenticated = false;
    click({ preventDefault() {} });
    expect(loginRequests).toBe(1);
    expect(route).toBe("home");
    expect(transitions).toHaveLength(1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
