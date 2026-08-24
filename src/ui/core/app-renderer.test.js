import { describe, expect, test } from "bun:test";

import { renderRouteErrorView, shouldFullRenderOnSessionUpdate } from "./app-renderer.js";

describe("shouldFullRenderOnSessionUpdate", () => {
  test("skips full rerenders for stable long-lived routes", () => {
    expect(shouldFullRenderOnSessionUpdate("files")).toBe(false);
    expect(shouldFullRenderOnSessionUpdate("home")).toBe(false);
    expect(shouldFullRenderOnSessionUpdate("live")).toBe(false);
    expect(shouldFullRenderOnSessionUpdate("pipelines")).toBe(false);
    expect(shouldFullRenderOnSessionUpdate("settings")).toBe(false);
    expect(shouldFullRenderOnSessionUpdate("terminal")).toBe(false);
  });

  test("keeps full rerenders for other routes", () => {
    expect(shouldFullRenderOnSessionUpdate("jobs")).toBe(true);
  });
});

describe("renderRouteErrorView", () => {
  test("renders a visible route error panel", () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement: (tagName) => ({
        tagName,
        className: "",
        dataset: {},
        attributes: {},
        children: [],
        _textContent: "",
        set textContent(value) {
          this._textContent = String(value ?? "");
        },
        get textContent() {
          return [
            this._textContent,
            ...this.children.map((child) => child.textContent),
          ].join("");
        },
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        append(...children) {
          this.children.push(...children);
        },
      }),
    };

    const view = renderRouteErrorView("home", new Error("Boom"));

    expect(view.dataset.testid).toBe("route-render-error");
    expect(view.getAttribute("role")).toBe("alert");
    expect(view.textContent).toContain("This view failed to render");
    expect(view.textContent).toContain("home: Boom");
    globalThis.document = originalDocument;
  });
});
