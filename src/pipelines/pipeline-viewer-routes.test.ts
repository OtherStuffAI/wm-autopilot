import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import { PipelineStore } from "./pipeline-store";
import { handlePipelineViewerApi, type PipelineViewerRoutesContext } from "./pipeline-viewer-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { PipelineDefinitionRecord } from "./pipeline-loader";

const owner = nip19.npubEncode("11".repeat(32)); const delegate = nip19.npubEncode("22".repeat(32));
const context = { workspaceId: "synthetic-workspace", towerServiceNpub: "synthetic-tower", appNpub: "synthetic-app",
  initiatingAgentProfileId: "synthetic-agent", initiatingAgentNpub: "synthetic-bot" };
const definition = { id: "definition-1", name: "synthetic", scope: "shared", ownerAlias: null, path: "/private/path",
  spec: { name: "synthetic", version: 2, steps: [{ id: "retrieve", name: "retrieve", type: "code", function: "synthetic", description: "Read records", display: { in: [{ label: "Request", path: "$.request" }] } }] } } as PipelineDefinitionRecord;
let dir: string; let store: PipelineStore; let ctx: PipelineViewerRoutesContext; let runId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "viewer-api-")); store = new PipelineStore(join(dir, "runs.sqlite"));
  ctx = { store, identity: { pubkeyHex: "33".repeat(32) } as never,
    workspaceDelegationStore: { findActiveDelegation: (_owner: string, signer: string, scope: string) => signer === delegate && scope === "control-plane:read" ? { resourceFilters: { agentIds: ["synthetic-agent"] }, scopes: [scope] } : null } as never,
    agentStore: { getByAgentId: () => ({ agentId: "synthetic-agent", botNpub: "synthetic-bot", managedByNpub: owner, enabled: true }), canInstruct: () => true } as never,
    pipelineBindingStore: { listAvailableIds: () => [definition.id] } as never,
    listPipelineDefinitions: async () => [definition] };
  runId = createRun();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function createRun(trusted: Record<string, unknown> | null = context) {
  const run = store.createRun({ name: "synthetic", definitionId: definition.id, scope: "shared", ownerNpub: owner, input: context });
  store.composition.pin(run.id, definition, { initiatingAgentProfileId: "synthetic-agent", initiatingAgentNpub: "synthetic-bot" });
  if (trusted) store.addEvent({ runId: run.id, type: "flightdeck_invocation_context", level: "info", data: trusted });
  return run.id;
}
async function request(path: string, signer = owner, query = "", method = "GET") {
  const url = new URL(`https://synthetic.test/api/owners/${owner}/control-plane/v1/pipeline-viewer/${path}`);
  url.searchParams.set("workspace_id", context.workspaceId); url.searchParams.set("tower_service_npub", context.towerServiceNpub); url.searchParams.set("app_npub", context.appNpub);
  new URLSearchParams(query).forEach((value, key) => url.searchParams.set(key, value));
  return (await handlePipelineViewerApi(new Request(url, { method }), url,
    { authMethod: "nip98", npub: signer, subjectNpub: signer, signerNpub: signer } as RequestAuthContext, ctx))!;
}
test("owner and read delegate get sanitized pinned snapshot and polling recovery", async () => {
  for (const signer of [owner, delegate]) {
    runId = createRun();
    const response = await request(`runs/${runId}`, signer); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const snapshot = await response.json(); expect(snapshot.version).toBe(1); expect(snapshot.serviceId).toStartWith("autopilot_");
    expect(snapshot.definition.version).toBe(2); expect(JSON.stringify(snapshot)).not.toContain("/private/path");
    const unchanged = await (await request(`runs/${runId}/updates`, signer, `after=${snapshot.revision}`)).json(); expect(unchanged.unchanged).toBe(true);
    store.cancelRun(runId); const updated = await (await request(`runs/${runId}/updates`, signer, `after=${snapshot.revision}`)).json();
    expect(updated.unchanged).toBe(false); expect(updated.run.status).toBe("cancelled");
  }
});
test("workspace Tower app missing authority and agent filters deny all related reads", async () => {
  for (const query of ["workspace_id=other", "tower_service_npub=other", "app_npub=other"]) {
    expect((await request(`runs/${runId}`, owner, query)).status).toBe(404);
    expect((await request(`runs/${runId}/evidence/synthetic`, owner, query)).status).toBe(404);
  }
  expect((await request(`runs/${runId}`, nip19.npubEncode("44".repeat(32)))).status).toBe(403);
  ctx.workspaceDelegationStore = { findActiveDelegation: () => ({ resourceFilters: { agentIds: ["other"] } }) } as never;
  expect((await request(`runs/${runId}`, delegate)).status).toBe(404);
  ctx.agentStore = { getByAgentId: () => ({ managedByNpub: "wrong-owner", botNpub: "synthetic-bot", enabled: true }), canInstruct: () => true } as never;
  expect((await request(`runs/${runId}`)).status).toBe(404);
});
test("no trusted context never falls back to arbitrary input; child and evidence inherit root ACL", async () => {
  const legacy = createRun(null); expect((await request(`runs/${legacy}`)).status).toBe(404);
  const child = createRun(); const step = store.createStep({ runId, stepIndex: 0, name: "child", kind: "pipeline", input: {} });
  store.composition.link({ parentRunId: runId, parentStepId: step.id, childRunId: child, deadline: Date.now() + 1000 });
  expect((await request(`runs/${child}`)).status).toBe(200);
  expect((await request(`runs/${child}`, owner, "workspace_id=other")).status).toBe(404);
  expect((await request(`runs/${child}/evidence/${store.evidence.list(runId)[0]!.id}`)).status).toBe(404);
});
test("full arrays page past 20 and exact text survives compaction; malformed pagination rejected", async () => {
  const step = store.createStep({ runId, stepIndex: 0, name: "retrieve", kind: "code", input: { request: "x".repeat(80_000) } });
  const tweets = Array.from({ length: 35 }, (_, i) => ({ id: String(i), text: `exact ${i}` }));
  const ref = store.evidence.capture({ runId, stepId: step.id, kind: "returned_output", scope: "test-array", value: tweets });
  store.completeStep({ id: step.id, status: "ok", result: {}, output: {} }); store.completeRun(runId, "ok", {}); store.compactCompletedRunPayloads({});
  const page = await (await request(`runs/${runId}/evidence/${ref.id}`, owner, "offset=20&limit=10")).json(); expect(page.value).toEqual(tweets.slice(20, 30)); expect(page.nextOffset).toBe(30);
  const inputRef = store.evidence.list(runId).find(ref => ref.kind === "resolved_input")!;
  expect((await (await request(`runs/${runId}/evidence/${inputRef.id}`)).json()).value.request).toHaveLength(80_000);
  for (const query of ["limit=0", "limit=abc", "cursor=garbage", "limit=1000"]) expect((await request("runs", owner, query)).status).toBe(400);
  expect((await request("runs", owner, "", "POST")).status).toBe(405);
});
test("all owner runs remain reachable via stable cursors beyond 100 records", async () => {
  for (let i = 0; i < 106; i++) createRun();
  let cursor: string | null = null; const ids: string[] = [];
  do {
    const page = await (await request("runs", owner, `limit=17${cursor ? `&cursor=${cursor}` : ""}`)).json();
    ids.push(...page.runs.map((run: { id: string }) => run.id)); cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(ids).size).toBe(107);
});
test("historical definition remains pinned; legacy absence explicit and denied IDs absent", async () => {
  definition.spec.version = 99;
  const snapshot = await (await request(`runs/${runId}`)).json(); expect(snapshot.definition.version).toBe(2);
  const legacy = store.createRun({ name: "legacy", definitionId: "legacy", scope: "user", ownerNpub: owner, input: {} });
  store.addEvent({ runId: legacy.id, level: "info", type: "flightdeck_invocation_context", data: context });
  const step = store.createStep({ runId: legacy.id, stepIndex: 0, name: "historical", kind: "code", input: {} });
  const db = new (require("bun:sqlite").Database)(store.path); db.run("DROP TRIGGER pipeline_evidence_immutable_delete"); db.run("DELETE FROM pipeline_evidence WHERE step_id = ?", [step.id]); db.close();
  const old = await (await request(`runs/${legacy.id}`)).json(); expect(old.definition.availability).toBe("unavailable"); expect(old.steps[0].evidence[0].availability).toBe("not_captured");
  definition.spec.version = 2;
});

test("restricted delegate catalogue requires an allowed definition binding; revoked grants deny", async () => {
  expect((await request(`definitions/${definition.id}`, delegate)).status).toBe(200);
  ctx.pipelineBindingStore = { listAvailableIds: () => [] } as never;
  expect((await request(`definitions/${definition.id}`, delegate)).status).toBe(404);
  expect((await (await request("definitions", delegate)).json()).definitions).toEqual([]);
  expect((await request(`runs/${runId}`, delegate)).status).toBe(200);
  ctx.workspaceDelegationStore = { findActiveDelegation: () => null } as never;
  expect((await request(`runs/${runId}`, delegate)).status).toBe(403);
  expect((await request(`definitions/${definition.id}`, delegate)).status).toBe(403);
});

test("definition defaults paths and credential-bearing error text never enter viewer DTOs", async () => {
  const step = store.createStep({ runId, stepIndex: 0, name: "test", kind: "code", callbackToken: "synthetic-private-callback", input: {} });
  store.completeStep({ id: step.id, status: "error", result: null, error: "Bearer synthetic-key nsec1private123 ?token=synthetic-private-callback" });
  const snapshot = await (await request(`runs/${runId}`)).json();
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-key"); expect(JSON.stringify(snapshot)).not.toContain("nsec1private123");
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-callback");
});
