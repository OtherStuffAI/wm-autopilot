import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { nip19 } from "nostr-tools";
import { createProjectStaticAssetService } from "../src/server/static-assets.ts";

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const suite = playwrightModule ? describe : describe.skip;
const baselineRef = process.env.SETTINGS_BASELINE_REF;
const evidenceDir = process.env.SETTINGS_SCREENSHOT_DIR;

// Only a static fixture server and synthetic callbacks: no host, auth or real PINs.
suite("Users & Access responsive settings", () => {
  let browser;
  let server;
  const errors = [];
  afterAll(async () => { await browser?.close(); server?.stop(true); });

  test("keeps identities and controls readable and exercises isolated PIN navigation", async () => {
    if (evidenceDir) {
      const ignored = Bun.spawnSync(["git", "check-ignore", evidenceDir]);
      const tracked = Bun.spawnSync(["git", "ls-files", evidenceDir]);
      expect(ignored.exitCode).toBe(0);
      expect(tracked.stdout.toString().trim()).toBe("");
    }
    const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
    const baseline = new Map();
    if (baselineRef) {
      for (const path of ["styles.css", "api/admin-users-panels.js", "views/settings-view.js", "views/settings-navigation.js", "views/settings-routes.js"]) {
        const result = Bun.spawnSync(["git", "show", `${baselineRef}:src/ui/${path}`]);
        expect(result.exitCode).toBe(0);
        baseline.set(`/${path}`, result.stdout.toString());
      }
    }
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (baseline.has(url.pathname)) return new Response(baseline.get(url.pathname), { headers: { "content-type": url.pathname.endsWith(".css") ? "text/css" : "application/javascript" } });
      if (url.pathname === "/fixture.js") return new Response(fixture, { headers: { "content-type": "application/javascript" } });
      if (url.pathname === "/api/terminal/pin") {
        expect(request.method).toBe("PUT");
        const payload = await request.json();
        expect(payload.pin).toMatch(/^\d{5}$/);
        expect(payload.confirmPin).toBe(payload.pin);
        if (payload.pin === "00000") return Response.json({ error: "Mock PIN save failed" }, { status: 500 });
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/settings")) return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="app" data-route="settings"></main><script type="module" src="/fixture.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/terminal") return new Response("<h1>Mock terminal console destination</h1>", { headers: { "content-type": "text/html" } });
      return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname)
        ?? assets.servePublicAsset(url.pathname) ?? new Response("Unexpected fixture request", { status: 404 });
    } });
    const { chromium } = await import(playwrightModule);
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const measurements = [];
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(new URL("/settings/access", server.url).href);
      await page.locator(".wm-admin-users__item").first().waitFor();
      if (!baselineRef) await page.getByTestId("admin-user-name").first().filter({ hasText: "Alex Morgan" }).waitFor();
      const sizes = await page.evaluate(() => ({
        viewport: innerWidth, document: document.documentElement.scrollWidth,
        rows: [...document.querySelectorAll(".wm-admin-users__item")].map(node => Math.round(node.getBoundingClientRect().height)),
        identityWidths: [...document.querySelectorAll(".wm-admin-users__details")].map(node => Math.round(node.getBoundingClientRect().width)),
      }));
      measurements.push({ width, ...sizes });
      if (!baselineRef) {
        expect(sizes.document).toBeLessThanOrEqual(width);
        expect(Math.min(...sizes.identityWidths)).toBeGreaterThan(180);
        expect(Math.max(...sizes.rows)).toBeLessThan(420);
        expect(await page.getByTestId("settings-access-open-terminal").isVisible()).toBe(true);
        expect(await page.getByTestId("terminal-security-settings").count()).toBe(0);
        await page.getByTestId("admin-user-identity").first().locator("summary").click();
        expect(await page.getByTestId("admin-user-npub").first().textContent()).toHaveLength(63);
        expect(await page.getByTestId("admin-user-copy-npub").first().isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (evidenceDir && [1440, 390].includes(width)) await page.screenshot({ path: `${evidenceDir}/after-identity-${width}.png`, fullPage: true });
        await page.getByTestId("admin-user-copy-npub").first().click();
        await page.waitForFunction(() => document.querySelector('[data-testid="admin-user-identity"] [role="status"]').textContent === "Identity copied.");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toHaveLength(63);
        await page.getByTestId("admin-user-identity").first().locator("summary").click();
      }
      if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/${baselineRef ? "before" : "after"}-access-${width}.png`, fullPage: true });
    }
    if (evidenceDir) await Bun.write(`${evidenceDir}/${baselineRef ? "before" : "after"}-measurements.json`, JSON.stringify(measurements, null, 2));
    if (baselineRef) { expect(errors).toEqual([]); return; }

    // Preserved Allowed/Admin/Delete callbacks, including immutable bootstrap admin.
    await page.getByTestId("admin-user-allowed-toggle").nth(1).check();
    await page.getByTestId("admin-user-admin-toggle").nth(1).check();
    expect(await page.getByTestId("admin-user-admin-toggle").first().isDisabled()).toBe(true);
    await page.getByTestId("admin-user-delete").nth(1).click();
    expect(await page.evaluate(() => window.calls.map(call => call[0]))).toEqual(["allowed", "admin", "delete"]);

    await page.getByTestId("settings-access-open-terminal").click();
    expect(new URL(page.url()).pathname).toBe("/settings/terminal");
    await page.getByTestId("terminal-security-settings").waitFor();
    expect(await page.getByTestId("terminal-settings-save").textContent()).toBe("Enable terminal");
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-terminal-setup-320.png`, fullPage: true });
    await page.getByTestId("terminal-settings-pin").fill("12345");
    await page.getByTestId("terminal-settings-pin-confirmation").fill("54321");
    await page.getByTestId("terminal-settings-save").click();
    expect(await page.getByTestId("terminal-settings-status").textContent()).toContain("same 5 digit PIN");
    await page.getByTestId("terminal-settings-pin").fill("00000");
    await page.getByTestId("terminal-settings-pin-confirmation").fill("00000");
    await page.getByTestId("terminal-settings-save").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="terminal-settings-status"]').textContent === "Mock PIN save failed");
    expect(await page.getByTestId("terminal-settings-save").isEnabled()).toBe(true);
    for (const value of ["12345", "67890"]) {
      await page.getByTestId("terminal-settings-pin").fill(value);
      await page.getByTestId("terminal-settings-pin-confirmation").fill(value);
      const saved = page.waitForResponse(response => response.url().endsWith("/api/terminal/pin"));
      await page.getByTestId("terminal-settings-save").click();
      await saved;
      await page.waitForFunction(() => document.querySelector('[data-testid="terminal-settings-save"]').textContent === "Replace PIN");
      expect(await page.getByTestId("terminal-settings-pin").inputValue()).toBe("");
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/after-terminal-${width}.png`, fullPage: true });
      if (width > 850) await page.getByTestId("settings-nav-access").click();
      else await page.getByTestId("settings-mobile-navigation").selectOption("access");
      expect(new URL(page.url()).pathname).toBe("/settings/access");
      if (width > 850) await page.getByTestId("settings-nav-terminal").click();
      else await page.getByTestId("settings-mobile-navigation").selectOption("terminal");
      expect(new URL(page.url()).pathname).toBe("/settings/terminal");
    }
    await page.getByTestId("settings-terminal-open-console").click();
    expect(new URL(page.url()).pathname).toBe("/terminal");
    await page.goto(new URL("/settings/access#terminal-security-title", server.url).href);
    await page.getByTestId("terminal-security-settings").waitFor();
    expect(new URL(page.url()).pathname).toBe("/settings/terminal");
    await page.goto(new URL("/settings/terminal?member=1", server.url).href);
    await page.getByText("Administrator access required", { exact: true }).waitFor();
    expect(await page.getByTestId("terminal-security-settings").count()).toBe(0);
    expect(await page.getByTestId("settings-nav-terminal").count()).toBe(0);
    expect(errors).toEqual([]);
  }, 60000);
});

const fixture = `
import { initSettingsView } from '/views/settings-view.js';
import { initAdminUsersPanels } from '/api/admin-users-panels.js';
import { cacheIdentityProfile } from '/identity/profile-cache.js';
const npubs = ${JSON.stringify([1, 2, 3, 4].map(value => nip19.npubEncode(String(value).repeat(64))))};
const npub = i => npubs[i - 1];
await cacheIdentityProfile({npub: npub(1), name: 'Alex Morgan', pictureUrl: null});
await cacheIdentityProfile({npub: npub(2), name: 'Cached name overridden by nickname', pictureUrl: null});
window.calls = [];
const state = {
  identity: { isAdmin: !location.search.includes('member=1'), authenticated: true, ports: [4500,4501] },
  config: { terminalConfigured: false }, settingsPanels: {},
  adminUsers: { initialized: true, loading: false, pending: new Set(), nicknameDrafts: new Map(),
    items: [
      {npub: npub(1), alias: 'honest-ivory-thicket-with-a-realistically-long-registered-alias', admin: true, bootstrapAdmin: true, approved: true},
      {npub: npub(2), alias: 'gentle-silver-meadow', nickname: 'Workshop operator with a long readable name', admin: false, approved: false},
      {npub: npub(3), alias: 'x'.repeat(96), admin: false, approved: true},
      {npub: npub(4), admin: false, approved: false},
    ], portsTool: {},
  },
};
const selected = new Set();
function card({ title, className }) {
  const card = document.createElement('section'); card.className = 'wm-card ' + className;
  const heading = document.createElement('h2'); heading.textContent = title;
  const body = document.createElement('div'); body.className = 'wm-collapsible__body';
  card.append(heading, body); return {card, body};
}
const panels = initAdminUsersPanels({state, getCurrentRoute: () => 'settings', render: () => {},
 createCollapsibleCard: card, abbreviateNpub: value => value.slice(0,12) + '…' + value.slice(-6),
 normaliseNpubValue: value => value, matchesAdminUserFilter: () => true,
 ensureAdminPortsToolState: () => {}, ensureAdminSelectionState: () => selected,
 getAdminUserKey: user => user.npub, setAdminUserSelected: () => {}, clearAdminSelection: () => {},
 toggleUserOnboarding: (...args) => window.calls.push(['allowed', ...args]),
 toggleUserAdmin: (...args) => window.calls.push(['admin', ...args]),
 deleteAdminUser: (...args) => window.calls.push(['delete', ...args]),
});
const view = initSettingsView({state, render: render, renderAdminUsersPanel: panels.renderAdminUsersPanel,
 normalisePortList: ports => ports, refreshConfig: async () => { state.config.terminalConfigured = true; render(); }, showToast: () => {}});
function render() {document.querySelector('#app').replaceChildren(view.renderSettings());}
window.addEventListener('popstate', render);
render();
`;
