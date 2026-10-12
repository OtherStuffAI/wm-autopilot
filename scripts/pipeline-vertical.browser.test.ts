import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createNativeViewerFixture, fixtureOwner } from "./pipeline-native-viewer-fixture";
import { viewerDefinition } from "../src/pipelines/pipeline-viewer-dto";
import type { PipelineDefinitionRecord } from "../src/pipelines/pipeline-loader";
import { assertViewerLayout } from "./pipeline-native-viewer-layout-check";
import { measureVerticalViewer } from "./pipeline-vertical-layout-check";

const browserTest = process.env.PLAYWRIGHT_MODULE && process.env.PIPELINE_VERTICAL_DEFINITIONS_ROOT ? test : test.skip;
browserTest("vertical real definitions: readable fit and nonoverlapping docked details", async () => {
  const fixture = await createNativeViewerFixture();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const evidence = process.env.PIPELINE_REVIEW_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const cases = [
    { file: "shared/definitions/do-and-review.json", id: "shared:c6e416694fa4", label: "do-and-review" },
    { file: "shared/definitions/agent-direct-context.v1.json", id: "shared:88d015ea59bf", label: "agent-direct-context" },
    { file: "users/honest-ivory-thicket/definitions/freedomtools-build.v1.json", id: "user:honest-ivory-thicket:3298c7be2209", label: "freedom-tools" },
  ];
  const measurements: any[] = [];
  try {
    for (const viewport of [{ width: 1680, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript((npub: string) => localStorage.setItem("wingman-identity-state", JSON.stringify({ npub, method: "session", authenticated: true, expiresAt: Date.now() + 600000 })), fixtureOwner);
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.route("**/api/scheduler/identities", route => route.fulfill({ json: { identities: [] } }));
      for (const entry of cases) {
        const path = `${process.env.PIPELINE_VERTICAL_DEFINITIONS_ROOT}/${entry.file}`;
        expect(entry.id.endsWith(createHash("sha256").update(path).digest("hex").slice(0, 12))).toBe(true);
        const spec = JSON.parse(readFileSync(path, "utf8"));
        const record = { id: entry.id, name: spec.name, spec, scope: entry.id.startsWith("shared:") ? "shared" : "user", path } as PipelineDefinitionRecord;
        await page.route("**/api/pipelines/definitions", route => route.fulfill({ json: { definitions: [{ ...record, ...spec }] } }));
        await page.route(`**/api/pipelines/definitions/${encodeURIComponent(entry.id)}`, route => route.fulfill({ json: { definition: record } }));
        await page.route(`**/api/pipelines/viewer/definitions/${encodeURIComponent(entry.id)}`, route => route.fulfill({ json: { version: 1, serviceId: "native", definition: viewerDefinition(record) } }));
        await page.goto(`${fixture.server.url}pipelines/definitions/${encodeURIComponent(entry.id)}`);
        await page.locator('.pipeline-viewer-edges g[data-kind="execution"]').first().waitFor({ state: "attached" });
        await assertViewerLayout(page);
        expect(await page.locator(".pipeline-viewer-step").count()).toBe(spec.steps.length);
        const closed = await measureVerticalViewer(page);
        if (entry.label === "do-and-review") expect(await page.locator(".pipeline-review-condition").allTextContents()).toContain('When reporting mode is "flightdeck_task"');
        const selects = page.locator(".pipeline-review-select");
        await selects.last().focus(); await page.keyboard.press("Enter");
        await page.getByTestId("pipeline-step-details").waitFor();
        await page.getByTestId("pipeline-fit").click();
        const open = await measureVerticalViewer(page);
        await assertViewerLayout(page);
        expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("Configuration and agent prompt");
        if (evidence) await page.screenshot({ fullPage: true, path: `${evidence}/${entry.label}-inspector-${viewport.width}.png` });
        await page.getByRole("button", { name: "Close value inspector", exact: true }).click();
        await page.getByTestId("pipeline-fit").click();
        const reopened = await measureVerticalViewer(page);
        expect(reopened.graph.width).toBeCloseTo(closed.graph.width, 0);
        const port = page.locator('.pipeline-viewer-step [data-port-path]').first();
        if (await port.count()) {
          await port.click();
          await measureVerticalViewer(page);
          await assertViewerLayout(page);
          if (evidence) await page.screenshot({ fullPage: true, path: `${evidence}/${entry.label}-data-${viewport.width}.png` });
          await page.keyboard.press("Escape");
        }
        await page.mouse.move(0,0);
        await page.getByTestId("pipeline-fit").click();
        await page.waitForTimeout(400);
        await page.locator(".pipeline-viewer-scroll").evaluate((element: HTMLElement) => { element.scrollTop = 0; element.scrollLeft = 0; });
        await page.waitForTimeout(250);
        if (evidence) {
          await page.screenshot({ fullPage: true, path: `${evidence}/${entry.label}-${viewport.width}.png` });
        }
        measurements.push({ definition: entry.id, viewport, closed, open, afterClose: reopened });
      }
      expect(errors).toEqual([]);
      await context.close();
    }
    if (evidence) writeFileSync(`${evidence}/measurements.json`, JSON.stringify(measurements, null, 2));
  } finally { await browser.close(); await fixture.close(); }
}, 180000);
