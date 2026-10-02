import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProjectStaticAssetService } from "../src/server/static-assets";
import { handleSessionApi, type SessionApiContext } from "../src/server/session-api-routes";
import { PromptQueueStore } from "../src/storage/prompt-queue-store";
import type { RequestAuthContext } from "../src/auth/request-context";

// Disposable loopback fixture. No live sessions, keys or user queue items.
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const browserTest = playwrightModule ? test : test.skip;
browserTest("busy queue acknowledgement updates Dexie, pending count and historical Handled event", async () => {
  const queue = new PromptQueueStore(":memory:");
  const chosen = queue.addPrompt("fixture", { content: "Already completed during this active turn" })!;
  queue.addPrompt("fixture", { content: "Later request remains pending" });
  const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
  const session = { id: "fixture", npub: "fixture-owner", metadata: {}, status: "running", agentRuntimeStatus: "running" };
  const ctx = {
    adminNpub: null, AccessActions: { SessionsRead: "sessions:read", SessionsManage: "sessions:manage" },
    getViewerNormalizedNpub: () => "fixture-owner", sessionBelongsToViewer: (npub: string) => npub === "fixture-owner",
    manager: { listSessions: () => [session], getSession: () => session }, ensureApiAccess: async () => null,
    promptQueueStore: queue,
  } as unknown as SessionApiContext;
  const auth = { npub: "fixture-owner", authMethod: "session", session: { id: "viewer" } } as unknown as RequestAuthContext;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(`<!doctype html><html><body>
      <main aria-label="Disposable queue fixture"><output aria-live="polite" data-testid="pending-count"></output><div id="fixture"></div></main>
      <script type="module">
      import Alpine from '/vendor/alpinejs/module.esm.js';
      import { registerChatComponent, getChatTemplate } from '/live/chat-component.js';
      import { PromptQueueStore } from '/live/db.js';
      import { initQueueModule } from '/sessions/queue-modal.js';
      registerChatComponent();
      const module = initQueueModule({state:{promptQueues:new Map()},
        sessionsStore:()=>({items:[{id:'fixture',name:'Busy session fixture'}]}),showToast:()=>{},
        updateAgentStatusIndicators:()=>{document.querySelector('[data-testid="pending-count"]').textContent=String(module.getQueueCount('fixture'));}});
      await module.fetchSessionQueue('fixture');
      const chat = Alpine.store('chat'); chat.sessionId='fixture'; chat._subscribeToPromptQueue('fixture');
      document.querySelector('#fixture').innerHTML=getChatTemplate('fixture'); Alpine.start();
      window.fixture={refresh:()=>module.fetchSessionQueue('fixture'),store:PromptQueueStore};
      </script></body></html>`, { headers: { "content-type": "text/html" } });
    if (url.pathname.startsWith("/api/")) return await handleSessionApi(request, url, request.method as any,
      request.method === "POST" ? { ...auth, authMethod: "nip98", capabilitySessionId: "fixture" } : auth, ctx)
      ?? new Response("Unknown fixture API", { status: 404 });
    return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname)
      ?? assets.servePublicAsset(url.pathname) ?? new Response("Not found", { status: 404 });
  } });
  const { chromium } = await import(playwrightModule!);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean((window as any).fixture));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="queued-prompt-state"]').length === 2);
    expect(await page.getByTestId("pending-count").textContent()).toBe("2");
    const result = await page.evaluate(async (id: string) => {
      const read = await (await fetch('/api/sessions/fixture/queue')).json();
      const item = read.queue.prompts.find((prompt: any) => prompt.id === id);
      const response = await fetch('/api/sessions/fixture/queue/' + id + '/acknowledge', {
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:item.revision,reason:'Completed this active turn'})});
      await (window as any).fixture.refresh();
      return {status:response.status, rows:await (window as any).fixture.store.getSessionPrompts('fixture')};
    }, chosen.id);
    expect(result.status).toBe(200);
    expect(result.rows.filter((row: any) => row.state === "handled")).toHaveLength(1);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="handled-prompt-state"]').length === 1);
    expect(await page.getByTestId("handled-prompt-state").textContent()).toBe("Handled: Completed this active turn");
    expect(await page.getByTestId("pending-count").textContent()).toBe("1");
    expect(await page.getByTestId("queued-prompt-edit").count()).toBe(1);
    expect(await page.getByTestId("queued-prompt-delete").count()).toBe(1);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="handled-prompt-state"]').length === 1);
    expect(await page.getByTestId("pending-count").textContent()).toBe("1");
    // A durable unresolved claim remains visible after Dexie refresh and reload.
    const unresolved = queue.claimNextPrompt("fixture")!;
    queue.markClaimSending("fixture", unresolved.id, unresolved.claimToken!);
    await page.evaluate(() => (window as any).fixture.refresh());
    await page.waitForFunction(() => document.querySelector('[data-testid="queued-prompt-state"]')?.textContent?.includes('Delivery unresolved'));
    expect(await page.getByTestId("queued-prompt-state").textContent()).toContain("reconcile explicitly");
    expect(await page.getByTestId("pending-count").textContent()).toBe("1");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid="queued-prompt-state"]')?.textContent?.includes('Delivery unresolved'));
    expect(await page.getByTestId("queued-prompt-state").count()).toBe(1);
    expect(errors).toEqual([]);
    if (process.env.QUEUE_ACK_SCREENSHOT) await page.screenshot({ path: process.env.QUEUE_ACK_SCREENSHOT, fullPage: true });
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
