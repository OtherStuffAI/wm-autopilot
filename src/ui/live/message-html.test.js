import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registerMessageHtmlDirective } from "./message-html.js";

function createRenderer() {
  let directive;
  let update;
  let evaluateCount = 0;
  let mutationCount = 0;
  const destroyed = [];
  const initialized = [];
  const element = { children: [], innerHTML: "" };
  const Alpine = {
    directive(name, callback) {
      expect(name).toBe("message-html");
      directive = callback;
    },
    mutateDom(callback) { mutationCount++; callback(); },
    destroyTree(child) { destroyed.push(child); },
    initTree(node) { initialized.push(node); },
  };
  registerMessageHtmlDirective(Alpine);
  directive(element, { expression: "message.content" }, {
    effect(callback) { update = callback; },
    evaluateLater(expression) {
      expect(expression).toBe("message.content");
      return (receive) => { evaluateCount++; receive(element.nextHtml); };
    },
  });
  return {
    element, destroyed, initialized,
    render(html) { element.nextHtml = html; update(); },
    get mutationCount() { return mutationCount; },
    get evaluateCount() { return evaluateCount; },
  };
}

describe("stable chat message HTML", () => {
  test("keeps loaded image nodes through repeated identical message updates", () => {
    const renderer = createRenderer();
    const html = '<img src="/uploads/images/example.png" alt="upload">';
    renderer.render(html);
    const loadedImage = { complete: true, naturalHeight: 600 };
    renderer.element.children = [loadedImage];
    for (let i = 0; i < 20; i++) renderer.render(html);
    expect(renderer.evaluateCount).toBe(21);
    expect(renderer.mutationCount).toBe(1);
    expect(renderer.element.children[0]).toBe(loadedImage);
    expect(renderer.destroyed).toEqual([]);
    expect(renderer.initialized).toHaveLength(1);
  });

  test("updates edited or streaming content and cleans up previous Alpine children", () => {
    const renderer = createRenderer();
    renderer.render("First content");
    const previousChild = {};
    renderer.element.children = [previousChild];
    renderer.render("Changed content");
    expect(renderer.element.innerHTML).toBe("Changed content");
    expect(renderer.mutationCount).toBe(2);
    expect(renderer.destroyed).toEqual([previousChild]);
    expect(renderer.initialized).toHaveLength(2);
    expect(renderer.element._x_ignoreSelf).toBeUndefined();
  });

  test("renders empty content once and clears deleted content", () => {
    const renderer = createRenderer();
    renderer.render(null);
    renderer.render(undefined);
    expect(renderer.mutationCount).toBe(1);
    renderer.render("New content");
    renderer.render(null);
    expect(renderer.element.innerHTML).toBe("");
    expect(renderer.mutationCount).toBe(3);
  });

  test("chat message bodies use the guarded directive", () => {
    const source = readFileSync(new URL("./chat-component.js", import.meta.url), "utf8");
    expect(source).toContain("registerMessageHtmlDirective(Alpine)");
    expect(source).toContain('x-message-html="$store.chat.renderMessageContent(message)"');
    expect(source).not.toContain('x-html="$store.chat.renderMessageContent(message)"');
  });
});
