import { afterAll, describe, expect, test } from "bun:test";
import { createProjectStaticAssetService } from "../src/server/static-assets";
import { NativeSdkActivity } from "../src/agents/native-sdk-contract";
import { ClaudeEventNormalizer } from "../src/agents/claude-event-normalizer";
import { recordCodexSdkActivity } from "../src/agents/codex-sdk-activity";

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const suite = playwrightModule ? describe : describe.skip;

function createTurn(provider: string, turn: string, activity: NativeSdkActivity) {
  const claude = new ClaudeEventNormalizer(activity, turn, (text) => text);
  activity.upsert(`${turn}:user`, "user", `Prompt ${turn}`);
  function addCall(index: number) {
    if (provider === "claude") {
      claude.accept({ type: "assistant", message: { id: `block${index}`, content: [
        { type: "thinking", thinking: `Reason ${index}` },
        { type: "text", text: `Working ${index}` },
        { type: "tool_use", id: `call${index}`, name: "Read", input: { file_path: `file${index}.ts` } },
      ] }, parent_tool_use_id: null } as any);
      claude.accept({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: `call${index}`, content: `Result ${index}` },
      ] }, parent_tool_use_id: null } as any);
    } else {
      recordCodexSdkActivity({ type: "item.completed", item: { id: `reason${index}`, type: "reasoning", text: `Reason ${index}` } }, activity, turn);
      activity.upsert(`${turn}:work${index}`, "agent-working", `Working ${index}`);
      recordCodexSdkActivity({ type: "item.completed", item: { id: `call${index}`, type: "command_execution",
        command: `cat file${index}.ts`, aggregated_output: `Result ${index}`, status: "completed", exit_code: 0 } }, activity, turn);
    }
  }
  function answer(final: boolean) {
    const text = `**${final ? "Final" : "Streaming"} ${turn}**\n\n\`\`\`ts\nconst ok = true;\n\`\`\``;
    if (provider === "claude") {
      if (final) claude.complete({ type: "result", subtype: "success", is_error: false, result: text } as any);
      else claude.accept({ type: "assistant", message: { id: "answer", content: [{ type: "text", text }] }, parent_tool_use_id: null } as any);
    } else activity.upsert(`${turn}:answer`, final ? "assistant" : "agent-streaming", text);
  }
  return { addCall, answer };
}

suite("turn grouping in Alpine/Dexie and shared renderers", () => {
  let browser: any;
  let server: ReturnType<typeof Bun.serve>;
  afterAll(async () => { server?.stop(true); await browser?.close(); });

  test("SSE growth, copy, independent turns, final promotion, reload, desktop/mobile", async () => {
    const { chromium } = await import(playwrightModule!);
    browser = await chromium.launch({ headless: true,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const assets = createProjectStaticAssetService(process.cwd());
    let snapshot: any[] = [];
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/sessions/fixture/events") return new Response(new ReadableStream({
        start(controller) { stream = controller; controller.enqueue(encoder.encode(": ready\n\n")); },
      }), { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/snapshot") return Response.json(snapshot);
      if (url.pathname === "/") return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body>
        <main aria-label="Conversation fixture" id="fixture"></main><div id="shared"></div>
        <script type="module">
          import { Alpine, registerChatComponent, getChatTemplate } from '/live/chat-component.js';
          import { MessageStore, db } from '/live/db.js';
          import { attachWorkingNotesToggle } from '/live/working-notes-toggle.js';
          import { createArchivedConversation } from '/live/archived-conversation.js';
          import { createConversationElement } from '/live/conversation-window.js';
          import { sseManager } from '/live/sse-manager.js';
          import Dexie from '/vendor/dexie/dexie.mjs';
          attachWorkingNotesToggle(); registerChatComponent(); Alpine.store('sessions', {items:[]});
          document.querySelector('#fixture').innerHTML=getChatTemplate(); Alpine.start();
          const chat=Alpine.store('chat'); chat.sessionId='fixture';
          chat._messageSubscription = Dexie.liveQuery(() => MessageStore.getSessionMessages('fixture')).subscribe(messages => chat.replaceMessages(messages));
          await MessageStore.syncFromServer('fixture', await (await fetch('/snapshot')).json());
          sseManager.connect('fixture');
          window.fixture={MessageStore,db,chat,createArchivedConversation,createConversationElement};
        </script></body></html>`, { headers: { "content-type": "text/html" } });
      return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname)
        ?? assets.servePublicAsset(url.pathname) ?? new Response("Not found", { status: 404 });
    } });
    for (const provider of ["claude", "codex"]) {
      for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
        const activity = new NativeSdkActivity(() => {});
        const first = createTurn(provider, "one", activity);
        first.addCall(1); first.addCall(2); first.answer(false);
        snapshot = activity.snapshot(); stream = undefined;
        const context = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
        const page = await context.newPage(); const errors: string[] = [];
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.goto(server.url.href); await page.waitForFunction(() => Boolean((window as any).fixture));
        await page.getByText("Streaming one", { exact: true }).waitFor();
        const tools = page.locator('#fixture [data-role="agent-tools"]');
        const thinking = page.locator('#fixture [data-role="agent-thinking"]');
        expect(await tools.count()).toBe(1); expect(await thinking.count()).toBe(1);
        expect(await tools.locator("details").getAttribute("open")).toBeNull();
        const key = await tools.locator("details").getAttribute("data-working-notes-key");
        await tools.locator("summary").click();
        await page.waitForFunction(() => document.querySelector('#fixture [data-role="agent-tools"] details')?.hasAttribute('open'));
        await tools.getByTestId("message-copy").click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toContain("file1.ts"); expect(copied).toContain("Result 2");
        await thinking.getByTestId("message-copy").click();
        const copiedThinking = await page.evaluate(() => navigator.clipboard.readText());
        expect(copiedThinking).toContain("Reason 1"); expect(copiedThinking).toContain("Working 2");
        // Deliver actual EventSource frames; SSE writes to Dexie before Alpine reads.
        first.addCall(3); first.answer(false); snapshot = activity.snapshot();
        for (const message of snapshot) stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
        await tools.getByText("Result 3", { exact: true }).waitFor();
        expect(await tools.count()).toBe(1); expect(await thinking.count()).toBe(1);
        expect(await tools.locator("details").getAttribute("data-working-notes-key")).toBe(key);
        expect(await tools.locator("details").getAttribute("open")).not.toBeNull();
        const streamId = await page.evaluate(async () => (await (window as any).fixture.MessageStore.getSessionMessages('fixture')).find((m: any) => m.role === 'agent-streaming').id);
        first.answer(true); snapshot = activity.snapshot();
        for (const message of snapshot) stream!.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        await page.getByText("Final one", { exact: true }).waitFor();
        const finalId = await page.evaluate(async () => (await (window as any).fixture.MessageStore.getSessionMessages('fixture')).find((m: any) => m.role === 'assistant').id);
        expect(finalId).toBe(streamId);
        const second = createTurn(provider, "two", activity); second.addCall(4); second.addCall(5); second.answer(false);
        snapshot = activity.snapshot();
        for (const message of snapshot) stream!.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        await page.getByText("Streaming two", { exact: true }).waitFor();
        expect(await tools.count()).toBe(2); expect(await thinking.count()).toBe(2);
        expect(await tools.nth(1).locator("details").getAttribute("open")).toBeNull();
        expect(await tools.nth(0).textContent()).not.toContain("file4.ts");
        expect(await tools.nth(1).textContent()).not.toContain("file1.ts");
        await thinking.nth(0).locator("summary").click();
        await page.waitForFunction(async () => {
          const rows = await (window as any).fixture.db.uiPreferences.toArray();
          return rows.some((r: any) => r.key.endsWith('agent-thinking') && r.value === false)
            && rows.some((r: any) => r.key.endsWith('agent-tools') && r.value === true);
        });
        await page.reload(); await page.getByText("Final one", { exact: true }).waitFor();
        expect(await tools.count()).toBe(2); expect(await thinking.count()).toBe(2);
        expect(await tools.nth(0).locator("details").getAttribute("open")).not.toBeNull();
        expect(await thinking.nth(0).locator("details").getAttribute("open")).toBeNull();
        expect(await tools.nth(1).locator("details").getAttribute("open")).toBeNull();
        // Both other renderer paths consume exactly the same raw stored rows.
        await page.evaluate(async () => {
          const f = (window as any).fixture; const messages = await f.MessageStore.getSessionMessages('fixture');
          const options = { sessionId: 'fixture', conversation: messages, windowStore: new Map() };
          document.querySelector('#shared')!.append(f.createArchivedConversation(options), f.createConversationElement(options));
        });
        expect(await page.locator('#shared [data-role="agent-tools"]').count()).toBe(4);
        expect(await page.locator('#shared [data-role="agent-thinking"]').count()).toBe(4);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.GROUPING_SCREENSHOT_DIR) await page.locator('#fixture').screenshot({ path: `${process.env.GROUPING_SCREENSHOT_DIR}/${provider}-${viewport.width}.png` });
        // A display window must include every record in its oldest visible turn.
        snapshot = [];
        for (let turn = 0; turn < 30; turn++) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString();
          snapshot.push({ messageId: `window${turn}:user`, role: "user", content: `Window prompt ${turn}`, createdAt });
          for (let call = 0; call < 100; call++) snapshot.push({ messageId: `window${turn}:call${call}`,
            role: "agent-tools", content: `Detail ${turn}:${call}`, createdAt });
          snapshot.push({ messageId: `window${turn}:answer`, role: "assistant", content: `Answer ${turn}`, createdAt });
        }
        await page.evaluate(() => (window as any).fixture.MessageStore.clearSession('fixture'));
        await page.reload(); await page.getByText("Answer 29", { exact: true }).waitFor();
        expect(await tools.count()).toBe(27);
        expect(await tools.first().locator('[data-message-id]').count()).toBe(100);
        expect(await page.locator('#fixture article').first().getAttribute('data-role')).toBe("user");
        await page.getByTestId("conversation-show-older").click();
        await page.getByText("Window prompt 0", { exact: true }).waitFor();
        expect(await tools.count()).toBe(30);
        expect(await tools.first().locator('[data-message-id]').count()).toBe(100);
        const contextCard = { messageId: 'window29:context', role: 'agent-context', content: 'Context retained', createdAt: '2026-01-01T00:00:30Z' };
        const failure = { messageId: 'window29:error', role: 'agent-error', content: 'Provider failure', createdAt: '2026-01-01T00:00:31Z' };
        snapshot.push(contextCard, failure);
        for (const message of [contextCard, failure]) stream!.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        await page.getByText('Provider failure', { exact: true }).waitFor();
        expect(await page.getByTestId('agent-error-message').getAttribute('role')).toBe('alert');
        expect(await page.getByTestId('agent-error-message').getAttribute('aria-live')).toBe('assertive');
        expect(await page.locator('#fixture [data-role="agent-context"] summary').textContent()).toContain('Show context');
        expect(errors).toEqual([]);
        await context.close();
      }
    }
  }, 60_000);
});
