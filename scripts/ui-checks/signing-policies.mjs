// Isolated browser regression: no requests or writes to a running Autopilot.
// Run with Bun, PLAYWRIGHT_MODULE set to an installed Playwright entry point.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createProjectStaticAssetService } from "../../src/server/static-assets.ts";
import { validateSigningPolicyDraft } from "../../src/signing/signing-policy-validation.ts";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.SIGNING_UI_OUTPUT || "/tmp/signing-policies-ui";
await mkdir(output, { recursive: true });
const assets = createProjectStaticAssetService(process.cwd());
const baseline = {
  id: "default-agent", name: "Default Agent Capability", description: "Built-in baseline applied to every session capability.",
  enabled: true, builtIn: "baseline", editable: false, revision: 1,
  operations: ["identity.read", "capability.refresh", "nip98.sign", "nostr.sign", "nip44.encrypt", "nip44.decrypt", "blossom.authorize"],
  eventKinds: [0, 1, 7, 10002, 24242], assignments: { allSessions: true },
  nip98Targets: [{ origin: "https://tower.example", exactPaths: [{ path: "/api/v4/messages", methods: ["GET"] }], pathPrefixes: ["/api/v4"], requireBodyHashMethods: ["POST"] }],
};
const synthetic = {
  id: "synthetic-repository", name: "Synthetic repository announcement", description: "Sign the reviewed announcement for the synthetic repository.",
  enabled: false, revision: 1, operations: ["nostr.sign"], eventKinds: [30617], nip98Targets: [],
  assignments: { profileIds: ["profile-synthetic-1234567890abcdef"], workspaceIds: ["workspace-synthetic-1234567890abcdef"] },
  nostrKindRules: [{ kind: 30617, maxContentBytes: 0, maxTags: 16, maxTagBytes: 4096, allowedTagNames: ["d", "relays"], exactTags: [["d", "synthetic"], ["relays", "wss://one.example/", "wss://two.example/"]] }],
};
let policies = [baseline, synthetic];
const sessions = [{ sessionId: "session-synthetic-1234567890abcdef", profileId: synthetic.assignments.profileIds[0], workspaceId: synthetic.assignments.workspaceIds[0], policyState: "stale" }];
const writes = [];
let failCreate = false;
let failReissue = false;
let affected = [];
let delayedFailure;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signing policy isolated review</title><link rel="stylesheet" href="/styles.css"><style>body {padding:24px;} main {max-width:1200px;margin:auto;} h1 {margin-bottom:8px;} .fixture-note {font-size:13px;margin-bottom:20px;} @media(max-width:720px){body{padding:12px;}}</style></head><body><main><h1>Signing Policies</h1><p class="fixture-note">Isolated review · synthetic policies and mocked admin API</p><div id="settings"></div></main><script type="module">import Alpine from '/vendor/alpinejs/module.esm.js'; import {createSigningPoliciesSection} from '/views/settings/signing-policies-section.js'; Alpine.start(); document.querySelector('#settings').append(createSigningPoliciesSection());</script></body></html>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
  if (path.startsWith("/api/")) {
    assert(path.startsWith("/api/admin/signing-policies"));
    if (request.method !== "GET") {
      const body = await request.json();
      writes.push({ path, body, method: request.method });
      if (path.endsWith("/reissue")) return Response.json(failReissue ? { error: "Synthetic reissue failed" } : { success: true }, { status: failReissue ? 409 : 200 });
      if (path.endsWith("/enabled")) {
        const policy = policies.find((p) => path.endsWith(`/${p.id}/enabled`));
        policy.enabled = body.enabled;
        policy.revision++;
        return Response.json({ policy });
      }
      if (request.method === "POST") {
        if (failCreate) return Response.json({ error: "Synthetic create rejected" }, { status: 400 });
        const policy = { ...validateSigningPolicyDraft(body), revision: 1 };
        policies.push(policy);
        return Response.json({ policy }, { status: 201 });
      }
      const policy = { ...validateSigningPolicyDraft(body), revision: 2 };
      policies = policies.map((p) => p.id === policy.id ? policy : p);
      return Response.json({ policy });
    }
    if (path === "/api/admin/signing-policies") return Response.json({ policies, sessions });
    if (path.endsWith("/default-agent") && delayedFailure) {
      const wait = delayedFailure;
      delayedFailure = null;
      await wait;
      return Response.json({ error: "Stale request failed" }, { status: 500 });
    }
    const policy = policies.find((p) => path.endsWith(`/${p.id}`));
    assert(policy);
    return Response.json({ policy, history: [], sessions: policy.id === baseline.id ? sessions : affected });
  }
  return assets.resolveUiAsset(path) || await assets.serveVendorModule(path) || new Response("Not found", { status: 404 });
} });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const get = (id) => page.getByTestId(id);
  const ready = () => page.waitForFunction(() => document.querySelector('[data-testid="signing-policies-status"]')?.dataset.state === "ready");
  await page.goto(server.url.href);
  await ready();
  assert(await get("signing-policy-add").isVisible());
  assert(!(await get("signing-policy-import").isVisible()));
  assert.equal(await get("signing-policy-enable-toggle").count(), 0);
  assert.equal(await get("signing-policy-json").count(), 0);
  assert.equal(await get("signing-policy-editor").getAttribute("open"), null);
  assert((await get("signing-policy-overview").innerText()).includes("HTTP destinations: https://tower.example"));
  const navHeight = await get("signing-policy-select").first().evaluate((el) => el.getBoundingClientRect().height);
  assert(navHeight < 120, `Inventory button height ${navHeight}`);
  await page.screenshot({ path: `${output}/desktop-baseline.png`, fullPage: true });
  await get("signing-policy-select").nth(1).click();
  await ready();
  assert.equal(await get("signing-policy-status").innerText(), "Disabled");
  assert(await get("signing-policy-enable-toggle").isVisible());
  assert((await get("signing-policy-sessions").innerText()).includes("Affected sessions (0)"));
  assert.equal(await get("signing-policy-reissue").count(), 0);
  assert((await get("signing-policy-overview").innerText()).includes("AND"));
  assert.equal(await get("signing-policy-sessions").getAttribute("open"), null);
  assert(!(await get("signing-policy-overview").innerText()).includes("No HTTP destinations"));
  assert(!(await get("signing-policy-overview").innerText()).includes("other assigned policies"));
  await get("signing-policy-sessions").locator("summary").focus();
  await page.keyboard.press("Enter");
  assert((await get("signing-policy-sessions").innerText()).includes("No active sessions"));
  await page.keyboard.press("Enter");
  await page.screenshot({ path: `${output}/desktop-policy.png`, fullPage: true });
  await get("signing-policy-editor").locator("summary").click();
  assert((await get("signing-policy-editor").innerText()).includes('["relays","wss://one.example/","wss://two.example/"]'));
  const advancedText = await get("signing-policy-editor").innerText();
  for (const text of ["other assigned policies", "do not control where it is published", "No HTTP destinations", "content ≤ 0 bytes", "tags ≤ 16 / 4096 bytes"]) assert(advancedText.includes(text), text);
  await get("signing-policy-json").fill(JSON.stringify({ ...synthetic, enabled: true }));
  await get("signing-policy-save").click();
  assert.equal(writes.length, 0);
  assert((await get("signing-policies-status").innerText()).includes("Enable / Disable"));
  await get("signing-policy-enable-toggle").click();
  await ready();
  assert.equal(await get("signing-policy-status").innerText(), "Enabled");
  assert.equal(writes.length, 1);
  await get("signing-policy-enable-toggle").click();
  await ready();
  assert.equal(await get("signing-policy-status").innerText(), "Disabled");
  await get("signing-policy-add").focus();
  await page.keyboard.press("Enter");
  assert(await get("signing-policy-import-json").evaluate((el) => el === document.activeElement));
  const { revision, ...draft } = synthetic;
  const input = JSON.stringify({ ...draft, id: "second-synthetic", name: "Synthetic repository mirror", enabled: true }, null, 2);
  await get("signing-policy-import-json").fill(input);
  await get("signing-policy-import-review").click();
  assert.equal(JSON.parse(await get("signing-policy-import-preview").innerText()).enabled, false);
  failCreate = true;
  await get("signing-policy-import-create").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="signing-policy-import-status"]').textContent.includes("rejected"));
  assert.equal(await get("signing-policy-import-json").inputValue(), input);
  await get("signing-policy-add").click();
  await get("signing-policy-add").click();
  assert.equal(await get("signing-policy-import-json").inputValue(), input);
  failCreate = false;
  await get("signing-policy-import-review").click();
  await get("signing-policy-import-create").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="signing-policy-import-status"]').textContent.includes("Created second-synthetic disabled"));
  await ready();
  assert.equal(policies.at(-1).enabled, false);
  assert.notEqual(policies.at(-1).name, synthetic.name);
  assert.deepEqual(policies.at(-1).nostrKindRules[0].exactTags, draft.nostrKindRules[0].exactTags);
  await get("signing-policy-add").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/narrow-policy.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await get("signing-policy-add").click();
  await get("signing-policy-import-json").fill(input);
  await page.screenshot({ path: `${output}/narrow-add-policy.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await get("signing-policy-add").click();
  affected = sessions;
  await get("signing-policy-select").nth(1).click();
  await ready();
  assert.equal(await get("signing-policy-sessions").getAttribute("open"), null);
  assert.equal(await get("signing-policy-sessions").locator("summary").first().innerText(), "Affected sessions (1)");
  assert(!(await get("signing-policy-reissue").isVisible()));
  await get("signing-policy-sessions").locator("summary").first().focus();
  await page.keyboard.press("Enter");
  assert((await get("signing-policy-sessions").innerText()).includes("revokes the old capability immediately"));
  page.once("dialog", (dialog) => dialog.dismiss());
  const beforeCancel = writes.length;
  await get("signing-policy-reissue").click();
  assert.equal(writes.length, beforeCancel);
  failReissue = true;
  page.once("dialog", (dialog) => { assert(dialog.message().includes("entire permission snapshot")); return dialog.accept(); });
  await get("signing-policy-reissue").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="signing-policies-status"]').textContent.includes("remains revoked"));
  // A failed older selection must not clear the successfully selected policy.
  let release;
  delayedFailure = new Promise((resolve) => { release = resolve; });
  await get("signing-policy-select").first().click();
  await page.waitForTimeout(80);
  await get("signing-policy-select").nth(1).click();
  await ready();
  release();
  await page.waitForTimeout(120);
  assert.equal(await get("signing-policies-status").getAttribute("data-state"), "ready");
  assert.equal(await get("signing-policy-status").innerText(), "Disabled");
  assert.equal(errors.length, 0, errors.join("\n"));
  // The actual browser production adapter has persisted all displayed API data.
  assert(await page.evaluate(async () => {
    const { default: Dexie } = await import("/vendor/dexie/dexie.mjs");
    const db = new Dexie("WingmanSigningPolicies");
    await db.open();
    const rows = await db.table("views").toArray();
    db.close();
    return rows.some((row) => row.selectedId === "synthetic-repository" && row.syncedAt > 0);
  }));
  console.log(JSON.stringify({ ok: true, output, inventoryButtonHeight: navHeight, mockedWrites: writes.length, browserErrors: errors }));
} finally {
  await browser.close();
  server.stop(true);
}
