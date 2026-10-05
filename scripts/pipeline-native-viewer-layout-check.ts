import { expect } from "bun:test";

export async function assertViewerLayout(page: any) {
  await page.locator(".pipeline-viewer-edges g").first().waitFor();
  await page.waitForFunction(() => {
    const root = (globalThis as any).document.querySelector(".pipeline-viewer");
    const view = (globalThis as any).Alpine.$data(root);
    return view.edges.length === view.mapping.links.length && view.edges.length > 0;
  });
  await page.waitForTimeout(150);
  let failures: string[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    failures = await page.evaluate(() => {
    const root = (globalThis as any).document.querySelector(".pipeline-viewer");
    const view = (globalThis as any).Alpine.$data(root);
    const canvas = root.querySelector(".pipeline-viewer-canvas");
    const origin = canvas.getBoundingClientRect();
    const cards = [...canvas.querySelectorAll(".pipeline-viewer-step")];
    const failures: string[] = [];
    const svg = canvas.querySelector("svg");
    if ((globalThis as any).innerWidth <= 850 && view.definition?.name?.startsWith("bird.")) for (const card of cards as any[]) {
      const bounds = card.getBoundingClientRect();
      if (bounds.left - origin.left < -1 || bounds.right - origin.left > root.querySelector(".pipeline-viewer-diagram").clientWidth) failures.push(`Mobile card outside viewport: ${card.dataset.nodeKey} x=${Math.round(bounds.left - origin.left)}..${Math.round(bounds.right - origin.left)}`);
    }
    for (const edge of view.edges) {
      const link = view.mapping.links[Number(edge.index)];
      if (!link) { failures.push("Edge lacks actual wiring mapping"); continue; }
      const group = svg.querySelector(`[data-testid="pipeline-wire-${edge.index}"]`);
      const path = group?.querySelector("path");
      if (!path) { failures.push("ELK edge missing rendered route"); continue; }
      const find = (key: string, side: string, field: string) => [...canvas.querySelectorAll("[data-port-node]")].find((port: any) => port.dataset.portNode === key && port.dataset.portSide === side && port.dataset.portPath === field) as any;
      for (const [key, side, field, distance] of [[link.sourceKey, "outputs", link.sourcePath, 0], [link.targetKey, "inputs", link.targetPath, path.getTotalLength()]]) {
        const port = find(key, side, field);
        if (!port) { failures.push(`Missing exact ${side} field ${field}`); continue; }
        const bounds = port.getBoundingClientRect(), card = port.closest(".pipeline-viewer-step").getBoundingClientRect();
        const point = path.getPointAtLength(distance);
        if (Math.abs(point.y - (bounds.top + bounds.height / 2 - origin.top)) > 2 || Math.abs(point.x - ((side === "outputs" || (globalThis as any).innerWidth <= 850 ? card.right : card.left) - origin.left)) > 2) failures.push(`Endpoint misses ${key} ${field}`);
      }
      for (const card of cards as any[]) {
        if ([link.sourceKey, link.targetKey].includes(card.dataset.nodeKey)) continue;
        const bounds = card.getBoundingClientRect();
        for (let distance = 0; distance <= path.getTotalLength(); distance += 4) {
          const point = path.getPointAtLength(distance), x = point.x + origin.left, y = point.y + origin.top;
          if (x > bounds.left + 1 && x < bounds.right - 1 && y > bounds.top + 1 && y < bounds.bottom - 1) { failures.push(`Route crosses unrelated card ${card.dataset.nodeKey}`); break; }
        }
      }
      const label = group.querySelector("text"), box = label.getBoundingClientRect(), svgBounds = svg.getBoundingClientRect();
      if (box.left < svgBounds.left - 1 || box.top < svgBounds.top - 1 || box.right > svgBounds.right + 1 || box.bottom > svgBounds.bottom + 1) failures.push(`Clipped label ${label.textContent}`);
    }
    return failures;
    });
    if (!failures.length) break;
    await page.waitForTimeout(100);
  }
  expect(failures).toEqual([]);
}

export async function assertScopeInputSelection(page: any) {
  const source = page.getByTestId("pipeline-port-@scope-input-outputs-$.request");
  await source.click();
  await page.locator('.pipeline-viewer-edges g[data-highlighted="true"]').first().waitFor();
  expect(await source.getAttribute("data-selected")).toBe("true");
  expect(await page.getByTestId("pipeline-step-@scope-input").getAttribute("data-highlighted")).toBe("true");
  await page.keyboard.press("Escape");
}

export async function assertExpandedEvidenceLayout(page: any) {
  const card = page.getByTestId("pipeline-step-prepare");
  const detail = card.locator("details").first();
  const previousHeight = await card.evaluate((element: any) => element.getBoundingClientRect().height);
  await detail.locator("summary").click();
  expect(await card.evaluate((element: any) => element.getBoundingClientRect().height)).toBeGreaterThan(previousHeight);
  await assertViewerLayout(page);
  await detail.locator("summary").click();
  await assertViewerLayout(page);
}
