import { expect } from "bun:test";

export async function measureVerticalViewer(page: any) {
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
    const cards = [...root.querySelectorAll(".pipeline-viewer-step")].map(element => ({ key: (element as any).dataset.nodeKey, ...bounds(element) }));
    const selected = cards.find(card => card.key === (view.selectedStepKey || view.inspectLabel));
    return { graph: bounds(graph), inspector: open ? bounds(inspector) : null, cards, selected, zoom: view.zoom,
      inspectorPosition: browser.getComputedStyle(inspector).position, pageWidth: browser.document.documentElement.scrollWidth, viewportWidth: browser.innerWidth };
  });
  expect(measure.zoom).toBeGreaterThanOrEqual(0.85);
  expect(measure.pageWidth).toBeLessThanOrEqual(measure.viewportWidth + 1);
  for (let index = 1; index < measure.cards.length; index++) expect(measure.cards[index].top).toBeGreaterThan(measure.cards[index - 1].bottom);
  if (measure.inspector) {
    expect(["fixed", "absolute"]).not.toContain(measure.inspectorPosition);
    if (measure.viewportWidth > 850) expect(measure.inspector.left).toBeGreaterThanOrEqual(measure.graph.right);
    else expect(measure.inspector.top).toBeGreaterThanOrEqual(measure.graph.bottom);
    if (measure.selected) {
      expect(measure.selected.left).toBeGreaterThanOrEqual(measure.graph.left - 1);
      expect(measure.selected.right).toBeLessThanOrEqual(measure.graph.right + 1);
      expect(measure.selected.top).toBeGreaterThanOrEqual(measure.graph.top - 1);
      expect(measure.selected.bottom).toBeLessThanOrEqual(measure.graph.bottom + 1);
    }
  }
  return measure;
}
