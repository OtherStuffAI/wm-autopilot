import { describe, expect, test } from "bun:test";

import { buildEmptySessionInformation, createSessionInformationBubble } from "./session-information.js";

describe("empty session information", () => {
  test("describes an empty Goose ACP session without inventing an explicit model", () => {
    expect(buildEmptySessionInformation({
      agent: "goose",
      workingDirectory: "/Users/example/wingmen/agent-workspace",
      model: null,
      metadata: { agentTransport: "goose-acp" },
    })).toEqual({
      title: "Session information",
      agent: "Goose (ACP)",
      workingDirectory: "/Users/example/wingmen/agent-workspace",
      model: "default (provider default)",
    });
  });

  test("preserves an explicit model and describes Codex Agent API and ACP sessions", () => {
    expect(buildEmptySessionInformation({
      agent: "goose",
      workingDirectory: "/repo",
      model: "openrouter/anthropic/claude-opus-5-fast",
      metadata: { agentTransport: "goose-acp" },
    })?.model).toBe("openrouter/anthropic/claude-opus-5-fast");
    expect(buildEmptySessionInformation({
      agent: "codex",
      workingDirectory: "/repo",
      metadata: { agentTransport: "codex-acp" },
    })?.agent).toBe("Codex (ACP)");
    expect(buildEmptySessionInformation({
      agent: "codex",
      workingDirectory: "/repo",
      metadata: { agentTransport: "agentapi" },
    })?.agent).toBe("Codex (Agent API)");
    expect(buildEmptySessionInformation({
      agent: "claude",
      workingDirectory: "/repo",
      metadata: { agentTransport: "agentapi" },
    })).toBeNull();
  });

  test("renders the metadata as an accessible conversation bubble", () => {
    const originalDocument = globalThis.document;
    class FakeElement {
      constructor(tagName) {
        this.tagName = tagName;
        this.className = "";
        this.dataset = {};
        this.textContent = "";
        this.children = [];
      }

      append(...children) {
        this.children.push(...children);
      }
    }
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    try {
      const information = buildEmptySessionInformation({
        agent: "goose",
        workingDirectory: "/repo",
        metadata: { agentTransport: "goose-acp" },
      });
      const bubble = createSessionInformationBubble(information);
      expect(bubble.tagName).toBe("article");
      expect(bubble.dataset).toEqual({ role: "system", testid: "session-information-message" });
      expect(bubble.children[0]?.children[1]?.children.map((child) => child.textContent)).toEqual([
        "Agent", "Goose (ACP)",
        "Directory", "/repo",
        "Model", "default (provider default)",
      ]);
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
