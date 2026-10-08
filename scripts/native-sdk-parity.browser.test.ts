import { afterAll, describe, expect, test } from "bun:test";
import { createProjectStaticAssetService } from "../src/server/static-assets";
import { ClaudeEventNormalizer } from "../src/agents/claude-event-normalizer";
import { NativeSdkActivity } from "../src/agents/native-sdk-contract";
import { recordCodexSdkActivity } from "../src/agents/codex-sdk-activity";

// Source fixtures exercise real Alpine/Dexie rendering, without live provider auth.
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const suite = playwrightModule ? describe : describe.skip;

suite("native SDK conversation browser parity", () => {
  let browser: any;
  let server: ReturnType<typeof Bun.serve>;
  afterAll(async () => { await browser?.close(); server?.stop(true); });

  test("both providers render thinking/tools/Markdown; same-ID final survives reload", async () => {
    const { chromium } = await import(playwrightModule!);
    browser = await chromium.launch({ headless: true,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const assets = createProjectStaticAssetService(process.cwd());
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") return new Response(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main aria-label="Conversation fixture" id="fixture"></main>
        <script type="module">
          import { Alpine, registerChatComponent, getChatTemplate } from '/live/chat-component.js';
          import { MessageStore } from '/live/db.js';
          import Dexie from '/vendor/dexie/dexie.mjs';
          registerChatComponent(); Alpine.store('sessions', {items:[]});
          document.querySelector('#fixture').innerHTML=getChatTemplate(); Alpine.start();
          const chat=Alpine.store('chat'); chat.sessionId='fixture';
          chat._messageSubscription = Dexie.liveQuery(() => MessageStore.getSessionMessages('fixture')).subscribe(messages => {chat.messages=messages;});
          window.fixture={MessageStore,chat};
        </script></body></html>`, { headers: { "content-type": "text/html" } });
      return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname)
        ?? assets.servePublicAsset(url.pathname) ?? new Response("Not found", { status: 404 });
    } });
    const page = await browser.newPage(); const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(server.url.href); await page.waitForFunction(() => Boolean((window as any).fixture));
    for (const path of ["/live/chat-message-roles.js", "/live/db.js"]) {
      expect((await page.request.get(`${server.url.origin}${path}`)).headers()["content-type"]).toContain("application/javascript");
    }
    const activity = new NativeSdkActivity(() => {});
    const claude = new ClaudeEventNormalizer(activity, "claude", (text) => text);
    claude.accept({ type: "assistant", message: { id: "claude-1", content: [
      { type: "thinking", thinking: "Exposed Claude thinking" },
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "README.md" } },
    ] }, parent_tool_use_id: null } as any);
    claude.accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "Read result" }] }, parent_tool_use_id: null } as any);
    claude.accept({ type: "assistant", message: { id: "claude-2", content: [{ type: "text", text: "**Streaming Claude**" }] }, parent_tool_use_id: null } as any);
    recordCodexSdkActivity({ type: "item.completed", item: { id: "thinking", type: "reasoning", text: "Exposed Codex thinking" } }, activity, "codex");
    recordCodexSdkActivity({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "cat README.md", aggregated_output: "Read result", status: "completed", exit_code: 0 } }, activity, "codex");
    activity.upsert("codex:final", "assistant", "**Codex final**\n\n```ts\nconst ok = true;\n```");
    await page.evaluate(async (messages: any[]) => {
      const f = (window as any).fixture;
      for (const message of messages) await f.MessageStore.upsertMessage('fixture', message);
    }, activity.snapshot());
    await page.getByText("Streaming Claude", { exact: true }).waitFor();
    expect(await page.locator('[data-role="agent-streaming"] strong').textContent()).toBe("Streaming Claude");
    expect(await page.locator('[data-role="agent-tools"] details').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-role="agent-thinking"]').count()).toBe(2);
    const toolPanel = page.locator('[data-role="agent-tools"] details').first();
    await toolPanel.locator("summary").click();
    expect(await toolPanel.getAttribute("open")).not.toBeNull();
    expect(await toolPanel.textContent()).toContain("README.md");
    expect(await page.locator('[data-role="assistant"] pre code').textContent()).toContain("const ok = true;");
    const before = await page.evaluate(async () => (await (window as any).fixture.MessageStore.getSessionMessages('fixture')).find((m: any) => m.role === 'agent-streaming').id);
    claude.complete({ type: "result", subtype: "success", is_error: false, result: "**Claude final**\n\n```ts\nconst ok = true;\n```", session_id: "native" } as any);
    await page.evaluate(async (message: any) => (window as any).fixture.MessageStore.upsertMessage('fixture', message), activity.snapshot().find((m) => m.content.startsWith("**Claude final**")));
    await page.waitForFunction(() => document.querySelectorAll('[data-role="assistant"] strong').length === 2);
    const finalId = await page.evaluate(async () => (await (window as any).fixture.MessageStore.getSessionMessages('fixture')).find((m: any) => m.content.startsWith('**Claude final**')).id);
    expect(finalId).toBe(before);
    await page.reload(); await page.waitForFunction(() => Boolean((window as any).fixture));
    await page.getByText("Claude final", { exact: true }).waitFor();
    expect(await page.locator('[data-role="assistant"] strong').count()).toBe(2);
    if (process.env.SDK_PARITY_SCREENSHOT) await page.screenshot({ path: process.env.SDK_PARITY_SCREENSHOT, fullPage: true });
    expect(errors).toEqual([]);
  }, 30_000);
});
