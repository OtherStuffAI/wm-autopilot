import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { createNativeViewerFixture, fixtureOwner } from "./pipeline-native-viewer-fixture";
import { viewerDefinition } from "../src/pipelines/pipeline-viewer-dto";
import { assertViewerLayout } from "./pipeline-native-viewer-layout-check";
import type { PipelineDefinitionRecord } from "../src/pipelines/pipeline-loader";

const browserTest = process.env.PLAYWRIGHT_MODULE ? test : test.skip;
browserTest("compact review in production shell: branches, data, keyboard, loops and actual children", async () => {
  const fixture = await createNativeViewerFixture();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const evidence = process.env.PIPELINE_REVIEW_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  try {
    for (const viewport of [{ width: 1680, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript((npub: string) => localStorage.setItem("wingman-identity-state", JSON.stringify({ npub, method: "session", authenticated: true, expiresAt: Date.now() + 600000, profileName: "Review owner" })), fixtureOwner);
      const page = await context.newPage(), errors: string[] = [];
      page.setDefaultTimeout(15000);
      await page.route("**/api/scheduler/identities", route => route.fulfill({ json: { identities: [] } }));
      page.on("pageerror", (error: Error) => errors.push(error.message));
      const view = () => page.evaluate(() => {
        const root = document.querySelector(".pipeline-viewer");
        const data = (window as any).Alpine.$data(root);
        return { edges: data.edges.length, selected: data.selectedStepKey, zoom: data.zoom, layoutError: data.layoutError };
      });
      await page.goto(`${fixture.server.url}pipelines/runs/${fixture.runs.full}`);
      await page.locator('.pipeline-viewer-edges g[data-kind="execution"]').first().waitFor({ state: "attached" });
      if (evidence) await page.screenshot({ path: `${evidence}/initial-${viewport.width}.png`, fullPage: true });
      await assertViewerLayout(page);
      expect(await page.locator('.pipeline-viewer-edges g[data-kind="data"]').count()).toBe(0);
      expect(await page.getByTestId("pipeline-step-child").innerText()).toContain("Child pipeline");
      expect(await page.locator('.pipeline-viewer-edges g[data-kind="skip"]').count()).toBe(1);
      await page.getByRole("button", { name: "Review step: Parse chat request", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByTestId("pipeline-step-details").waitFor();
      await page.route("**/api/pipelines/functions/prepare", route => route.fulfill({ json: { function: { name: "prepare", source: "export function prepare(input) { return input; }" } } }));
      await page.getByRole("button", { name: "Load current function source", exact: true }).click();
      await page.getByTestId("pipeline-step-details").getByText("Current library source; historical runs may have used an earlier revision.").waitFor();
      await page.getByTestId("pipeline-step-details").locator("pre").filter({ hasText: "export function prepare(input)" }).waitFor();
      expect(await page.getByTestId("pipeline-step-details").innerText()).toContain('"function": "prepare"');
      await page.keyboard.press("Escape");
      expect(await page.getByRole("button", { name: "Review step: Parse chat request", exact: true }).evaluate((element: Element) => element === document.activeElement)).toBe(true);
      const card = page.getByTestId("pipeline-step-prepare"), before = await card.evaluate((element: HTMLElement) => [element.style.left, element.style.top]);
      await page.getByTestId("pipeline-port-prepare-outputs-$.request").click();
      await page.locator('.pipeline-viewer-edges g[data-kind="data"]').first().waitFor({ state: "attached" });
      expect(await page.getByTestId("pipeline-selected-connections").innerText()).toContain("Retrieve records");
      await assertViewerLayout(page);
      const after = await card.evaluate((element: HTMLElement) => [element.style.left, element.style.top]);
      expect(after).toEqual(before);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Review step: Retrieve records", exact: true }).click();
      await page.getByRole("button", { name: /Open child workflow:/ }).click();
      await page.getByTestId("pipeline-step-loop").waitFor();
      await page.locator(".pipeline-review-loop-region").waitFor();
      expect(await page.getByTestId("pipeline-step-loop").innerText()).toContain("2 iterations");
      if (evidence) await page.screenshot({ path: `${evidence}/loop-${viewport.width}.png`, fullPage: true });
      await page.getByTestId("pipeline-drill-loop").click();
      await page.getByTestId("pipeline-step-loop/retrieve").waitFor();
      await page.locator('.pipeline-viewer-edges g[data-kind="repeat"]').waitFor({ state: "attached" });
      await assertViewerLayout(page);
      await page.getByTestId("pipeline-scope-back").click();
      await page.getByTestId("pipeline-parent").click();
      await page.getByTestId("pipeline-step-prepare").waitFor();
      if (evidence) await page.screenshot({ path: `${evidence}/branches-${viewport.width}.png`, fullPage: true });
      expect((await view()).layoutError).toBe("");
      const controlSpec = { name: "Target-loop review fixture", steps: [
        { id: "draft", name: "Draft", type: "agent", prompt: "Draft from the selected evidence", description: "Draft the response", assign: "$.draft", display: { out: [{ label: "Draft", path: "$.text" }] } },
        { name: "Critique", type: "classifier", prompt: "Evaluate the draft", description: "Evaluate response quality", assign: "$.critique", display: { out: [{ label: "Quality", path: "$.score" }] } },
        { name: "Repeat", type: "loop", target: "draft", iterations: 3, history: "$.history", capture: { draft: "$.draft" }, description: "Collect three review passes" },
        { name: "Child", type: "pipeline", pipeline: fixture.bird.name, description: "Inspect real retrieval workflow" }
      ] };
      const control = { id: "control-review", name: controlSpec.name, spec: controlSpec, scope: "shared" } as PipelineDefinitionRecord;
      await page.route("**/api/pipelines/definitions", route => route.fulfill({ json: { definitions: [{ ...control, ...controlSpec }, { ...fixture.bird, ...fixture.bird.spec }] } }));
      await page.route("**/api/pipelines/viewer/definitions/control-review", route => route.fulfill({ json: { version: 1, serviceId: "native", definition: viewerDefinition(control) } }));
      await page.route(`**/api/pipelines/definitions/${fixture.bird.name}`, route => route.fulfill({ json: { definition: fixture.bird } }));
      await page.goto(`${fixture.server.url}pipelines/definitions/control-review`);
      await page.locator('.pipeline-viewer-edges g[data-kind="repeat"]').first().waitFor({ state: "attached" });
      await assertViewerLayout(page);
      expect(await page.locator(".pipeline-review-loop-region").innerText()).toContain("collect $.history");
      await page.getByTestId("pipeline-select-draft").click();
      expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("Draft from the selected evidence");
      await page.keyboard.press("Escape");
      if (evidence) await page.getByTestId("pipeline-viewer").screenshot({ path: `${evidence}/target-loop-${viewport.width}.png` });
      await page.getByRole("button", { name: "Open defined child pipeline: " + fixture.bird.name, exact: true }).click();
      await page.waitForURL(`**/pipelines/definitions/${encodeURIComponent(fixture.bird.id)}`);
      await page.getByTestId("pipeline-step-bounded-retrieval").waitFor();
      if (process.env.PIPELINE_REVIEW_DEFINITION) {
        const spec = JSON.parse(readFileSync(process.env.PIPELINE_REVIEW_DEFINITION, "utf8"));
        const record = { id: "freedom-review", name: spec.name, spec, scope: "shared", ownerAlias: null, path: "fixture" } as PipelineDefinitionRecord;
        await page.route("**/api/pipelines/definitions", route => route.fulfill({ json: { definitions: [{ ...record, ...spec }] } }));
        await page.route("**/api/pipelines/definitions/freedom-review", route => route.fulfill({ json: { definition: record } }));
        await page.route("**/api/pipelines/viewer/definitions/freedom-review", route => route.fulfill({ json: { version: 1, serviceId: "native", definition: viewerDefinition(record) } }));
        await page.goto(`${fixture.server.url}pipelines/definitions/freedom-review`);
        await page.locator('.pipeline-viewer-edges g[data-kind="execution"]').first().waitFor({ state: "attached" });
        await page.getByTestId("pipeline-fit").click();
        await page.waitForTimeout(300);
        expect(await page.locator(".pipeline-viewer-step").count()).toBe(spec.steps.length);
        expect(await page.locator('.pipeline-viewer-edges g[data-kind="data"]').count()).toBe(0);
        expect(await page.locator('.pipeline-viewer-edges g[data-kind="skip"]').count()).toBe(1);
        expect(await page.locator('.pipeline-viewer-step[data-step-type="classifier"]').innerText()).toContain("Decision");
        await assertViewerLayout(page);
        if (evidence) { await page.screenshot({ path: `${evidence}/freedom-${viewport.width}.png`, fullPage: true }); await page.getByTestId("pipeline-viewer").screenshot({ path: `${evidence}/freedom-diagram-${viewport.width}.png` }); }
        await page.getByRole("button", { name: "Review step: Complete project conversation turn", exact: true }).click();
        expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("session.completedTurn");
        expect(await page.getByTestId("pipeline-step-details").innerText()).toContain("builderAllowed");
        if (evidence) await page.screenshot({ path: `${evidence}/freedom-selection-${viewport.width}.png`, fullPage: true });
      }
      expect(errors).toEqual([]);
      await context.close();
    }
  } finally { await browser.close(); await fixture.close(); }
}, 120000);
