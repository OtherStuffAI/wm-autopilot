import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProjectStaticAssetService } from "../src/server/static-assets";
const suite = process.env.PLAYWRIGHT_MODULE ? describe : describe.skip;
suite("NStack Workspaces browser journey", () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: any;
  const errors: string[] = [];
  const submissions: any[] = [];
  let subscriptions: any[] = [];
  const agents = ["A", "B"].map((id) => ({ agentId: id, label: `Agent ${id}`, enabled: true, status: "idle" }));
  afterAll(async () => { await browser?.close(); server?.stop(true); });
  test("selection, review, partial retry, health controls, persistence and mobile layout", async () => {
    const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(fixture, { headers: { "content-type": "application/javascript" } });
      if (url.pathname.startsWith("/settings")) return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="app"></main><script type="module" src="/fixture.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/api/agent-chat/subscriptions") return Response.json({ permissions: { canManage: true }, subscriptions });
      if (url.pathname === "/api/agent-chat/agents") return Response.json({ agents, workspaceBotConnections: subscriptions.flatMap((row) => agents.map((agent) => ({ subscriptionId: row.subscriptionId, agentId: agent.agentId, status: "idle" }))) });
      if (url.pathname === "/api/agent-chat/backend-connections") return Response.json({ backendConnections: [] });
      if (url.pathname === "/api/agent-chat/nstack-connect") {
        const body = await request.json() as any; submissions.push(body.workspaces);
        return Response.json({ results: body.workspaces.map((connection: any) => {
          const failed = connection.workspaceId === "team" && submissions.length === 1;
          if (!failed && !subscriptions.some((row) => row.workspaceId === connection.workspaceId)) subscriptions.push({
            subscriptionId: connection.workspaceId, workspaceId: connection.workspaceId, workspaceName: connection.name,
            backendBaseUrl: connection.directHttpsUrl, lifecycleStatus: "active", healthStatus: "healthy", sseStatus: "connected",
            candidateAgents: agents, lastAuthOkAt: new Date().toISOString(),
          });
          return { key: JSON.stringify([connection.directHttpsUrl, connection.serviceNpub, connection.workspaceId, connection.workspaceServiceNpub]), name: connection.name, workspaceId: connection.workspaceId, status: failed ? "failed" : "monitoring", message: failed ? "Fixture transport failure" : "Monitoring events; agents are idle." };
        }) });
      }
      if (url.pathname.match(/\/subscriptions\/[^/]+\/actions\//)) {
        const parts = url.pathname.split('/');
        const row = subscriptions.find((entry) => entry.subscriptionId === parts[4]);
        const action = parts[6];
        if (action === "disable") row.sseStatus = "disabled";
        if (["enable", "reconnect"].includes(action)) row.sseStatus = "connected";
        if (action === "remove") subscriptions = subscriptions.filter((entry) => entry !== row);
        return Response.json({ subscription: row });
      }
      return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname) ?? assets.servePublicAsset(url.pathname) ?? new Response("Unexpected fixture request", { status: 404 });
    } });
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
    const page = await browser.newPage();
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(new URL("/settings/automation/workspaces", server.url).href);
    await page.getByTestId("workspace-connect-nstack").click();
    await page.getByTestId("nstack-connect-status").filter({ hasText: "Nostr Browser" }).waitFor();
    await page.getByTestId("nstack-cancel").click();
    await page.evaluate(() => (window as any).installProvider());
    await page.getByTestId("workspace-connect-nstack").click();
    for (const id of ["personal", "team"]) await page.getByTestId(`nstack-choice-s/${id}`).check();
    await page.getByTestId("nstack-review").click(); await page.getByTestId("nstack-confirm").waitFor();
    expect(await page.getByRole("dialog").textContent()).toContain("Tower");
    await page.getByTestId("nstack-back").click(); await page.getByTestId("nstack-review").click();
    await page.getByTestId("nstack-confirm").click(); await page.locator('[data-workspace-id="personal"]').waitFor();
    expect(await page.locator('[data-workspace-id="team"]').textContent()).toContain("failed");
    await page.getByTestId("nstack-retry").click();
    await page.locator('[data-workspace-id="team"]').filter({ hasText: "monitoring" }).waitFor();
    expect(submissions.map((rows) => rows.map((row: any) => row.workspaceId))).toEqual([["personal", "team"], ["team"]]);
    await page.getByTestId("nstack-cancel").click(); await page.getByTestId("workspace-bot-A").waitFor();
    expect(await page.getByTestId("workspace-bot-B").textContent()).toBe("Agent B");
    expect(await page.getByTestId("workspace-detail-personal").textContent()).toContain("Configured");
    await page.getByTestId("workspace-diagnostics").click(); await page.getByTestId("workspace-disable-personal").click();
    await page.getByTestId("workspace-enable-personal").waitFor(); await page.getByTestId("workspace-enable-personal").click();
    await page.getByTestId("workspace-disable-personal").waitFor();
    await page.reload(); await page.getByTestId("workspace-select-team").waitFor();
    expect(await page.getByTestId("workspace-bot-A").count()).toBe(1);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => (window as any).installProvider());
      await page.getByTestId("workspace-connect-nstack").click(); await page.getByTestId("nstack-choice-s/personal").waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await page.getByRole("dialog").boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      const dir = process.env.NSTACK_SCREENSHOT_DIR;
      if (dir) await page.screenshot({ path: `${dir}/selection-${width}.png`, fullPage: true });
      await page.keyboard.press("Escape");
    }
    await page.getByTestId("workspace-connect-nstack").click(); await page.getByTestId("nstack-choice-s/personal").check();
    await page.getByTestId("nstack-review").click(); await page.getByTestId("nstack-confirm").waitFor();
    await page.evaluate(() => (window as any).changeIdentity());
    await page.getByTestId("nstack-connect-status").filter({ hasText: "identity" }).waitFor();
    expect(await page.getByTestId("nstack-confirm").count()).toBe(0);
    expect(errors).toEqual([]);
    for (const path of ["nstack-connect-modal.js", "nstack-connect-controller.js"]) {
      const response = await fetch(new URL(`/views/settings/${path}`, server.url));
      expect(response.headers.get("content-type")).toContain("application/javascript");
    }
  }, 30000);
});
const fixture = `
import Alpine from '/vendor/alpinejs/module.esm.js';
import { createWorkspaceSettingsSection } from '/views/settings/workspace-settings-section.js';
window.installProvider = () => {
  let change;
  window.changeIdentity = () => change?.({reason:'identity_changed'});
  window.NStack = { version:1, requestDiscovery:async()=>{}, listNStacks:async()=>[{id:'s',name:'Saved NStack'}],
    listWorkspaces:async()=>[{id:'personal',name:'Personal'},{id:'team',name:'Team'}],
    getConnection:async({workspaceId})=>({name:workspaceId === 'team' ? 'Team' : 'Personal',workspaceId,
      workspaceOwnerNpub:'owner',workspaceServiceNpub:'ws',serviceNpub:'tower',directHttpsUrl:'https://tower.example'}),
    on:(_name,handler)=>{change=handler;return()=>{change=null;}} };
  window.dispatchEvent(new Event('nstackready'));
};
document.getElementById('app').append(createWorkspaceSettingsSection({ownerNpub:'fixture-owner'}));
Alpine.start();
`;
