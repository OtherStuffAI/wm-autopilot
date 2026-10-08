import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProjectStaticAssetService } from "../src/server/static-assets";

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const suite = playwrightModule ? describe : describe.skip;

suite("Session provider consent controls in the browser", () => {
  let browser: any;
  let server: ReturnType<typeof Bun.serve>;
  afterAll(async () => { await browser?.close(); server?.stop(true); });

  test("new and existing sessions expose consent, save it and explain flag suspension", async () => {
    const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/sessions/test/events") return new Response('event: permission-resolved\ndata: {"permissionId":"pending"}\n\n',
        { headers: { "content-type": "text/event-stream" } });
      if (pathname === "/") return new Response('<!doctype html><main><dialog id="launch"><form><button id="advanced-toggle" type="button">Advanced</button><section id="advanced"></section></form></dialog></main>',
        { headers: { "content-type": "text/html" } });
      return assets.resolveUiAsset(pathname) ?? await assets.serveVendorModule(pathname) ?? new Response("Not found", { status: 404 });
    } });
    const { chromium } = await import(playwrightModule!);
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(server.url.href);
    const mime = await page.request.get(new URL("/sessions/provider-approval-control.js", server.url).href);
    expect(mime.headers()["content-type"]).toContain("application/javascript");
    await page.evaluate(async () => {
      const { createSessionDialogController } = await import("/common/session-dialog.js");
      const flags = [{ key: "session_provider_auto_approve", state: "on" }, { key: "claude-use-native-sdk", state: "on" }];
      const controller = createSessionDialogController({
        dialog: document.getElementById("launch"), advancedToggle: document.getElementById("advanced-toggle"), advancedPanel: document.getElementById("advanced"),
        agentSelect: { value: "claude", addEventListener() {} }, directoryInput: { value: "/tmp", addEventListener() {} },
        directoryFavoritesSelect: document.createElement("select"), modelSelect: document.createElement("select"),
        sessionNameInput: document.createElement("input"), isAuthenticated: () => true, getConfig: () => ({ featureFlags: flags, agents: [] }),
        getFallbackDirectory: () => "/tmp", onSubmit() {},
      });
      controller.open();
      (window as any).approvalController = controller;
    });
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByLabel("Always approve for this session", { exact: true }).check();
    expect(await page.evaluate(() => (window as any).approvalController.collectValues().metadata.providerApprovalPolicy)).toBe("always");
    await page.evaluate(() => (document.getElementById("launch") as HTMLDialogElement).close());
    await page.evaluate(async () => {
      const { openSessionDetailsDialog } = await import("/sessions/session-details-dialog.js");
      (window as any).detailsPromise = openSessionDetailsDialog({ session: { id: "test", name: "Test",
        metadata: { agentTransport: "claude-sdk", providerApprovalPolicy: "always" } }, sessions: [],
        approvalFlags: [{ key: "session_provider_auto_approve", state: "off" }] });
    });
    expect(await page.getByTestId("session-details-dialog").getByLabel("Always approve for this session", { exact: true }).isChecked()).toBe(true);
    expect(await page.locator("dialog[open]").textContent()).toContain("suspended");
    await page.getByTestId("session-details-dialog").getByLabel("Always approve for this session", { exact: true }).uncheck();
    await page.getByTestId("session-details-save").click();
    expect(await page.evaluate(async () => (await (window as any).detailsPromise).providerApprovalPolicy)).toBe("manual");
    await page.evaluate(async () => {
      const { PermissionStore } = await import("/live/db.js");
      const { sseManager } = await import("/live/sse-manager.js");
      await PermissionStore.upsert("test", { id: "pending", createdAt: new Date().toISOString() });
      await PermissionStore.upsert("other", { id: "pending", createdAt: new Date().toISOString() });
      (window as any).approvalPermissionStore = PermissionStore;
      (window as any).approvalSse = sseManager;
      sseManager.connect("test");
    });
    await page.waitForFunction(async () => (await (window as any).approvalPermissionStore.getSessionPermissions("test")).length === 0);
    expect(await page.evaluate(async () => (await (window as any).approvalPermissionStore.getSessionPermissions("other")).length)).toBe(1);
    await page.evaluate(() => (window as any).approvalSse.disconnect("test"));
    expect(errors).toEqual([]);
  }, 15000);
});
