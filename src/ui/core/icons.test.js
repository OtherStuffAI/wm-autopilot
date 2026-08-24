import { describe, expect, test } from "bun:test";

import {
  getConversationScrollElement,
  scrollConversationAreaToBottom,
} from "./icons.js";

describe("getConversationScrollElement", () => {
  test("uses the split-mode live scroll container when present", () => {
    const splitScroll = { nodeName: "scroll" };
    const conversation = {
      closest: (selector) => selector === ".wm-live-scroll" ? splitScroll : null,
    };
    const messageContainer = {
      closest: (selector) => selector === ".wm-live-conversation" ? conversation : null,
    };

    expect(getConversationScrollElement("session-1", new Map([["session-1", messageContainer]]))).toBe(splitScroll);
  });

  test("falls back to the conversation element outside split mode", () => {
    const conversation = {
      closest: () => null,
    };
    const messageContainer = {
      closest: (selector) => selector === ".wm-live-conversation" ? conversation : null,
    };

    expect(getConversationScrollElement("session-1", new Map([["session-1", messageContainer]]))).toBe(conversation);
  });
});

describe("scrollConversationAreaToBottom", () => {
  test("uses the split scroll container when no message container is registered", () => {
    let scrolledElement = null;
    const originalDocument = globalThis.document;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const splitScroll = {
      scrollHeight: 500,
      scrollTop: 0,
    };
    const conversation = {
      closest: (selector) => selector === ".wm-live-scroll" ? splitScroll : null,
    };

    globalThis.document = {
      querySelector: (selector) => selector === ".wm-live-conversation" ? conversation : null,
      scrollingElement: null,
      documentElement: {},
      body: {},
    };
    globalThis.requestAnimationFrame = (callback) => {
      callback();
      return 1;
    };

    try {
      scrollConversationAreaToBottom("session-1", new Map());
      scrolledElement = splitScroll;
    } finally {
      globalThis.document = originalDocument;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }

    expect(scrolledElement.scrollTop).toBe(500);
  });
});
