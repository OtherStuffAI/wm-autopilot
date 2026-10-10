import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { createProjectStaticAssetService } from "../src/server/static-assets";
import { isSpaRoutePath, serveIndex } from "../src/server/static-routes";

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const suite = playwrightModule ? describe : describe.skip;

// Real HTML, app.js, navigation, renderer and identity UI updates.
// Network services and the auth adapter are synthetic; no production cookies or keys.
suite("Secrets full SPA navigation", () => {
  let browser: any;
  let server: ReturnType<typeof Bun.serve>;
  afterAll(async () => { await browser?.close(); server?.stop(true); });

  test("avatar dispatch, history and reload preserve Secrets during auth restoration", async () => {
    const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
    const config = { agents: [], featureFlags: [], connectRelays: [], adminNpubs: [] };
    let releaseAuth: (() => void) | undefined;
    let holdAuth = false;
    let authRequests = 0;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      const uiAsset = assets.resolveUiAsset(url.pathname);
      if (uiAsset) return uiAsset;
      if (isSpaRoutePath(url.pathname)) return serveIndex(undefined, config);
      if (url.pathname === "/api/auth/challenge") return Response.json({ challenge: "synthetic-navigation-challenge" });
      if (url.pathname === "/api/config") return Response.json(config);
      if (url.pathname === "/test/restore-auth") {
        authRequests++;
        if (holdAuth) await new Promise<void>(resolve => { releaseAuth = resolve; });
        return Response.json({ npub: owner, expiresAt: Date.now() + 3600_000 });
      }
      if (url.pathname === "/api/secrets/inventory") return Response.json({
        workspaces: [{ id: "local", label: "Local" }], identities: [], pipelines: [],
      });
      if (url.pathname === "/api/secrets") return Response.json({ secrets: [] });
      if (url.pathname === "/api/secrets/hosted-site-grants") return Response.json({ grants: [] });
      if (url.pathname.endsWith("/events")) return new Response(": connected\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.pathname.startsWith("/api/")) return Response.json({ sessions: [], apps: [], projects: [], flags: [], items: [], delegations: [] });
      return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname)
        ?? assets.servePublicAsset(url.pathname) ?? new Response("Not found", { status: 404 });
    } });
    const { chromium } = await import(playwrightModule!);
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => {
      // Model an async successful signer/cookie restore through the normal UI API.
      // Keep production startup sequencing and route guards under test.
      const adapter = {};
      Object.defineProperty(adapter, "restoreFromDeviceKeystore", {
        get: () => async () => {
          const response = await fetch("/test/restore-auth");
          const identity = await response.json();
          (window as any).wingmanIdentityUI.update({ ...identity, isAuthenticated: true });
          return identity.npub;
        },
        set: () => {},
      });
      (window as any).wingmanIdentity = adapter;
    });
    await page.goto(new URL("/home", server.url).href);
    try { await page.waitForFunction(() => Boolean((window as any).wingmanIdentityUI)); }
    catch (error) { console.error(errors); throw error; }
    await page.waitForFunction(() => document.body.dataset.authenticated === "true");
    await page.locator("#menu-toggle").click();
    // Account menu deliberately ignores closing within its 150ms touch guard.
    await page.waitForTimeout(160);
    expect(await page.getByTestId("nav-secrets").getAttribute("href")).toBe("/secrets");
    await page.getByTestId("nav-secrets").click();
    await page.getByTestId("secrets-page").waitFor({ timeout: 8000 });
    expect(new URL(page.url()).pathname).toBe("/secrets");
    expect(await page.locator("#app").getAttribute("data-route")).toBe("secrets");
    expect(await page.evaluate(() => history.state.route)).toBe("secrets");
    await page.waitForFunction(() => document.body.dataset.menuOpen !== "true");
    expect(await page.evaluate(() => document.body.dataset.menuOpen)).not.toBe("true");
    await page.goBack();
    await page.waitForFunction(() => location.pathname === "/home");
    await page.goForward();
    await page.getByTestId("secrets-page").waitFor();

    // Clear public UI caches to require asynchronous auth restoration on reload.
    await page.evaluate(() => { localStorage.removeItem("wingman-identity-state"); localStorage.removeItem("nostr_session"); });
    holdAuth = true;
    const before = authRequests;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("auth-pending-view").waitFor({ timeout: 8000 });
    expect(new URL(page.url()).pathname).toBe("/secrets");
    while (!releaseAuth) await Bun.sleep(10);
    expect(authRequests).toBeGreaterThan(before);
    holdAuth = false;
    releaseAuth();
    await page.getByTestId("secrets-page").waitFor({ timeout: 8000 });
    expect(new URL(page.url()).pathname).toBe("/secrets");
    expect(await page.locator("#app").getAttribute("data-route")).toBe("secrets");
    expect(errors).toEqual([]);

    const guest = await browser.newPage();
    await guest.goto(new URL("/secrets", server.url).href);
    await guest.waitForFunction(() => location.pathname === "/home");
    expect(await guest.getByTestId("secrets-page").count()).toBe(0);
    await guest.close();
  }, 30_000);
});
