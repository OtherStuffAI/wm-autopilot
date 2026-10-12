import { expect } from "bun:test";
import { assertViewerLayout } from "./pipeline-native-viewer-layout-check";

// Component captures omit the fixed shell header; shell captures retain it.
export async function captureViewer(page: any, path: string) {
  let layoutFailure: unknown;
  try { await assertViewerLayout(page); } catch (error) { layoutFailure = error; }
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  const headerStyle = await page.addStyleTag({content:".wm-header { visibility: hidden !important; }"});
  try {
    await page.getByTestId("pipeline-viewer").screenshot({path});
    await page.evaluate(() => {
      const document = (globalThis as any).document;
      const source = document.querySelector(".pipeline-viewer-canvas");
      const copy = source.cloneNode(true);
      copy.querySelectorAll("template").forEach((template: any) => template.remove());
      for (const element of [copy, ...copy.querySelectorAll("*")]) {
        for (const attribute of [...element.attributes]) {
          if (/^(x-|:|@)/.test(attribute.name)) element.removeAttribute(attribute.name);
        }
      }
      copy.setAttribute("x-ignore", "");
      copy.id = "pipeline-evidence-canvas";
      copy.style.position = "absolute";
      copy.style.left = "0";
      copy.style.top = "0";
      copy.style.zIndex = "99999";
      const style = (globalThis as any).getComputedStyle(document.body);
      copy.style.background = (globalThis as any).getComputedStyle(source.querySelector(".pipeline-viewer-step")).backgroundColor;
      copy.style.color = style.color;
      const wrapper = document.createElement("div");
      wrapper.className = "pipeline-viewer pipeline-viewer-layout";
      wrapper.dataset.mode = document.querySelector(".pipeline-viewer-layout").dataset.mode;
      wrapper.style.position = "absolute";
      wrapper.style.left = "0";
      wrapper.style.top = "0";
      wrapper.style.zIndex = "99999";
      wrapper.style.padding = "0";
      wrapper.style.width = source.style.width;
      wrapper.style.height = source.style.height;
      wrapper.setAttribute("x-ignore", "");
      wrapper.id = "pipeline-evidence-wrapper";
      const viewerStyle = (globalThis as any).getComputedStyle(document.querySelector(".pipeline-viewer"));
      wrapper.style.font = viewerStyle.font;
      for (const property of ["--pv-bg", "--pv-border"]) wrapper.style.setProperty(property, viewerStyle.getPropertyValue(property));
      wrapper.append(copy);
      document.body.append(wrapper);
    });
    try { await page.locator("#pipeline-evidence-canvas").screenshot({path:path.replace(".png", "-full-diagram.png")}); }
    finally { await page.locator("#pipeline-evidence-wrapper").evaluate((element: any) => element.remove()); }
  }
  finally { await headerStyle.evaluate((element: any) => element.remove()); }
  if (layoutFailure) throw layoutFailure;
}

export async function captureTimeline(page: any, fixture: any, width: number, evidenceDir?: string) {
  await page.goto(`${fixture.server.url}pipelines/definitions/${encodeURIComponent(fixture.timeline.id)}`);
  await page.getByTestId("pipeline-step-reply").waitFor();
  await assertViewerLayout(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme: string) => {
      (globalThis as any).document.documentElement.setAttribute("data-theme", theme);
      (globalThis as any).document.body.setAttribute("data-theme", theme);
    }, theme);
    if (evidenceDir) await captureViewer(page, `${evidenceDir}/timeline-${width}-${theme}-overview.png`);
  }
  await page.getByTestId("pipeline-select-reply").click();
  await assertViewerLayout(page);
  await page.getByTestId("pipeline-all-mappings").click();
  await assertViewerLayout(page);
  const metadata = page.getByTestId("pipeline-context-fields").getByRole("button", { name: /Inspect unclassified inputs: \$\.threadId/, exact: false });
  const routesBeforeHover = await page.locator(".pipeline-viewer-edges path").evaluateAll((paths: any[]) => paths.map(path => path.getAttribute("d")));
  await metadata.hover();
  await page.mouse.move(0, 0);
  expect(await page.locator(".pipeline-viewer-edges path").evaluateAll((paths: any[]) => paths.map(path => path.getAttribute("d")))).toEqual(routesBeforeHover);
  await metadata.click();
  const metadataRoutes = await page.evaluate(() => {
    const view = (globalThis as any).Alpine.$data((globalThis as any).document.querySelector(".pipeline-viewer"));
    return view.mapping.links.filter((link: any) => link.targetKey === "reply" && link.wire.carriedForward).map((link: any) => link.targetPath);
  });
  expect(metadataRoutes).toContain("$.threadId");
  expect(metadataRoutes).not.toContain("$.message");
  await page.locator('.pipeline-viewer-edges g[data-highlighted="true"]').first().waitFor({ state: "attached" });
  expect(await page.locator('.pipeline-viewer-edges g[data-highlighted="true"]').count()).toBeGreaterThan(0);
  expect(await page.getByTestId("pipeline-inspector").innerText()).toContain("$.threadId");
  expect(await page.getByTestId("pipeline-inspector").innerText()).toContain("No execution value exists");
  if (evidenceDir) await page.screenshot({path:`${evidenceDir}/timeline-${width}-selected-metadata.png`});
  await page.keyboard.press("Escape");
}
