import { nip19 } from "nostr-tools";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createProjectStaticAssetService } from "../src/server/static-assets.ts";
import { handleAgentChatApi } from "../src/server/agent-chat-routes.ts";
import { AgentDefinitionStore } from "../src/agent-chat/agent-definition-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const flags = new Map(process.argv.slice(2).reduce<Array<[string, string]>>((pairs, value, i, all) => {
  if (value.startsWith("--")) pairs.push([value, all[i + 1] ?? ""]); return pairs;
}, []));
const playwrightModule = flags.get("--playwright");
const chrome = flags.get("--chrome");
const evidence = flags.get("--evidence");
if (!playwrightModule || !chrome || !evidence) throw new Error("Provide --playwright <index.mjs> --chrome <executable> --evidence <ignored directory>.");
const output = resolve(evidence);
execFileSync("git", ["check-ignore", `${output}/probe.png`]);
if (execFileSync("git", ["ls-files", output], { encoding: "utf8" }).trim()) throw new Error("Evidence directory must be untracked.");
mkdirSync(output, { recursive: true });
const { chromium } = await import(playwrightModule);
const store = new AgentDefinitionStore(`${mkdtempSync(`${tmpdir()}/enrichment-browser-`)}/agents.sqlite`);
const managerNpub = nip19.npubEncode("00".repeat(32));
const now = new Date().toISOString();
store.save({ agentId: "Synthetic", label: "Synthetic", botNpub: "npub1synthetic", workspaceOwnerNpub: managerNpub,
  managedByNpub: managerNpub, workingDirectory: "/workspace", harness: "codex", model: null, groupNpubs: [],
  capabilities: ["chat_intercept"], enabled: true, createdAt: now, updatedAt: now,
  publicProfile: { name: "Synthetic", about: null, picture: null, nip05: null },
  directChat: { handlerMode: "session", enabled: true, sessionAgent: "codex", directory: "/workspace", model: null, idleRetentionMinutes: 60 } });
const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
let backendSupported = true;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Enrichment fixture</title>
<link rel="stylesheet" href="/styles.css"><style>body{font:16px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:8px}fieldset{display:grid;gap:10px}label{display:grid;gap:5px}input,select{padding:7px}</style></head>
<body><main aria-label="Agent Direct enrichment fixture"><button id="edit" aria-label="Edit synthetic agent">Edit synthetic agent</button><section id="dispatch" aria-label="Dispatch"></section></main>
<script type="module">
import { createAgentProfileEditor } from '/views/settings/agent-profile-editor.js';
import { createDispatchTable } from '/fd-dispatch/view.js';
import { loadAgentEnrichmentOptions } from '/services/agent-enrichment-options.js';
let agent = await (await fetch('/fixture-agent')).json();
const editor = createAgentProfileEditor({onSave: async (_agent, input) => {
 const response = await fetch('/api/agent-chat/profiles/Synthetic',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
 const payload = await response.json(); if (!response.ok) throw new Error(payload.error); agent=payload.agent; return payload;
}});
editor.setRuntimeConfig({defaultAgent:'codex', agents:[{id:'codex',label:'Codex',modelOptions:['default']}]});
editor.setEnrichmentOptions(await loadAgentEnrichmentOptions());
document.body.append(editor.element);
document.querySelector('#edit').onclick=()=>editor.open(agent);
document.querySelector('#dispatch').append(createDispatchTable([{action:'session',actionId:'synthetic-session',receivedAt:'2026-10-05T00:00:00Z',workspaceName:'Synthetic workspace',agentId:'Synthetic',sourceLabel:'Synthetic request',trigger:'chat',outcome:'launched',reasonLabel:'Final delivered',details:{enrichment:{status:'ok',runId:'synthetic-enrichment'}}}]));
window.fixtureReady=true;
</script></body></html>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/fixture") return new Response(html, { headers: { "content-type": "text/html" } });
  if (url.pathname === "/fixture-agent") return Response.json(store.getByAgentId("Synthetic"));
  if (url.pathname === "/api/agent-chat/enrichment-options") return backendSupported
    ? Response.json({ supported: true, pipelines: [{ name: "agent-direct-context", version: 1 }] }) : new Response("Not found", { status: 404 });
  if (url.pathname === "/api/agent-chat/profiles/Synthetic") return await handleAgentChatApi(request, url, "PATCH", { npub: managerNpub, session: null }, {
    agentTypes: [{ id: "codex", label: "Codex", modelOptions: ["default"] }],
    manager: { getAgentForManager: () => store.getByAgentId("Synthetic"), validateAgentWorkingDirectory: async () => {},
      saveAgentForManager: async (candidate: any) => store.save(candidate) } as any,
  }) ?? new Response("Not found", { status: 404 });
  return assets.resolveUiAsset(url.pathname) ?? assets.servePublicAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname) ?? new Response("Not found", { status: 404 });
} });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.message); });
  console.log("Open fixture");
  await page.goto(`${server.url}fixture`);
  await page.waitForFunction("window.fixtureReady");
  console.log("Fixture ready");
  await page.click("#edit");
  await page.selectOption('[data-testid="agent-profile-edit-handler-mode"]', "pipeline_enrichment");
  await page.fill('[data-testid="agent-enrichment-workspace"]', "synthetic-workspace");
  await page.selectOption('[data-testid="agent-enrichment-pipeline"]', "agent-direct-context@1");
  await page.fill('[data-testid="agent-enrichment-threshold"]', "0.95");
  await page.fill('[data-testid="agent-enrichment-budget"]', "4500");
  await page.locator('[data-testid="agent-profile-editor-modal"] form').evaluate((form: any) => { form.scrollTop = 0; });
  await page.screenshot({ path: `${output}/settings.png`, fullPage: true });
  console.log("Save settings");
  await page.click('[data-testid="agent-profile-edit-save"]');
  await Bun.sleep(100);
  console.log(await page.locator('[data-testid="agent-profile-edit-status"]').textContent());
  await page.locator('[data-testid="agent-profile-editor-modal"]').waitFor({ state: "hidden" });
  console.log("Settings saved");
  await page.click("#edit");
  console.log("Settings reopened");
  const mode = await page.inputValue('[data-testid="agent-profile-edit-handler-mode"]');
  const threshold = await page.inputValue('[data-testid="agent-enrichment-threshold"]');
  if (mode !== "pipeline_enrichment" || threshold !== "0.95") throw new Error("Settings failed API/database roundtrip.");
  const saved = store.getByAgentId("Synthetic")!;
  if (saved.directChat?.enrichmentByWorkspace?.["synthetic-workspace"]?.memory !== null) throw new Error("None memory was not persisted.");
  await page.click('[data-testid="agent-profile-edit-cancel"]');
  console.log("Check Dispatch");
  const sessionHref = await page.getAttribute('a[aria-label="Open session synthetic-session"]', "href");
  const runHref = await page.getAttribute('[data-testid="dispatch-enrichment-run"]', "href");
  if (sessionHref !== "/live/synthetic-session" || runHref !== "/pipelines/runs/synthetic-enrichment") throw new Error("Dispatch links are wrong.");
  await page.screenshot({ path: `${output}/dispatch.png`, fullPage: true });
  for (const path of ["/views/settings/agent-enrichment-fields.js", "/fd-dispatch/enrichment-evidence.js", "/services/agent-enrichment-options.js"]) {
    const response = await fetch(new URL(path, server.url));
    if (!response.headers.get("content-type")?.includes("application/javascript")) throw new Error(`Wrong module MIME: ${path}`);
  }
  console.log("Verify activation gate");
  backendSupported = false;
  await page.reload(); await page.waitForFunction("window.fixtureReady"); await page.click("#edit");
  const enrichmentOptions = await page.locator('[data-testid="agent-profile-edit-handler-mode"] option[value="pipeline_enrichment"]').count();
  if (enrichmentOptions) throw new Error("Unsupported backend exposed enrichment mode.");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ settingsRoundtrip: true, memoryNone: true, dispatchLinks: true, moduleMime: true,
    activationGate: true, browserErrors: errors, evidence: output }));
} finally { await browser.close(); server.stop(true); }
