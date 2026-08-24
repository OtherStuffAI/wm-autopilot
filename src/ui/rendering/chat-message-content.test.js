import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearChatMessageHtmlCache,
  getChatMessageHtmlCacheOptions,
  getChatMessageHtmlCacheStats,
  renderChatMessageHtml,
  renderWorkingNotesHtml,
} from "./chat-message-content.js";

const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.window = originalWindow;
});

describe("chat message content rendering", () => {
  beforeEach(() => {
    clearChatMessageHtmlCache();
  });

  test("renders markdown blocks for chat messages", () => {
    const html = renderChatMessageHtml([
      "## Plan",
      "",
      "- **Render** user messages",
      "- Render `agent` messages",
    ].join("\n"));

    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>Render</strong> user messages");
    expect(html).toContain("<code>agent</code>");
  });

  test("cleans agent session text before rendering markdown when requested", () => {
    const html = renderChatMessageHtml("Cleartext should be\n  only relay-safe classification.", {
      cleanAgentText: true,
    });

    expect(html).toContain("<p>Cleartext should be only relay-safe classification.</p>");
  });

  test("renders image markdown while cleaning text blocks", () => {
    const html = renderChatMessageHtml([
      "Here is the thing",
      "  you asked for.",
      "![upload](/uploads/images/example.png)",
    ].join("\n"), {
      cleanAgentText: true,
    });

    expect(html).toContain("Here is the thing you asked for.");
    expect(html).toContain("wm-inline-image");
    expect(html).toContain('data-testid="inline-image-preview-link"');
    expect(html).toContain('aria-label="Open upload preview"');
  });

  test("escapes unsafe html and blocks unsafe markdown links", () => {
    const html = renderChatMessageHtml('<img src=x onerror=alert(1)> [bad](javascript:alert(1))');

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('<a href="#" target="_blank" rel="noopener noreferrer">bad</a>');
    expect(html).not.toContain("javascript:alert");
  });

  test("maps same-origin workspace links from chat config", () => {
    globalThis.window = { location: { origin: "http://localhost" } };
    const html = renderChatMessageHtml(
      "[styles](http://localhost/Users/example/code/wingmanbefree/autopilot/src/ui/styles.css)",
      { config: { defaultDirectory: "/Users/example" } },
    );

    expect(html).toContain('href="/files/code/wingmanbefree/autopilot/src/ui/styles.css"');
  });

  test("caches rendered markdown for stable message metadata", () => {
    const options = {
      cacheKey: "session-1:assistant:10",
      cacheUpdatedAt: "2026-07-01T00:00:00.000Z",
    };
    const first = renderChatMessageHtml("## Cached\n\n- one", options);
    const afterFirst = getChatMessageHtmlCacheStats();
    const second = renderChatMessageHtml("## Cached\n\n- one", options);
    const afterSecond = getChatMessageHtmlCacheStats();

    expect(second).toBe(first);
    expect(afterFirst.size).toBe(1);
    expect(afterSecond.size).toBe(1);
  });

  test("invalidates cached markdown when message update timestamp changes", () => {
    const first = renderChatMessageHtml("**before**", {
      cacheKey: "session-1:assistant:10",
      cacheUpdatedAt: "2026-07-01T00:00:00.000Z",
    });
    const second = renderChatMessageHtml("**after**", {
      cacheKey: "session-1:assistant:10",
      cacheUpdatedAt: "2026-07-01T00:00:01.000Z",
    });

    expect(first).toContain("<strong>before</strong>");
    expect(second).toContain("<strong>after</strong>");
    expect(getChatMessageHtmlCacheStats().size).toBe(2);
  });

  test("keeps raw and cleaned message rendering in separate cache entries", () => {
    const options = {
      cacheKey: "session-1:assistant:10",
      cacheUpdatedAt: "2026-07-01T00:00:00.000Z",
    };
    const raw = renderChatMessageHtml("Cleartext should be\n  only relay-safe classification.", options);
    const cleaned = renderChatMessageHtml("Cleartext should be\n  only relay-safe classification.", {
      ...options,
      cleanAgentText: true,
    });

    expect(raw).toContain("Cleartext should be only relay-safe classification.");
    expect(cleaned).toContain("Cleartext should be only relay-safe classification.");
    expect(getChatMessageHtmlCacheStats().size).toBe(2);
  });

  test("builds stable cache options from live message rows", () => {
    expect(getChatMessageHtmlCacheOptions({
      id: 42,
      role: "assistant",
      updatedAt: "2026-07-01T00:00:01.000Z",
    }, { sessionId: "session-1" })).toEqual({
      cacheKey: "session-1:assistant:42",
      cacheUpdatedAt: "2026-07-01T00:00:01.000Z",
    });
  });

  test("renders working notes as a collapsible details block", () => {
    const html = renderWorkingNotesHtml("Checking files.\n\nRunning tests.");

    expect(html).toContain('class="wm-message-working-notes"');
    expect(html).toContain('data-testid="message-working-notes"');
    expect(html).toContain("data-working-notes-panel");
    expect(html).toContain('data-testid="message-working-notes-summary"');
    expect(html).toContain('aria-label="Close thinking messages"');
    expect(html).toContain('data-testid="message-working-notes-close"');
    expect(html).toContain('aria-label="Toggle thinking messages"');
    expect(html).toContain('data-working-notes-kind="thinking"');
    expect(html).toContain("Show thinking");
    expect(html).toContain("Hide thinking");
    expect(html).toContain("Checking files.");
    expect(html).toContain("Running tests.");
  });

  test("renders tool activity as a separately labelled collapsed panel", () => {
    const html = renderWorkingNotesHtml("Tool call: read", { workingNotesLabel: "Tools" });

    expect(html).toContain('data-working-notes-kind="tools"');
    expect(html).toContain('aria-label="Toggle tools messages"');
    expect(html).toContain("Show tools");
  });

  test("renders remembered working note open state", () => {
    const html = renderWorkingNotesHtml("Reviewing files.", {
      workingNotesKey: "session-1:message-1",
      workingNotesOpen: true,
    });

    expect(html).toContain('data-working-notes-key="session-1:message-1"');
    expect(html).toContain("data-working-notes-panel");
    expect(html).toContain(" open>");
  });
});
