// Node Playwright full-app review. Bun only serves isolated production assets.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const evidence = resolve(process.env.UI_EVIDENCE_DIR || "tmp/docs/handoffs/phone-all-screens");
assert.equal(spawnSync("git", ["check-ignore", "--quiet", `${evidence}/metrics.json`]).status, 0);
await mkdir(evidence, { recursive: true });
const server = spawn("bun", ["scripts/ui/phone-screens-server.ts"], { stdio: ["ignore", "pipe", "inherit"] });
const { url } = await new Promise((res, rej) => {
  server.once("error", rej);
  server.stdout.once("data", data => res(JSON.parse(String(data))));
});
const results = [];
const baseline = Boolean(process.env.UI_BASELINE);
try {
  for (const engine of (process.env.UI_ENGINES || "chromium,webkit").split(",")) {
    const browser = await ({ chromium, webkit })[engine].launch({ headless: true, ...(engine === "webkit" && process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
    try {
      for (const width of (process.env.UI_WIDTHS || "320,390,430,768,1440").split(",").map(Number)) {
        const context = await browser.newContext({ viewport: { width, height: width === 768 ? 1024 : 844 }, isMobile: width < 1000, hasTouch: width < 1000, serviceWorkers: "block" });
        await context.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
        // No real transport or external relay connections in this isolated fixture.
        await context.addInitScript(() => {
          window.EventSource = class extends EventTarget { close() {} };
          window.WebSocket = class extends EventTarget { static OPEN = 1; close() {} send() {} };
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => { errors.push(error.message); console.log("PAGE ERROR", error.message); });
        page.on("console", message => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) console.log("CONSOLE", message.text()); });
        page.on("response", response => { if(response.status() >= 400) console.log("HTTP", response.status(), new URL(response.url()).pathname); });
        await page.goto(`${url}home`);
        await page.waitForFunction(() => window.fixtureReady, null, { timeout: 15000 });
        await page.waitForTimeout(1500);
        async function navigate(route) {
          await page.evaluate(route => { history.pushState({}, "", `/${route}`); dispatchEvent(new PopStateEvent("popstate")); }, route);
          await page.waitForTimeout(500);
        }
        async function capture(name) {
          await page.waitForTimeout(500);
          await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
          const metrics = await page.evaluate(viewportWidth => {
            const visible = el => el.checkVisibility() && el.getBoundingClientRect().width && el.getBoundingClientRect().height;
            const controls = [...document.querySelectorAll("#app button, #app input, #app select, #app textarea, #app summary")].filter(visible);
            return {
              coarse: matchMedia("(pointer: coarse)").matches, phone: matchMedia("(max-width: 600px)").matches, width: innerWidth, documentWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
              bodyPosition: getComputedStyle(document.body).position,
              headings: [...document.querySelectorAll("#app h1,#app h2")].map(el => ({ text: el.textContent, font: getComputedStyle(el).fontSize })),
              controls: controls.map(el => ({ name: el.getAttribute("aria-label") || el.textContent.slice(0, 60) || el.placeholder || el.type, tag: el.tagName, type: el.type, className: el.className, font: getComputedStyle(el).fontSize, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
              overflow: [...document.querySelectorAll("#app *")].filter(visible).filter(el => el.getBoundingClientRect().right > viewportWidth + 1).slice(0, 15).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })),
              appPaddingBottom: getComputedStyle(document.querySelector("#app")).paddingBottom,
              route: document.querySelector("#app").dataset.route,
              cards: [...document.querySelectorAll(".session-card")].map(el => ({ height: el.getBoundingClientRect().height, titleWidth: el.querySelector("h3")?.getBoundingClientRect().width })),
              text: document.querySelector("#app").innerText,
            };
          }, width);
          results.push({ engine, width, name, metrics, errors: [...errors] });
          if (width === 390 || width === 320) {
            await page.screenshot({ path: `${evidence}/${engine}-${width}-${name}.png` });
            if (metrics.height > 844) {
              await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
              if (!baseline && metrics.route !== "live") assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight || scrollY > 0), `${name} must scroll naturally`);
              await page.screenshot({ path: `${evidence}/${engine}-${width}-${name}-end.png` });
              await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
            }
          }
          await writeFile(`${evidence}/metrics.json`, JSON.stringify(results, null, 2));
          if (!baseline && width <= 600 && metrics.route !== "live") {
            assert.ok(metrics.coarse && metrics.phone, "Phone emulation must stay active after screenshots");
            for (const c of metrics.controls.filter(c => !["chat", "privacy"].includes(metrics.route) && /(^| )(wm-button|wm-btn|wm-home-tabs__tab)( |$)/.test(c.className))) {
              assert.ok(c.height >= 44, `${name}: ${c.name} touch height ${c.height}`);
            }
            assert.ok(metrics.documentWidth <= width, `${name}: document overflows ${metrics.documentWidth} > ${width}`);
            assert.notEqual(metrics.bodyPosition, "fixed", `${name}: live viewport must be released`);
            for (const c of metrics.controls.filter(c => ["INPUT", "SELECT", "TEXTAREA"].includes(c.tag) && !["checkbox", "radio", "color", "hidden"].includes(c.type))) {
              if (!["chat", "privacy"].includes(metrics.route)) {
                assert.ok(parseFloat(c.font) >= 16, `${name}: ${c.name} input font ${c.font}`);
                assert.ok(c.height >= 44, `${name}: ${c.name} input height ${c.height}`);
              }
            }
          }
          console.log(`${engine} ${width} ${name}: ${metrics.documentWidth}px, ${metrics.controls.length} controls; errors ${errors.length}`);
        }
        if (!process.env.UI_ONLY) {
          await capture("home");
          assert.ok(await page.locator(".session-card, .session-table tbody tr").count() >= 4, "Home must contain sessions");
          await page.getByRole("tab", { name: /Auto Sessions/ }).click();
          await capture("home-auto");
          await page.getByRole("tab", { name: /My Sessions/ }).click();
          await page.getByLabel("Identities").selectOption("all");
          await page.getByRole("button", { name: /^View session Review responsive/ }).click();
          await page.waitForSelector(".wm-composer");
          await navigate("home");
          await capture("home-from-live");
          for (const tab of ["apps", "archive", "pipelines"]) {
            await page.getByTestId(`home-tab-${tab}`).click();
            await capture(`home-${tab}`);
          }
          await navigate("live/review-session-0");
          await page.waitForSelector(".wm-composer");
          await navigate("settings/profile");
          await page.waitForSelector(".wm-settings-shell");
          const options = await page.locator(".wm-settings-mobile-nav option").evaluateAll(els => els.map(el => el.value));
          assert.equal(options.length, 16, "All admin Settings destinations must be available");
          async function selectSettings(id) {
            if (await page.getByTestId("settings-mobile-navigation").isVisible()) await page.getByTestId("settings-mobile-navigation").selectOption(id);
            else await page.getByTestId(`settings-nav-${id}`).click();
          }
          for (const id of options) {
            await selectSettings(id);
            // Starter loading does not rerender itself; real navigation back shows the loaded panel.
            if (id === "starter") {
              await page.waitForTimeout(500);
              await selectSettings("profile");
              await selectSettings("starter");
            }
            await capture(`settings-${id}`);
            const summaries = page.locator(".wm-settings-page details > summary:visible");
            const handles = await summaries.elementHandles();
            const count = handles.length;
            for (const summary of handles) {
              if (await summary.isVisible()) await summary.click();
            }
            if (count) await capture(`settings-${id}-expanded`);
          }
        }
        for (const route of ["apps", "projects", "files", "scheduler", "pipelines", "nightwatch", "terminal", "chat", "privacy", ...(process.env.UI_ONLY?.split(",").filter(route => route.startsWith("settings/")) || [])]) {
          if (process.env.UI_ONLY && !process.env.UI_ONLY.split(",").includes(route)) continue;
          await navigate(route);
          await capture(route.replaceAll("/", "-"));
          assert.equal(await page.locator("#app").getAttribute("data-route"), route.split("/")[0]);
          if (route === "nightwatch") {
            await page.getByRole("button", { name: "Refresh", exact: true }).click();
            await page.waitForFunction(() => document.querySelector(".wm-nightwatch-page")?.innerText.includes("Reviewed the application."));
            await capture("nightwatch-reports");
          }
          if (route === "scheduler") {
            await page.getByRole("button", { name: "Edit", exact: true }).click();
            await capture("scheduler-edit");
          }
          if (route === "pipelines") {
            await page.getByRole("button", { name: "Definitions", exact: true }).click();
            await capture("pipeline-definitions");
          }
          if (route === "files") {
            await page.getByRole("button", { name: /long-review-notes-for-phone-layout.md/ }).first().click();
            await capture("files-preview");
          }
        }
        await writeFile(`${evidence}/requests.json`, JSON.stringify(await (await fetch(`${url}review-requests`)).json(), null, 2));
        if (!baseline && width <= 600 && (!process.env.UI_ONLY || process.env.UI_ONLY.split(",").includes("a11y"))) {
          for (const destination of ["home", "settings/profile"]) {
            await navigate(destination);
            if (destination === "home") await page.getByTestId("home-tab-sessions").click();
            await page.evaluate(() => document.documentElement.style.fontSize = "20px");
            await capture(`${destination.replace("/", "-")}-large-text`);
            await page.evaluate(() => document.documentElement.style.fontSize = "");
          }
          await page.evaluate(async () => {
            const link = document.querySelector('link[href="/phone-layout.css"]');
            const style = document.createElement("style");
            style.textContent = (await (await fetch(link.href)).text()).replace(/env\(safe-area-inset-bottom(?:,[^)]*)?\)/g, "34px");
            link.replaceWith(style);
          });
          await capture("settings-safe-area-34");
          assert.equal(await page.locator("#app").evaluate(el => getComputedStyle(el).paddingBottom), "50px");
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  }
} finally { server.kill("SIGTERM"); }
