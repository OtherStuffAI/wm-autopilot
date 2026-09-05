import { afterEach, describe, expect, test } from "bun:test";

import { decorateSessionTabCompletion } from "./session-completion-indicator.js";

function createElement() {
  return {
    attributes: {},
    children: [],
    dataset: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    append(child) {
      this.children.push(child);
    },
  };
}

describe("session completion indicator", () => {
  const originalDocument = globalThis.document;

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  test("adds an accessible unread completion dot", () => {
    globalThis.document = { createElement };
    const button = createElement();

    const dot = decorateSessionTabCompletion(button, {
      displayName: "Research",
      tabState: "complete",
      unread: true,
    });

    expect(button.attributes["aria-label"]).toBe("Open Research (completed, unread)");
    expect(dot.className).toBe("wm-tab__completion-dot");
    expect(dot.dataset.testid).toBe("session-completion-unread");
    expect(dot.attributes["aria-hidden"]).toBe("true");
  });

  test("leaves non-completed tabs without a dot", () => {
    globalThis.document = { createElement };
    const button = createElement();

    const dot = decorateSessionTabCompletion(button, {
      displayName: "Research",
      tabState: "running",
      unread: false,
    });

    expect(dot).toBeNull();
    expect(button.children).toHaveLength(0);
    expect(button.attributes["aria-label"]).toBe("Open Research (running)");
  });
});
