import { expect } from "bun:test";

// Execution is the primary graph. Field routes only appear on selection and do
// not require configured plumbing fields to occupy permanent card rows.
export async function assertViewerLayout(page: any) {
  await page.waitForFunction(() => {
    const root = (globalThis as any).document.querySelector(".pipeline-viewer");
    const view = (globalThis as any).Alpine.$data(root);
    return !view.layoutError && view.edges.length >= view.flow.links.length && view.diagramWidth > 0;
  });
  await page.waitForTimeout(250);
  const failures = await page.evaluate(() => {
    const root = (globalThis as any).document.querySelector(".pipeline-viewer")!;
    const view = (globalThis as any).Alpine.$data(root);
    const canvas = root.querySelector(".pipeline-viewer-canvas")!, origin = canvas.getBoundingClientRect();
    const cards: any[] = [...canvas.querySelectorAll(".pipeline-viewer-step")];
    const svg = canvas.querySelector("svg")!, failures: string[] = [];
    if (cards.length !== view.nodes.length) failures.push("Diagram must show every actual sibling step and no invented nodes");
    for (const edge of view.edges) {
      const group = svg.querySelector(`[data-testid="pipeline-wire-${edge.index}"]`);
      const path = group?.querySelector("path");
      if (!path) { failures.push("Defined edge missing rendered route"); continue; }
      const keys = edge.kind === "data" ? [edge.wire.sourceStepKey, edge.wire.targetStepKey] : [edge.wire.sourceKey, edge.wire.targetKey];
      for (const card of cards) {
        if (keys.includes(card.dataset.nodeKey)) continue;
        const bounds = card.getBoundingClientRect();
        for (let distance = 0; distance <= path.getTotalLength(); distance += 4) {
          const point = path.getPointAtLength(distance), x = point.x * view.zoom + origin.left, y = point.y * view.zoom + origin.top;
          if (x > bounds.left + 2 && x < bounds.right - 2 && y > bounds.top + 2 && y < bounds.bottom - 2) { failures.push(`Route crosses unrelated card ${card.dataset.nodeKey}`); break; }
        }
      }
      const label = group?.querySelector("text"), box = label?.getBoundingClientRect(), svgBounds = svg.getBoundingClientRect();
      if (label?.textContent && box && (box.left < svgBounds.left - 1 || box.top < svgBounds.top - 1 || box.right > svgBounds.right + 1 || box.bottom > svgBounds.bottom + 1)) failures.push(`Clipped label ${label.textContent}`);
    }
    return failures;
  });
  expect(failures).toEqual([]);
}

export async function assertScopeInputSelection(page: any) {
  await page.getByTestId("pipeline-select-prepare").click();
  expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("$.request");
  expect(await page.getByTestId("pipeline-selected-connections").innerText()).toContain("Pipeline input");
  await page.keyboard.press("Escape");
}

export async function assertExpandedEvidenceLayout(page: any) {
  await assertViewerLayout(page);
  const card = page.getByTestId("pipeline-step-prepare");
  const before = await card.evaluate((element: any) => [element.style.left, element.style.top, element.offsetHeight]);
  await page.getByTestId("pipeline-select-prepare").click();
  await page.getByTestId("pipeline-step-details").locator("details").first().locator("summary").click();
  await assertViewerLayout(page);
  expect(await card.evaluate((element: any) => [element.style.left, element.style.top, element.offsetHeight])).toEqual(before);
  await page.keyboard.press("Escape");
}
