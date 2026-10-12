import { expect } from "bun:test";

export async function measureLandscapeViewer(page: any) {
  await page.waitForTimeout(300);
  const measure = await page.evaluate(() => {
    const browser = globalThis as any;
    const root = browser.document.querySelector(".pipeline-viewer")!;
    const view = browser.Alpine.$data(root);
    const bounds = (element: any) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const graph = root.querySelector(".pipeline-viewer-scroll")!, inspector = root.querySelector(".pipeline-viewer-inspector")!;
    const open = !!inspector.getClientRects().length && browser.getComputedStyle(inspector).display !== "none";
    return { graph: bounds(graph), inspector: open ? bounds(inspector) : null,
      cards: [...root.querySelectorAll(".pipeline-viewer-step")].map(element => ({ key: element.dataset.nodeKey, opacity: browser.getComputedStyle(element).opacity, ...bounds(element) })),
      zoom: view.zoom, inspectorPosition: browser.getComputedStyle(inspector).position,
      pageWidth: browser.document.documentElement.scrollWidth, viewportWidth: browser.innerWidth, scrollWidth: graph.scrollWidth };
  });
  expect(measure.zoom).toBe(1);
  expect(measure.pageWidth).toBeLessThanOrEqual(measure.viewportWidth + 1);
  expect(measure.graph.width).toBeGreaterThan(measure.viewportWidth - (measure.viewportWidth > 850 ? 180 : 70));
  for (let index = 1; index < measure.cards.length; index++) expect(measure.cards[index].left).toBeGreaterThan(measure.cards[index - 1].right);
  for (const card of measure.cards) { expect(card.width).toBe(300); expect(card.opacity).toBe("1"); }
  expect(measure.scrollWidth).toBeGreaterThan(measure.graph.width);
  if (measure.inspector) {
    expect(measure.inspectorPosition).toBe("static");
    expect(measure.inspector.top).toBeGreaterThanOrEqual(measure.graph.bottom);
    expect(measure.inspector.width).toBeGreaterThanOrEqual(measure.graph.width - 1);
  }
  return measure;
}
