/** Production-renderer regression check. Run with Node; Bun serves the isolated static assets.
 * Set PLAYWRIGHT_MODULE and optionally WEBKIT_EXECUTABLE to installed tools.
 * UI_EVIDENCE_DIR must be Git-ignored; UI_SERVED_URL checks live static assets.
 * UI_BASELINE_REF records pre-fix measurements without asserting the fix.
 * UI_LAYOUT_CASES optionally selects comma-separated case names.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baselineRef = process.env.UI_BASELINE_REF;
const evidenceDir = process.env.UI_EVIDENCE_DIR;
if (evidenceDir) {
  const ignored = spawnSync("git", ["check-ignore", "--quiet", `${evidenceDir}/production-measurements.json`], { cwd: root });
  assert.equal(ignored.status, 0, "Evidence directory must be Git-ignored");
}
const serverProcess = spawn("bun", [resolve(root, "scripts/ui/live-layout-server.ts")], {
  cwd: root, env: process.env, stdio: ["ignore", "pipe", "inherit"],
});
const server = await new Promise((resolve, reject) => {
  serverProcess.once("error", reject);
  serverProcess.once("exit", code => reject(new Error(`Test server exited: ${code}`)));
  let output = "";
  serverProcess.stdout.on("data", chunk => {
    output += chunk;
    if (output.includes("\n")) {
      try { resolve(JSON.parse(output.split("\n")[0])); } catch (error) { reject(error); }
    }
  });
});
const results = [];
try {
  for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
    const browser = await launcher.launch({ headless: true, ...(engine === "webkit" && process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
    try {
      for (const [name, width, height, mobile] of [
        ["small-phone", 320, 640, true],
        ["phone", 390, 744, true],
        ["large-phone", 430, 832, true],
        ["tablet", 768, 1024, true],
        ["desktop", 1440, 900, false],
        ["narrow-desktop", 390, 744, false]
      ]) {
        if (process.env.UI_LAYOUT_CASES && !process.env.UI_LAYOUT_CASES.split(",").includes(name)) continue;
        const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}live`);
        await page.waitForFunction(() => window.fixtureReady).catch(error => {
          throw new Error(`Production fixture failed to mount: ${errors.join("; ")}`, { cause: error });
        });
        await page.waitForSelector(".wm-message--queued");
        await page.waitForTimeout(350);
        async function measure(label) {
          const measurement = await page.evaluate(() => {
            const rect = (selector) => {
              const r = document.querySelector(selector).getBoundingClientRect();
              return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
            };
            const css = (selector) => getComputedStyle(document.querySelector(selector));
            const cards = [...document.querySelectorAll(".wm-message")].filter((el) => el.querySelector(".wm-message-actions"));
            return {
              viewport: visualViewport.height,
              offset: visualViewport.offsetTop,
              documentHeight: document.documentElement.scrollHeight,
              documentWidth: document.documentElement.scrollWidth,
              scrollY,
              composer: rect(".wm-composer-shell"),
              form: rect(".wm-composer"),
              input: rect("textarea"),
              header: rect(".wm-header"),
              live: rect(".wm-live"),
              app: rect("#app"),
              font: css("textarea").fontSize,
              messageFont: css(".wm-message").fontSize,
              appPadding: css("#app").paddingBottom,
              safePadding: css(".wm-composer-shell").paddingBottom,
              scroll: { height: document.querySelector(".wm-live-scroll").clientHeight, total: document.querySelector(".wm-live-scroll").scrollHeight, top: document.querySelector(".wm-live-scroll").scrollTop },
              primaryHeights: [...document.querySelectorAll(".wm-composer .wm-button, .wm-agent-status-pill")].map((el) => el.getBoundingClientRect().height),
              actionsFit: cards.every((el) => {
                const card = el.getBoundingClientRect();
                const actions = el.querySelector(".wm-message-actions").getBoundingClientRect();
                const body = el.querySelector(".wm-message-body").getBoundingClientRect();
                const separated = actions.top >= body.bottom || actions.left >= body.right;
                return separated && actions.top >= card.top + 11 && actions.bottom <= card.bottom - 11 && actions.right <= card.right - 11;
              })
            };
          });
          results.push({ engine, name, label, measurement });
          if (mobile && width <= 600 && !baselineRef) {
            assert.ok(Math.abs(measurement.composer.bottom - measurement.viewport - measurement.offset) < 1, `${engine} ${name} ${label}: composer bottom ${JSON.stringify(measurement)}`);
            assert.equal(measurement.scrollY, 0);
            assert.ok(measurement.documentWidth <= width, "document horizontal overflow");
            assert.equal(measurement.appPadding, "0px");
            assert.ok(measurement.actionsFit, `${engine} ${name} ${label}: message action overlap/inset`);
            assert.ok(measurement.primaryHeights.every((h) => h >= 44));
            assert.ok(parseFloat(measurement.font) >= 16);
            assert.equal(measurement.messageFont, "15px");
          }
          return measurement;
        }
        const initial = await measure("normal");
        assert.deepEqual(errors, []);
        if (evidenceDir && name === "phone")
          await page.screenshot({ path: `${evidenceDir}/${engine}-production${baselineRef ? "-before" : ""}.png` });
        if (baselineRef) {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await page.waitForTimeout(350);
          await measure("document-end");
          if (evidenceDir && name === "phone") await page.screenshot({ path: `${evidenceDir}/${engine}-production-end-before.png` });
          await page.evaluate(() => window.layoutFixture.short());
          await page.waitForFunction(() => document.querySelectorAll(".wm-message").length === 1);
          await page.waitForTimeout(350);
          await measure("short-conversation");
          if (evidenceDir && name === "phone") await page.screenshot({ path: `${evidenceDir}/${engine}-production-short-before.png` });
        }
        if (mobile && width <= 600 && !baselineRef) {
          await page.locator(".wm-message-working-notes").evaluateAll((els) => els.forEach((el) => el.setAttribute("open", "")));
          await measure("working-open");
          await page.locator(".wm-message-working-notes").evaluateAll((els) => els.forEach((el) => el.removeAttribute("open")));
          await measure("working-closed");
          await page.evaluate(() => window.layoutFixture.fill());
          await page.waitForFunction(() => document.querySelectorAll(".wm-message").length >= 25);
          for (const split of [false, true]) {
            await page.evaluate((split) => window.layoutFixture.mount(split), split);
            await page.waitForTimeout(350);
            assert.equal(await page.locator(".wm-live-chat-col").count(), split ? 1 : 0);
            for (const collapsed of [false, true]) {
              await page.evaluate((collapsed) => {
                document.body.dataset.liveHeaderCollapsed = String(collapsed);
              }, collapsed);
              for (const h of [height, 400]) {
                await page.setViewportSize({ width, height: h });
                await page.waitForTimeout(350);
                await page.evaluate(() => {
                  document.querySelector(".wm-live-scroll").scrollTop = 0;
                  window.scrollTo(0, 100);
                });
                const m = await measure(`${split ? "split" : "normal"}-${collapsed ? "hidden" : "shown"}-${h}`);
                assert.ok(m.documentHeight <= h, "document must not scroll");
                assert.ok(m.scroll.total > m.scroll.height, "conversation must scroll independently");
                await page.locator(".wm-scroll-pill--scroll-bottom").click();
                await page.waitForFunction(() => {
                  const el = document.querySelector(".wm-live-scroll");
                  return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
                });
                const end = await measure("scrolled-to-end");
                assert.ok(end.scroll.top > 0);
                if (!collapsed && h === height) {
                  const previousTop = await page.locator(".wm-live-scroll").evaluate(el => el.scrollTop);
                  await page.getByRole("button", { name: "Message menu", exact: true }).click();
                  await page.locator(".wm-command-item").filter({ hasText: /^Last prompt$/ }).click();
                  await page.waitForFunction(previousTop => document.querySelector(".wm-live-scroll").scrollTop < previousTop - 2, previousTop);
                  assert.equal(await page.evaluate(() => window.scrollY), 0, "Last prompt must scroll the conversation, not the document");
                }
              }
            }
          }
          await page.setViewportSize({ width, height });
          await page.evaluate(() => {
            document.body.dataset.liveHeaderCollapsed = "false";
          });
          await page.evaluate(() => window.layoutFixture.mount(false));
          // Simulate keyboard/pan API values independently of the layout viewport.
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, "height", { configurable: true, value: 350 });
            Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 20 });
            visualViewport.dispatchEvent(new Event("resize"));
          });
          await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--wm-viewport-height") === "350px");
          await measure("visual-keyboard-offset");
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 30 });
            visualViewport.dispatchEvent(new Event("scroll"));
          });
          await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--wm-viewport-offset-top") === "30px");
          await measure("visual-offset-only");
          assert.equal(await page.locator("body").getAttribute("data-keyboard-open"), "true");
          const beforeZoom = await page.locator(".wm-composer-shell").boundingBox();
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, "scale", { configurable: true, value: 2 });
            Object.defineProperty(visualViewport, "height", { configurable: true, value: 175 });
            visualViewport.dispatchEvent(new Event("resize"));
          });
          await page.waitForTimeout(350);
          assert.deepEqual(await page.locator(".wm-composer-shell").boundingBox(), beforeZoom, "pinch zoom must not reflow layout");
          await page.evaluate(() => {
            for (const key of ["scale", "height", "offsetTop"])
              delete visualViewport[key];
            visualViewport.dispatchEvent(new Event("resize"));
          });
          await page.waitForTimeout(350);
          // Desktop engines expose zero safe-area insets; substitute in the real CSS.
          await page.evaluate(async () => {
            for (const link of [...document.querySelectorAll('link[rel="stylesheet"]')]) {
              const css = await (await fetch(link.href)).text();
              const style = document.createElement("style");
              style.textContent = css.replace(/env\(safe-area-inset-bottom(?:,[^)]*)?\)/g, "34px");
              link.replaceWith(style);
            }
          });
          const safe = await measure("safe-area-34");
          assert.equal(safe.safePadding, "42px");
          assert.ok(Math.abs(safe.composer.bottom - safe.form.bottom - 42) < 1);
          await page.locator(".wm-composer textarea").focus();
          assert.equal(await page.evaluate(() => visualViewport.scale), 1);
          await page.evaluate(() => window.layoutFixture.short());
          await page.waitForFunction(() => document.querySelectorAll(".wm-message").length === 1);
          await measure("short-conversation-safe-area-34");
        } else if (!baselineRef) {
          await page.locator('link[href="/live/phone-layout.css"]').evaluate((el) => el.remove());
          const withoutPhone = await measure("without-phone-styles");
          assert.deepEqual(withoutPhone, initial);
        }
        assert.deepEqual(errors, []);
        console.log(`${engine} ${name}: passed`);
        if (evidenceDir) await writeFile(`${evidenceDir}/production-measurements.json`, JSON.stringify(results, null, 2));
        await context.close();
      }
    } finally {
      console.log(`${engine}: closing browser`);
      await browser.close();
      console.log(`${engine}: browser closed`);
    }
  }
} finally {
  console.log("Stopping layout test server");
  serverProcess.kill("SIGTERM");
}
if (process.env.UI_EVIDENCE_DIR)
  await writeFile(`${process.env.UI_EVIDENCE_DIR}/production-measurements.json`, JSON.stringify(results, null, 2));
console.log(`Passed ${results.length} production-layout measurements across Chromium and WebKit.`);
