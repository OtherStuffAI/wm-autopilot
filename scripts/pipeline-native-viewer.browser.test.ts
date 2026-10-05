import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import {
  createNativeViewerFixture,
  fixtureOwner,
  exactPrompt,
} from "./pipeline-native-viewer-fixture";
import { assertViewerLayout, assertScopeInputSelection, assertExpandedEvidenceLayout } from "./pipeline-native-viewer-layout-check";
import { captureViewer, captureTimeline } from "./pipeline-native-viewer-captures";

const browserTest = process.env.PLAYWRIGHT_MODULE ? test : test.skip;
browserTest(
  "production Autopilot shell: retained values, children, bounded records and stale/refused responses",
  async () => {
    const fixture = await createNativeViewerFixture();
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE,
    });
    const evidenceDir = process.env.NATIVE_VIEWER_EVIDENCE_DIR;
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
    try {
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        fixture.recover();
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.width < 850,
          isMobile: viewport.width < 850,
          permissions: ["clipboard-read", "clipboard-write"],
        });
        await context.addInitScript((npub: string) => {
          localStorage.setItem(
            "wingman-identity-state",
            JSON.stringify({
              npub,
              method: "session",
              authenticated: true,
              expiresAt: Date.now() + 600000,
              profileName: "Synthetic owner",
            }),
          );
        }, fixtureOwner);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => {
          errors.push(error.message);
          console.error("Browser error", error.message);
        });
        page.on("console", (message: any) => {
          if (message.type() === "error")
            console.error("Browser console", message.text());
        });
        await page.goto(
          `${fixture.server.url}pipelines/runs/${fixture.runs.full}`,
        );
        try {
          await page
            .getByTestId("pipeline-status")
            .filter({ hasText: "ready" })
            .waitFor({ timeout: 20000, state: "attached" });
        } catch (error) {
          console.error(
            "Shell diagnostic",
            page.url(),
            await page.locator("body").innerText(),
            fixture.requests,
          );
          if (evidenceDir)
            await page.screenshot({ path: `${evidenceDir}/failed-shell.png` });
          throw error;
        }
        expect(await page.getByTestId("pipeline-step-prepare").count()).toBe(1);
        expect(await page.getByTestId("pipeline-step-child").count()).toBe(1);
        await page.locator(".pipeline-viewer-edges g").first().waitFor();
        expect(await page.locator(".pipeline-viewer-edges g").count()).toBeGreaterThan(0);
        await assertExpandedEvidenceLayout(page);
        if (evidenceDir)
          await page.screenshot({
            path: `${evidenceDir}/shell-${viewport.width}.png`,
            fullPage: true,
          });
        if (evidenceDir) for (const theme of ["light","dark"]) {
          await page.evaluate((theme: string) => document.body.setAttribute("data-theme",theme), theme);
          await captureViewer(page, `${evidenceDir}/run-${viewport.width}-${theme}.png`);
        }
        const promptPort = page.getByTestId(
          "pipeline-port-prepare-inputs-$.prompt",
        );
        await promptPort.focus();
        expect(
          await page
            .getByTestId("pipeline-inspector")
            .getAttribute("data-pinned"),
        ).toBe("false");
        if (viewport.width < 850) await promptPort.tap();
        else await promptPort.click();
        await page
          .getByTestId("pipeline-value-completeness")
          .filter({ hasText: "Complete retained value" })
          .waitFor();
        expect(await page.getByTestId("pipeline-inspector").getAttribute("role")).toBe("dialog");
        const canvasWidth = await page.locator(".pipeline-viewer-diagram").evaluate((el: Element) => el.getBoundingClientRect().width);
        expect(await page.getByTestId("pipeline-inspector").evaluate((el: Element) => el.contains(document.activeElement))).toBe(true);
        await page.getByTestId("pipeline-inspector").focus();
        await page.keyboard.press("Tab");
        expect(await page.getByLabel("Close value inspector", {exact:true}).evaluate((el: Element) => el === document.activeElement)).toBe(true);
        expect(canvasWidth).toBeGreaterThan(viewport.width < 850 ? 200 : 900);
        expect(
          await page.getByTestId("pipeline-exact-value").textContent(),
        ).toBe(exactPrompt);
        if (evidenceDir) await page.screenshot({path:`${evidenceDir}/run-${viewport.width}-exact-value.png`});
        await page.getByTestId("pipeline-copy-value").click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          exactPrompt,
        );
        expect(
          await page.evaluate(() => (window as any).UNSAFE),
        ).toBeUndefined();
        await page.keyboard.press("Escape");
        expect(
          await promptPort.evaluate(
            (element: Element) => element === document.activeElement,
          ),
        ).toBe(true);
        await page
          .getByTestId("pipeline-port-child-outputs-$.result.records")
          .click();
        await page
          .getByTestId("pipeline-record-count")
          .filter({ hasText: "5000" })
          .waitFor();
        expect(await page.locator(".pipeline-viewer-records li").count()).toBe(
          50,
        );
        await page
          .getByLabel("Record page number", { exact: true })
          .fill("100");
        await page
          .getByLabel("Record page number", { exact: true })
          .press("Enter");
        expect(
          await page.getByTestId("pipeline-record-count").textContent(),
        ).toContain("4951–5000");
        await page.getByTestId("pipeline-value-search").fill("Record 4999 ");
        expect(await page.locator(".pipeline-viewer-records li").count()).toBe(
          1,
        );
        expect(
          await page.locator(".pipeline-viewer-records li pre").textContent(),
        ).toContain("4999");
        await page.keyboard.press("Escape");
        const delivery = page.getByTestId(
          "pipeline-port-deliver-outputs-$.delivery.reply",
        );
        await delivery.click();
        await page
          .getByTestId("pipeline-value-completeness")
          .filter({ hasText: "Complete retained value" })
          .waitFor();
        await page.getByTestId("pipeline-copy-value").click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          "Deterministic full reply\n  exact spacing  ",
        );
        await page.keyboard.press("Escape");
        await page
          .getByTestId("pipeline-port-deliver-outputs-$.explicitNull")
          .click();
        await page
          .getByTestId("pipeline-field-null")
          .waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await page
          .getByTestId("pipeline-port-deliver-outputs-$.missing")
          .click();
        await page
          .getByTestId("pipeline-field-missing")
          .waitFor({ state: "visible" });
        expect(await page.getByTestId("pipeline-copy-value").isDisabled()).toBe(
          true,
        );
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", {
            name: "Open child workflow: Retrieve records attempt 1",
            exact: true,
          })
          .click();
        await page.getByTestId("pipeline-step-loop").waitFor();
        expect(await page.getByTestId("pipeline-step-loop/retrieve").count()).toBe(0);
        await page.getByTestId("pipeline-drill-loop").click();
        await page.getByTestId("pipeline-step-loop/retrieve").waitFor();
        expect(
          await page.locator('[data-testid^="pipeline-attempt-"]').count(),
        ).toBe(2);
        if (evidenceDir) await captureViewer(page, `${evidenceDir}/run-${viewport.width}-child-loop.png`);
        await page.getByTestId("pipeline-parent").click();
        await promptPort.waitFor();
        const stored = await page.evaluate(async () => {
          const { default: Dexie } = await import("/vendor/dexie/dexie.mjs");
          const db = new Dexie("WingmanNativePipelineViewer");
          await db.open();
          const text = JSON.stringify(await db.table("projections").toArray());
          db.close();
          return text;
        });
        expect(stored).not.toContain("Exact user text");
        expect(stored).not.toContain("Record 4999");
        expect(stored).not.toContain("definition");
        expect(stored).not.toContain("Synthetic");
        fixture.delay();
        await promptPort.click();
        await page
          .getByText("Loading retained value…", { exact: true })
          .waitFor();
        await page.keyboard.press("Escape");
        fixture.release();
        await page.waitForTimeout(150);
        expect(
          await page
            .getByTestId("pipeline-inspector")
            .getAttribute("data-pinned"),
        ).toBe("false");
        fixture.refuse();
        await page.getByTestId("pipeline-retry").click();
        await page
          .getByTestId("pipeline-status")
          .filter({ hasText: "redaction review" })
          .waitFor();
        expect(await page.getByTestId("pipeline-exact-value").count()).toBe(0);
        fixture.recover();
        await page.getByTestId("pipeline-retry").click();
        await promptPort.waitFor();
        fixture.deny();
        await page.getByTestId("pipeline-retry").click();
        await page
          .getByTestId("pipeline-status")
          .filter({ hasText: "denied" })
          .waitFor();
        expect(await page.getByTestId("pipeline-exact-value").count()).toBe(0);
        fixture.recover();
        for (const outcome of [
          "partial",
          "clarification",
          "failed",
          "no-results",
          "legacy",
        ]) {
          await page.goto(
            `${fixture.server.url}pipelines/runs/${fixture.runs[outcome]}`,
          );
          await page
            .getByTestId("pipeline-status")
            .filter({ hasText: "ready" })
            .waitFor({state: "attached"});
          if (outcome === "clarification")
            expect(
              await page.getByTestId("pipeline-step-clarify").innerText(),
            ).toContain("Attempt 1 · ok");
          if (outcome === "partial" || outcome === "no-results") {
            await page
              .getByTestId("pipeline-port-child-outputs-$.result.records")
              .click();
            await page
              .getByTestId("pipeline-value-completeness")
              .filter({ hasText: "Complete retained value" })
              .waitFor();
            expect(
              await page.locator(".pipeline-viewer-records li").count(),
            ).toBe(outcome === "partial" ? 3 : 0);
            await page.keyboard.press("Escape");
          }
          if (outcome === "failed")
            expect(
              await page.getByTestId("pipeline-run-status").textContent(),
            ).toContain("error");
          if (outcome === "legacy")
            await page
              .getByText(
                "The immutable definition snapshot is unavailable for this historical run.",
              )
              .waitFor({ state: "visible" });
        }
        const liveId = fixture.live.start();
        await page.goto(`${fixture.server.url}pipelines/runs/${liveId}`);
        await page
          .getByTestId("pipeline-run-status")
          .filter({ hasText: "running" })
          .waitFor({ timeout: 10000 });
        expect(
          await page.getByTestId("pipeline-step-wait").innerText(),
        ).toContain("running");
        await fixture.live.complete(liveId);
        await page
          .getByTestId("pipeline-run-status")
          .filter({ hasText: "ok" })
          .waitFor({ timeout: 10000 });
        await page.getByTestId("pipeline-port-wait-outputs-$.answer").click();
        await page
          .getByTestId("pipeline-value-completeness")
          .filter({ hasText: "Complete retained value" })
          .waitFor();
        expect(
          await page.getByTestId("pipeline-exact-value").textContent(),
        ).toBe("Exact live completion");
        await page.keyboard.press("Escape");
        await page.goto(
          `${fixture.server.url}pipelines/definitions/${encodeURIComponent(fixture.parent.id)}`,
        );
        await page
          .getByTestId("pipeline-status")
          .filter({ hasText: "ready" })
          .waitFor({state: "attached"});
        expect(await page.getByTestId("pipeline-step-prepare").count()).toBe(1);
        expect(await page.getByTestId("pipeline-run-status").isVisible()).toBe(
          false,
        );
        await page.goto(`${fixture.server.url}pipelines/definitions/${encodeURIComponent(fixture.bird.id)}`);
        await page.getByTestId("pipeline-step-bounded-retrieval").waitFor();
        expect(await page.locator('.pipeline-viewer-step[data-input-node="false"]').count()).toBe(2);
        expect(await page.getByTestId("pipeline-step-bounded-retrieval/choose").count()).toBe(0);
        for (const theme of ["light", "dark"]) {
          await page.evaluate((theme: string) => {
            document.documentElement.setAttribute("data-theme", theme);
            document.body.setAttribute("data-theme", theme);
          }, theme);
          if (evidenceDir) await captureViewer(page, `${evidenceDir}/bird-${viewport.width}-${theme}-overview.png`);
          await page.getByTestId("pipeline-drill-bounded-retrieval").click();
          expect(await page.locator('.pipeline-viewer-step[data-input-node="false"]').count()).toBe(4);
          if (evidenceDir) await captureViewer(page, `${evidenceDir}/bird-${viewport.width}-${theme}-loop.png`);
          await page.getByTestId("pipeline-scope-back").click();
        }
        await assertViewerLayout(page);
        await assertScopeInputSelection(page);
        const configuredRequest = page.getByTestId("pipeline-port-prepare-inputs-$.request");
        await configuredRequest.click();
        expect(await page.getByTestId("pipeline-inspector").innerText()).toContain("No execution value exists");
        if (evidenceDir) await page.screenshot({path:`${evidenceDir}/bird-${viewport.width}-drawer.png`});
        expect(await page.locator(".pipeline-viewer-edges g").count()).toBeGreaterThan(0);
        await page.keyboard.press("Escape");
        await captureTimeline(page, fixture, viewport.width, evidenceDir);
        const partitionCount = await page.evaluate(async () => {
          const { default: Dexie } = await import("/vendor/dexie/dexie.mjs");
          const db = new Dexie("WingmanNativePipelineViewer");
          await db.open();
          const count = await db.table("projections").count();
          db.close();
          window._viewerExit = window.Alpine.$data(
            document.querySelector(".pipeline-viewer"),
          );
          return count;
        });
        // Leaving pipelines uses the production shell's route renderer.
        await page.evaluate(() => {
          window.history.pushState({}, "", "/privacy");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await page
          .getByTestId("pipeline-viewer")
          .waitFor({ state: "detached" });
        const beforeExit = fixture.requests.filter((path) =>
          path.startsWith("/api/pipelines/viewer/"),
        ).length;
        await page.waitForTimeout(2800);
        expect(
          fixture.requests.filter((path) =>
            path.startsWith("/api/pipelines/viewer/"),
          ).length,
        ).toBe(beforeExit);
        const abandoned = await page.evaluate(async () => {
          const { default: Dexie } = await import("/vendor/dexie/dexie.mjs");
          const db = new Dexie("WingmanNativePipelineViewer");
          await db.open();
          const count = await db.table("projections").count();
          db.close();
          return count;
        });
        expect(abandoned).toBe(partitionCount - 1);
        expect(
          await page.evaluate(() => ({
            snapshot: window._viewerExit.snapshot,
            inspector: window._viewerExit.inspector,
            preview: window._viewerExit.preview,
          })),
        ).toEqual({ snapshot: null, inspector: null, preview: "" });
        expect(errors).toEqual([]);
        await context.close();
      }
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
  120000,
);
