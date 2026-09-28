import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProjectStaticAssetService } from "../src/server/static-assets";
import { handleSessionApi, type SessionApiContext } from "../src/server/session-api-routes";
import { PromptQueueStore } from "../src/storage/prompt-queue-store";
import type { RequestAuthContext } from "../src/auth/request-context";

// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright entry point.
// Uses the actual UI modules, Alpine template, IndexedDB and queue DELETE route.
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const suite = playwrightModule ? describe : describe.skip;

suite("queued prompt Delete in a browser", () => {
  const queue = new PromptQueueStore(":memory:");
  const chosen = queue.addPrompt("fixture", { content: "Delete this disposable prompt" })!;
  const retained = queue.addPrompt("fixture", { content: "Keep this disposable prompt" })!;
  const foreign = queue.addPrompt("other-session", { content: "Keep the other session" })!;
  const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
  const requests: string[] = [];
  let rejectDelete = false;
  let browser: any;
  let server: ReturnType<typeof Bun.serve>;
  const session = { id: "fixture", npub: "fixture-owner", metadata: {}, status: "running" };
  const ctx = {
    adminNpub: null,
    AccessActions: { SessionsRead: "sessions:read", SessionsManage: "sessions:manage" },
    getViewerNormalizedNpub: () => "fixture-owner",
    sessionBelongsToViewer: (npub: string) => npub === "fixture-owner",
    manager: { listSessions: () => [session], getSession: () => session },
    ensureApiAccess: async () => null,
    promptQueueStore: queue,
  } as unknown as SessionApiContext;
  const auth = { npub: "fixture-owner", authMethod: "session", session: { id: "viewer" } } as unknown as RequestAuthContext;

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("enables Delete, confirms visibly, cancels safely, reports errors and removes only the selection", async () => {
    const { chromium } = await import(playwrightModule!);
    browser = await chromium.launch({ headless: true });
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/") {
          return new Response(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head>
            <body><main id="fixture"></main><script type="module">
            import { Alpine, registerChatComponent, getChatTemplate } from '/live/chat-component.js';
            import { PromptQueueStore } from '/live/db.js';
            import { initQueueModule } from '/sessions/queue-modal.js';
            registerChatComponent();
            const payload = await (await fetch('/api/sessions/fixture/queue')).json();
            await PromptQueueStore.replaceSession('fixture', payload.queue.prompts);
            const chat = Alpine.store('chat'); chat.sessionId = 'fixture'; chat._subscribeToPromptQueue('fixture');
            document.querySelector('#fixture').innerHTML = getChatTemplate('fixture'); Alpine.start();
            window.fixture = { store: PromptQueueStore, openModal: async () => {
              const module = initQueueModule({state:{promptQueues:new Map()},
                sessionsStore:()=>({items:[{id:'fixture',name:'Disposable fixture'}]}),
                showToast:()=>{},updateAgentStatusIndicators:()=>{}});
              await module.openPromptQueueModal('fixture');
            }};
            </script></body></html>`, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname.startsWith("/api/")) {
          if (request.method === "DELETE") {
            requests.push(url.pathname);
            if (rejectDelete) return Response.json({ error: "Controlled delete failure" }, { status: 503 });
          }
          return await handleSessionApi(request, url, request.method as "GET" | "DELETE", auth, ctx)
            ?? new Response("Unknown fixture API", { status: 404 });
        }
        return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname)
          ?? assets.servePublicAsset(url.pathname) ?? new Response("Not found", { status: 404 });
      },
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean((window as any).fixture));
    const deletes = page.getByTestId("queued-prompt-delete");
    await deletes.first().waitFor();
    // This fails on the original template: Alpine disables an undefined binding.
    expect(await deletes.first().isEnabled()).toBe(true);
    const dialog = page.getByTestId("delete-queued-prompt-dialog");
    await deletes.first().click();
    await dialog.waitFor({ state: "visible" });
    expect(requests).toHaveLength(0);
    await dialog.getByTestId("dialog-cancel").click();
    await dialog.waitFor({ state: "detached" });
    expect(queue.getQueueCount("fixture")).toBe(2);
    expect(await deletes.count()).toBe(2);
    expect(requests).toHaveLength(0);

    await deletes.first().click();
    await dialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(requests).toHaveLength(0);

    rejectDelete = true;
    await deletes.first().click();
    await dialog.getByTestId("dialog-confirm").click();
    await page.getByRole("status").filter({ hasText: "Controlled delete failure" }).waitFor();
    expect(queue.getQueueCount("fixture")).toBe(2);
    expect(await deletes.count()).toBe(2);
    expect(await deletes.first().isEnabled()).toBe(true);

    rejectDelete = false;
    await deletes.first().click();
    await dialog.getByTestId("dialog-confirm").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="queued-prompt-delete"]').length === 1);
    expect(queue.getSessionQueue("fixture").map((prompt) => prompt.id)).toEqual([retained.id]);
    expect(queue.getSessionQueue("other-session").map((prompt) => prompt.id)).toEqual([foreign.id]);
    expect(requests).toEqual(Array(2).fill(`/api/sessions/fixture/queue/${chosen.id}`));
    expect(await page.evaluate(() => (window as any).fixture.store.getSessionPrompts("fixture")))
      .toEqual([expect.objectContaining({ id: retained.id })]);

    await page.evaluate(() => (window as any).fixture.openModal());
    const modal = page.locator(".wm-prompt-queue-modal");
    await modal.locator(".delete-btn").click();
    await dialog.waitFor({ state: "visible" });
    await dialog.getByTestId("dialog-cancel").click();
    expect(queue.getQueueCount("fixture")).toBe(1);
    await modal.locator(".delete-btn").click();
    await dialog.getByTestId("dialog-confirm").click();
    await modal.getByText("No prompts queued").waitFor();
    expect(queue.getQueueCount("fixture")).toBe(0);
    expect(queue.getQueueCount("other-session")).toBe(1);
    expect(errors).toEqual([]);
  }, 30_000);
});
