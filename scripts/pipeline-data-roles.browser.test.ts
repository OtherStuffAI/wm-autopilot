import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createNativeViewerFixture, fixtureOwner } from "./pipeline-native-viewer-fixture";
import { viewerDefinition } from "../src/pipelines/pipeline-viewer-dto";
import { assertViewerLayout } from "./pipeline-native-viewer-layout-check";
import { captureViewer } from "./pipeline-native-viewer-captures";
import { measureLandscapeViewer } from "./pipeline-landscape-layout-check";
import type { PipelineDefinitionRecord } from "../src/pipelines/pipeline-loader";

const browserTest = process.env.PLAYWRIGHT_MODULE ? test : test.skip;
browserTest("actual do-and-review roles: operation data, nested provenance, instructions and carried mappings", async () => {
  const spec = JSON.parse(readFileSync(process.env.PIPELINE_DATA_ROLES_DEFINITION || "src/pipelines/default-definitions/do-and-review.json", "utf8"));
  const record = { id: "data-roles-review", name: spec.name, spec, scope: "shared", path: "isolated-source-fixture" } as PipelineDefinitionRecord;
  const fixture = await createNativeViewerFixture();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const evidence = process.env.PIPELINE_DATA_ROLES_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript((npub: string) => localStorage.setItem("wingman-identity-state", JSON.stringify({ npub, method: "session", authenticated: true, expiresAt: Date.now() + 600000 })), fixtureOwner);
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.route("**/api/scheduler/identities", route => route.fulfill({ json: { identities: [] } }));
      await page.route("**/api/pipelines/definitions", route => route.fulfill({ json: { definitions: [{ ...record, ...spec }] } }));
      await page.route("**/api/pipelines/viewer/definitions/data-roles-review", route => route.fulfill({ json: { version: 1, serviceId: "native", definition: viewerDefinition(record) } }));
      await page.goto(`${fixture.server.url}pipelines/definitions/data-roles-review`);
      await page.getByTestId("pipeline-step-do-work").waitFor();
      await assertViewerLayout(page);
      const initialMeasure = await measureLandscapeViewer(page);
      if (evidence) await page.screenshot({path: `${evidence}/initial-viewport-${viewport.width}.png`});
      expect(initialMeasure.cards[0].top).toBeLessThan(viewport.height - 100);
      if (viewport.width > 850) expect(initialMeasure.cards[0].bottom).toBeLessThan(viewport.height);
      expect(await page.getByTestId("pipeline-definition-metadata").getAttribute("open")).toBeNull();
      if (evidence) await page.screenshot({path: `${evidence}/initial-viewport-${viewport.width}.png`});
      if (evidence) writeFileSync(`${evidence}/measurements-${viewport.width}.json`, JSON.stringify(initialMeasure, null, 2));
      const scroll = page.getByTestId("pipeline-graph-scroll");
      await scroll.focus();
      await page.keyboard.press("End");
      expect(await scroll.evaluate((element: HTMLElement) => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)).toBe(true);
      await page.keyboard.press("Home");
      expect(await scroll.evaluate((element: HTMLElement) => element.scrollLeft)).toBe(0);
      await page.keyboard.press("ArrowRight");
      expect(await scroll.evaluate((element: HTMLElement) => element.scrollLeft)).toBeGreaterThan(0);
      await page.getByLabel("First pipeline step", { exact: true }).click();
      expect(await scroll.evaluate((element: HTMLElement) => element.scrollLeft)).toBe(0);
      await page.getByLabel("Last pipeline step", { exact: true }).click();
      expect(await scroll.evaluate((element: HTMLElement) => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)).toBe(true);
      await page.getByLabel("First pipeline step", { exact: true }).click();
      await scroll.evaluate((element: HTMLElement) => element.scrollIntoView({ block: "center" }));
      const scrollBox = await scroll.boundingBox();
      await page.mouse.move(scrollBox!.x + 20, Math.max(90, scrollBox!.y + 80));
      await page.mouse.wheel(280, 0);
      await page.waitForTimeout(100);
      expect(await scroll.evaluate((element: HTMLElement) => element.scrollLeft)).toBeGreaterThan(0);
      await page.getByLabel("First pipeline step", { exact: true }).click();
      await page.getByTestId("pipeline-fit").click();
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => (window as any).Alpine.$data(document.querySelector(".pipeline-viewer")).zoom)).toBeLessThan(1);
      await page.getByLabel("Show pipeline at actual size", { exact: true }).click();
      await measureLandscapeViewer(page);
      expect(await page.locator('.pipeline-viewer-edges g[data-kind="data"]').count()).toBeGreaterThan(0);
      expect(await page.locator('.pipeline-viewer-edges g[data-kind="data"][data-highlighted="false"]').count()).toBe(0);
      const externalInteriorCrossings = await page.evaluate(() => {
        const root = document.querySelector(".pipeline-viewer")!;
        const view = (window as any).Alpine.$data(root);
        const canvas = root.querySelector(".pipeline-viewer-canvas")!, origin = canvas.getBoundingClientRect();
        const failures: string[] = [];
        view.diagramDataGroups.forEach((group: any, index: number) => {
          if (group.sourceKey !== "@scope-input") return;
          const card = [...root.querySelectorAll(".pipeline-viewer-step")].find((element: any) => element.dataset.nodeKey === group.targetKey)!;
          const bounds = card.getBoundingClientRect();
          const path = root.querySelector(`[data-testid="pipeline-wire-data-${index}"] path`) as SVGPathElement;
          for (let distance = 0; distance < path.getTotalLength(); distance += 1) {
            const point = path.getPointAtLength(distance), x = point.x * view.zoom + origin.left, y = point.y * view.zoom + origin.top;
            if (x > bounds.left + 1 && x < bounds.right - 1 && y > bounds.top + 1 && y < bounds.bottom - 1) { failures.push(group.targetKey); break; }
          }
        });
        return failures;
      });
      expect(externalInteriorCrossings).toEqual([]);
      const state = () => page.evaluate(() => {
        const view = (window as any).Alpine.$data(document.querySelector(".pipeline-viewer"));
        return { links: view.mapping.links, selected: view.selectedLinks, all: view.showAllMappings, groups: view.dataGroups, unclassified: view.selectedStep ? view.unclassifiedPorts(view.selectedStep,"inputs").length + view.unclassifiedPorts(view.selectedStep,"outputs").length : 0 };
      });
      expect((await state()).groups.length).toBeGreaterThan(0);
      expect(await page.getByTestId("pipeline-step-do-work").getByTestId("pipeline-operation-connections").innerText()).toContain("Original request");
      expect(await page.getByTestId("pipeline-step-manager-review").getByTestId("pipeline-operation-connections").innerText()).toContain("Do work");
      const links = (await state()).links;
      expect(links.some((link: any) => link.targetKey === "do-work" && link.targetPath === "$.workPlan.originalPrompt" && link.sourcePath === "$.workPlan.originalPrompt")).toBe(true);
      expect(links.some((link: any) => link.targetKey === "manager-review" && link.targetPath === "$.workerOutput" && link.sourceKey === "do-work" && link.sourcePath === "$.result")).toBe(true);
      if (evidence) { await page.screenshot({ path: `${evidence}/default-${viewport.width}.png`, fullPage: true }); await captureViewer(page, `${evidence}/overview-${viewport.width}.png`); }
      const positions = () => page.locator(".pipeline-viewer-step").evaluateAll((cards: HTMLElement[]) => cards.map(card => [card.style.left, card.style.top, card.offsetHeight]));
      const initialPositions = await positions();
      for (const key of ["do-work", "manager-review"]) {
        await page.getByTestId(`pipeline-select-${key}`).scrollIntoViewIfNeeded();
        const beforeSelection = await scroll.evaluate((element: HTMLElement) => element.scrollLeft);
        await page.getByTestId(`pipeline-select-${key}`).click();
        expect(await scroll.evaluate((element: HTMLElement) => element.scrollLeft)).toBe(beforeSelection);
        await assertViewerLayout(page);
        const selectedMeasure = await measureLandscapeViewer(page);
        if (evidence) {
          writeFileSync(`${evidence}/${key}-measurements-${viewport.width}.json`, JSON.stringify(selectedMeasure, null, 2));
          await page.getByTestId("pipeline-graph-scroll").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${evidence}/${key}-process-${viewport.width}.png` });
          const hiddenHeader = await page.addStyleTag({ content: ".wm-header{visibility:hidden!important}" });
          await page.getByTestId("pipeline-inspector").screenshot({ path: `${evidence}/${key}-details-${viewport.width}.png` });
          await hiddenHeader.evaluate((element: HTMLElement) => element.remove());
        }
        expect(await positions()).toEqual(initialPositions);
        expect(await page.getByTestId("pipeline-context-fields").isVisible()).toBe(false);
        expect((await state()).all).toBe(false);
        expect((await state()).selected.length).toBeGreaterThan(0);
        expect(await page.getByTestId("pipeline-selected-connections").isVisible()).toBe(true);
        expect((await state()).selected.every((link: any) => link.targetPath !== "$.reporting" && link.targetPath !== "$.taskId")).toBe(true);
        await page.getByLabel("Inspect configured agent instructions", { exact: true }).click();
        expect(await page.getByTestId("pipeline-agent-instructions").innerText()).toBe(spec.steps.find((step: any) => step.name === key).prompt);
        expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("Original request");
        if (evidence) {
          await page.screenshot({ path: `${evidence}/${key}-${viewport.width}.png`, fullPage: true });
          await page.getByTestId("pipeline-agent-instructions").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${evidence}/${key}-instructions-${viewport.width}.png` });
        }
        await page.getByTestId("pipeline-all-mappings").click();
        await page.getByTestId("pipeline-context-fields").waitFor({ state: "visible" });
        expect(await page.getByTestId("pipeline-context-fields").isVisible()).toBe(true);
        expect(await page.getByTestId("pipeline-context-fields").innerText()).toContain("Carried context");
        expect(await page.getByTestId("pipeline-context-fields").getByText("Unclassified fields", { exact: true }).isVisible()).toBe((await state()).unclassified > 0);
        expect(await page.getByTestId("pipeline-all-mappings-details").isVisible()).toBe(true);
        await measureLandscapeViewer(page);
        await assertViewerLayout(page);
        if (evidence) {
          await page.screenshot({ path: `${evidence}/${key}-all-${viewport.width}.png`, fullPage: true });
          await page.getByTestId("pipeline-context-fields").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${evidence}/${key}-context-${viewport.width}.png` });
        }
        await page.getByTestId("pipeline-all-mappings").click();
        await page.getByTestId("pipeline-context-fields").waitFor({ state: "hidden" });
        await page.keyboard.press("Escape");
      }
      const legacy = viewerDefinition(record);
      for (const step of legacy.steps) {
        step.title = step.name;
        step.inputs = []; step.outputs = [];
        if (step.review) delete step.review.display;
      }
      await page.route("**/api/pipelines/viewer/definitions/data-roles-review", route => route.fulfill({ json: { version: 1, serviceId: "native", definition: legacy } }));
      await page.reload();
      await page.getByTestId("pipeline-select-manager-review").click();
      expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("Manager review");
      expect(await page.getByTestId("pipeline-step-details").getByText("Operation inputs and outputs", { exact: true }).isVisible()).toBe(false);
      expect(await page.getByTestId("pipeline-step-details").getByText("Review validation", { exact: true }).isVisible()).toBe(false);
      await page.getByLabel("Inspect technical diagnostics", { exact: true }).click();
      expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("No domain display fields");
      await page.getByTestId("pipeline-all-mappings").click();
      expect(await page.getByTestId("pipeline-context-fields").innerText()).toContain("Unclassified fields");
      expect(errors).toEqual([]);
      await context.close();
    }
  } finally { await browser.close(); await fixture.close(); }
}, 120000);
