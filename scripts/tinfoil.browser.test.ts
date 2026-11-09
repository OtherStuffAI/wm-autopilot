import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { createProjectStaticAssetService } from "../src/server/static-assets";
import { handleSecretRoutes } from "../src/secrets/secret-routes";
import { handleModelProviderRoutes } from "../src/model-providers/provider-routes";
import { SecretStore } from "../src/secrets/secret-store";
import { deniedPolicy } from "../src/secrets/secret-policy";

const module = process.env.PLAYWRIGHT_MODULE;
const suite = module ? describe : describe.skip;
suite("Tinfoil metadata UI", () => {
  let browser: any; let server: ReturnType<typeof Bun.serve>; let store: SecretStore; let root: string;
  afterAll(async () => { await browser?.close(); server?.stop(true); store?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
  test("configures saved credential, renders Dexie-backed connection/test and launch choices", async () => {
    root = mkdtempSync(join(tmpdir(), "wm-tinfoil-browser-"));
    store = new SecretStore(join(root, "secrets.sqlite"), join(root, "master.key"));
    const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const bot = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const secret = store.create(owner, "saved-space", { type: "secret", label: "Synthetic Tinfoil key", value: "BROWSER_MUST_NOT_PERSIST_KEY_7921", policy: {
      ...deniedPolicy(), identities: [bot], agents: { enabled: true, mode: "selected", ids: [bot] },
    } });
    const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
    const ctx = { store, inventory: async () => ({ workspaces: [{ id: "local", label: "Autopilot local" }, { id: "saved-space", label: "Saved credential workspace" }], identities: [{ npub: bot, label: "Allowed bot", type: "bot" as const }], pipelines: [] }),
      testModelProvider: async () => ({ connected: true, toolCalling: true, model: "kimi-k3-1-pro", verifiedProxy: true }) };
    const { chromium } = await import(module!);
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (["/", "/settings/models", "/secrets"].includes(url.pathname)) return new Response(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/secrets/page.css"></head><body><main><div id="page"></div><section aria-label="Launch"><select id="runner"><option value="pi">Pi</option></select><label>Model<select id="model"></select></label></section></main><script type="module">
        import Alpine from '/vendor/alpinejs/module.esm.js';
        import { createSecretsPage } from '/secrets/page.js';
        import { createTinfoilSettingsSection } from '/views/settings/tinfoil-settings-section.js';
        import { secretsDb } from '/secrets/db.js';
        import { state } from '/state/index.js';
        import { createModelProviderLaunch } from '/common/model-provider-launch.js';
        state.identity.npub='${owner}'; state.identity.authenticated=true;
        document.querySelector('#page').append(location.pathname === '/secrets' ? createSecretsPage({ownerNpub:'${owner}'}) : createTinfoilSettingsSection({ownerNpub:'${owner}'}));
        const modelSelect=document.querySelector('#model');
        const launch=createModelProviderLaunch({modelSelect,agentSelect:document.querySelector('#runner'),onChange:()=>{launch.sync();modelSelect.replaceChildren(...launch.models(['existing/model']).map(id=>{const o=document.createElement('option');o.value=id;o.textContent=id;return o;}));}});
        launch.sync();window.fixtureDb=secretsDb;window.launch=launch;Alpine.start();
        </script></body></html>`, { headers: { "content-type": "text/html" } });
      const auth = { npub: owner, actorNpub: owner, session: null };
      return await handleModelProviderRoutes(request, url, auth, ctx) ?? await handleSecretRoutes(request, url, auth, ctx)
        ?? assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname) ?? new Response("Not found", { status: 404 });
    } });
    const page = await browser.newPage(); const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(new URL("/settings/models?workspace=saved-space", server.url).href);
    await page.getByTestId("tinfoil-credential").selectOption(secret.id);
    await page.getByTestId("tinfoil-save").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tinfoil-test"]')?.hasAttribute("disabled") === false);
    await page.getByTestId("tinfoil-test-identity").selectOption(bot);
    await page.getByTestId("tinfoil-test").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tinfoil-provider-status"]')?.textContent?.includes("verified"));
    expect(await page.getByTestId("session-provider-workspace").isVisible()).toBe(false);
    await page.getByTestId("session-model-provider").selectOption("tinfoil");
    await page.getByTestId("session-provider-workspace").selectOption("saved-space");
    await page.waitForFunction(() => (document.querySelector('#model') as HTMLSelectElement)?.value === "kimi-k3-1-pro");
    expect(await page.getByTestId("session-provider-workspace").isVisible()).toBe(true);
    expect(await page.evaluate(() => (window as any).launch.metadata())).toEqual({ modelProvider: "tinfoil", modelProviderWorkspaceId: "saved-space" });
    const persisted = await page.evaluate(async () => JSON.stringify(await (window as any).fixtureDb.snapshots.toArray()));
    expect(persisted).toContain(secret.id); expect(persisted).not.toContain("BROWSER_MUST_NOT_PERSIST_KEY_7921");
    const beforeNavigation = store.providerConnection(owner, "saved-space");
    const secretBeforeNavigation = store.get(owner, "saved-space", secret.id);
    await page.getByRole("link", { name: "Manage model provider credentials in Secrets" }).click();
    await page.getByTestId(`secret-${secret.id}`).waitFor();
    expect(await page.getByTestId("tinfoil-provider").count()).toBe(0);
    await page.getByRole("link", { name: "Open model provider settings" }).click();
    await page.getByTestId("tinfoil-credential").waitFor();
    expect(await page.getByTestId("tinfoil-credential").inputValue()).toBe(secret.id);
    expect(await page.getByTestId("tinfoil-models").inputValue()).toBe("kimi-k3-1-pro");
    expect(await page.getByTestId("model-provider-workspace").inputValue()).toBe("saved-space");
    expect(store.providerConnection(owner, "saved-space")).toEqual(beforeNavigation);
    expect(store.get(owner, "saved-space", secret.id)).toEqual(secretBeforeNavigation);
    expect(errors).toEqual([]);
    if (process.env.TINFOIL_SCREENSHOT) await page.screenshot({ path: process.env.TINFOIL_SCREENSHOT, fullPage: true });
  }, 30_000);
});
