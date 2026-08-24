import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  findNextPromptRectIndex,
  findPreviousPromptRectIndex,
  isMessageRectAboveView,
  isMessageRectBelowView,
  isMessageRectInView,
} from "./scroll-pill.js";

const source = readFileSync(new URL("./scroll-pill.js", import.meta.url), "utf8");
const liveViewSource = readFileSync(new URL("../views/live-view.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("last prompt pill visibility helpers", () => {
  const scrollRect = {
    top: 100,
    bottom: 700,
  };

  test("identifies the last prompt as above the viewport at the bottom of a long response", () => {
    const lastPromptRect = {
      top: 20,
      bottom: 80,
    };

    expect(isMessageRectInView(lastPromptRect, scrollRect, 12)).toBe(false);
    expect(isMessageRectAboveView(lastPromptRect, scrollRect, 12)).toBe(true);
  });

  test("does not treat a later prompt below the viewport as above the viewport", () => {
    const laterPromptRect = {
      top: 760,
      bottom: 820,
    };

    expect(isMessageRectInView(laterPromptRect, scrollRect, 12)).toBe(false);
    expect(isMessageRectAboveView(laterPromptRect, scrollRect, 12)).toBe(false);
  });

  test("keeps an in-view prompt hidden", () => {
    const visiblePromptRect = {
      top: 180,
      bottom: 260,
    };

    expect(isMessageRectInView(visiblePromptRect, scrollRect, 12)).toBe(true);
    expect(isMessageRectAboveView(visiblePromptRect, scrollRect, 12)).toBe(false);
  });

  test("identifies the latest message hidden below the visual viewport", () => {
    const latestMessageRect = {
      top: 620,
      bottom: 820,
    };

    expect(isMessageRectBelowView(latestMessageRect, scrollRect)).toBe(true);
  });

  test("finds the nearest prompt above the current scroll anchor", () => {
    const promptRects = [
      { top: -820, bottom: -760 },
      { top: -220, bottom: -160 },
      { top: 132, bottom: 190 },
      { top: 460, bottom: 520 },
    ];

    expect(findPreviousPromptRectIndex(promptRects, 150)).toBe(2);
  });

  test("does not select the prompt already aligned to the scroll anchor", () => {
    const promptRects = [
      { top: -300, bottom: -240 },
      { top: 142, bottom: 210 },
    ];

    expect(findPreviousPromptRectIndex(promptRects, 150)).toBe(0);
  });

  test("finds the nearest prompt below the current scroll anchor", () => {
    const promptRects = [
      { top: -300, bottom: -240 },
      { top: 142, bottom: 210 },
      { top: 430, bottom: 500 },
      { top: 900, bottom: 970 },
    ];

    expect(findNextPromptRectIndex(promptRects, 150)).toBe(2);
  });

  test("does not select the next prompt already aligned to the scroll anchor", () => {
    const promptRects = [
      { top: 150, bottom: 210 },
      { top: 420, bottom: 480 },
    ];

    expect(findNextPromptRectIndex(promptRects, 150)).toBe(1);
  });

  test("mounts the last prompt pill in the composer control row", () => {
    expect(source).toContain("const pillParent = parent;");
    expect(source).toContain("pillParent.appendChild(button);");
    expect(source).not.toContain("const pillParent = document.body || parent;");
  });

  test("assigns dock classes to scroll pills", () => {
    expect(source).toContain('className: "wm-scroll-pill wm-scroll-pill--last-prompt"');
    expect(source).toContain('className: "wm-scroll-pill wm-scroll-pill--next-prompt"');
    expect(source).toContain('className: "wm-scroll-pill wm-scroll-pill--scroll-bottom"');
  });

  test("uses title-case labels for the scroll pills", () => {
    expect(source).toContain('text: "Last Prompt"');
    expect(source).toContain('text: "Next Prompt"');
    expect(source).toContain('text: "Scroll to End"');
  });

  test("passes the conversation element to all pill attachments in display order", () => {
    expect(liveViewSource).toContain("scrollPill.attachLastPromptPill(composerEl, scrollTarget, conversationEl);\n      scrollPill.attachNextPromptPill(composerEl, scrollTarget, conversationEl);\n      scrollPill.attachScrollPill(composerEl, scrollTarget, conversationEl);");
    expect(liveViewSource).toContain("scrollPill.attachNextPromptPill(composerEl, scrollTarget, conversationEl);");
    expect(liveViewSource).toContain("scrollPill.attachScrollPill(composerEl, scrollTarget, conversationEl);");
    expect(liveViewSource).toContain("scrollPill.attachLastPromptPill(composerEl, scrollTarget, conversationEl);");
  });

  test("reveals scroll pills for three seconds after scroll activity", () => {
    expect(source).toContain("const PILL_VISIBLE_DURATION_MS = 3000;");
    expect(source).toContain("function revealScrollPillsForDuration()");
    expect(source).toContain("revealPillForDuration(nextPromptPillState);");
    expect(source).toContain("function handleScrollActivity()");
    expect(source).toContain("setTimeout(() =>");
    expect(source).toContain("}, PILL_VISIBLE_DURATION_MS);");
  });

  test("last prompt click targets the previous prompt above the viewport", () => {
    expect(source).toContain("function getPreviousUserMessageAboveScroll(conversationElement, scrollElement)");
    expect(source).toContain("findPreviousPromptRectIndex(");
    expect(source).toContain("scrollToElementAtTop(lastPromptPillState.scrollTarget, previousMessage);");
    expect(source).not.toContain("scrollToElementAtTop(lastPromptPillState.scrollTarget, latestMessage);");
  });

  test("next prompt click targets the next prompt below the viewport", () => {
    expect(source).toContain("function getNextUserMessageBelowScroll(conversationElement, scrollElement)");
    expect(source).toContain("findNextPromptRectIndex(");
    expect(source).toContain("scrollToElementAtTop(nextPromptPillState.scrollTarget, nextMessage);");
  });

  test("keeps last and scroll pills in place with next prompt centered", () => {
    const lastPromptRule = styles.match(/\.wm-scroll-pill--last-prompt\s*\{(?<body>[^}]+)\}/);
    const nextPromptRule = styles.match(/\.wm-scroll-pill--next-prompt\s*\{(?<body>[^}]+)\}/);
    const scrollBottomRule = styles.match(/\.wm-scroll-pill--scroll-bottom\s*\{(?<body>[^}]+)\}/);

    expect(lastPromptRule?.groups?.body).toContain("left: 25%;");
    expect(lastPromptRule?.groups?.body).toContain("transform: translateX(-50%);");
    expect(nextPromptRule?.groups?.body).toContain("left: 50%;");
    expect(nextPromptRule?.groups?.body).toContain("transform: translateX(-50%);");
    expect(scrollBottomRule?.groups?.body).toContain("left: 75%;");
    expect(scrollBottomRule?.groups?.body).toContain("transform: translateX(-50%);");
  });

  test("fades scroll pills through data-visible state", () => {
    expect(styles).toContain('.wm-scroll-pill[data-visible="true"]');
    expect(styles).toContain("opacity: 0;");
    expect(styles).toContain("opacity: 1;");
    expect(styles).toContain("pointer-events: none;");
    expect(styles).toContain("pointer-events: auto;");
  });
});
