import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "./pipeline-store";
import { runDeclarativePipeline, resumeDeclarativePipeline, acceptAgentCallback } from "./pipeline-runner";
import { snapshotPipelineBlocks } from "./pipeline-block-snapshot";
import { viewerSnapshot, viewerDefinition } from "./pipeline-viewer-dto";
import { assertRuntimeViewer } from "./pipeline-viewer-runtime-test-support";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import type { DeclarativeStep } from "./declarative";
import type { AgentAdapter } from "../agents/agent-adapter";
import type { SessionApiContext } from "../server/session-api-routes";
import type { SessionSnapshot } from "../agents/process-manager";

let dir: string; let store: PipelineStore;
const nativeFetch = globalThis.fetch;
const oldKey = process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "viewer-runtime-")); store = new PipelineStore(join(dir, "runs.sqlite")); });
afterEach(() => { globalThis.fetch = nativeFetch; if (oldKey === undefined) delete process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY; else process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = oldKey; rmSync(dir, { recursive: true, force: true }); });
function definition(steps: DeclarativeStep[]): PipelineDefinitionRecord {
  return { id: "runtime", slug: "runtime", name: "runtime", scope: "shared", ownerAlias: null, path: "synthetic.json", spec: { name: "runtime", steps } };
}
function runner(def: PipelineDefinitionRecord, sessionApiContext: SessionApiContext = {} as never) {
  return { store, definition: def, sessionApiContext, registry: {}, input: {}, ownerNpub: "synthetic-owner", ownerAlias: null, callbackOrigin: "http://callback.local" };
}

test("successful classifier echoes redact provider credentials in requests output state and summaries", async () => {
  const secret = "synthetic-known-provider-key"; process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = secret;
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ context: `echo ${secret}`, ordinary: "  unchanged\n prose  " }) } }] })) as typeof fetch;
  const def = definition([{ id: "judge-id", name: "judge-name", type: "classifier", prompt: `Context ${secret}`, assign: "$.judgment" }]);
  const run = await runDeclarativePipeline(runner(def)); expect(run.status).toBe("ok");
  for (const ref of store.evidence.list(run.id).filter(ref => ["executor_request", "returned_output", "state_write"].includes(ref.kind))) {
    expect(ref.redacted).toBe(true); expect(ref.availability).toBe("redacted");
    const value = store.evidence.get(run.id, ref.id)!.value; expect(JSON.stringify(value)).not.toContain(secret);
    if (ref.kind === "returned_output") expect(value).toMatchObject({ context: "echo [REDACTED]", ordinary: "  unchanged\n prose  " });
  }
  expect(JSON.stringify(viewerSnapshot(run.id, store, "service"))).not.toContain(secret);
  await assertRuntimeViewer("provider-redaction", store, run.id);
});

test("pinned block expansion drives runner and history despite changed expansion implementation", async () => {
  const def = definition([{ id: "accept-id", name: "accept-name", type: "block", block: "flightdeck.threadInvocation" }]);
  let revision = "old";
  const expand = () => ({ scratchPath: "$.scratch", inputPath: "$.scratch.input", outputPath: "$.answer", steps: [{ id: `node-${revision}`, name: `node-${revision}`, type: "code" as const, function: `implementation.${revision}`, assign: "$.answer" }] });
  const pinned = snapshotPipelineBlocks(def.spec.steps, expand);
  const run = store.createRun({ definitionId: def.id, name: def.name, scope: "shared", input: {} });
  store.composition.pin(run.id, def, { blockExpansions: pinned });
  const before = viewerSnapshot(run.id, store, "service").definition;
  revision = "new"; const changed = snapshotPipelineBlocks(def.spec.steps, expand);
  expect(changed).not.toEqual(pinned);
  store.composition.pin(run.id, def, { blockExpansions: changed }); // Existing history cannot be replaced.
  const resumed = await resumeDeclarativePipeline({ ...runner(def), registry: { "implementation.old": async () => ({ used: "old" }) } }, run.id);
  expect(resumed?.status).toBe("ok"); expect(resumed?.result?.answer).toEqual({ used: "old" });
  expect(viewerSnapshot(run.id, store, "service").definition).toEqual(before);
  expect(store.listSteps(run.id).map(step => step.logicalKey)).toEqual(["accept-id", "accept-id/node-old"]);
  expect(store.listSteps(run.id)[1]!.parentStepId).toBe(store.listSteps(run.id)[0]!.id);
  await assertRuntimeViewer("pinned-block-expansion", store, run.id);
});

function callbackSessionContext(): SessionApiContext {
  const sessions = new Map<string, SessionSnapshot>();
  const adapter = {
    fetchStatus: async () => "stable", getPromptReadiness: async () => ({ state: "ready", reason: "synthetic", retryAfterMs: 1, observedAt: Date.now() }),
    sendMessage: async (content: string) => {
      const url = new URL(content.match(/http:\/\/callback\.local\/api\/pipelines\/runs\/[^\s']+/)![0]!);
      const parts = url.pathname.split("/");
      await acceptAgentCallback({ store, runId: parts[4]!, stepId: parts[6]!, token: url.searchParams.get("token"), payload: { runId: parts[4]!, stepId: parts[6]!, status: "ok", result: { answer: "synthetic" } } });
    },
    deliversPromptsDirectly: () => true, fetchMessages: async () => [], waitForReady: async () => {}, interruptCurrentTurn: async () => false,
    getEventsUrl: () => null, dispose: async () => {},
  } as unknown as AgentAdapter;
  return { manager: {
    createSession: async () => { const session = { id: `synthetic-${sessions.size}`, agent: "codex", port: 49999, status: "running", startedAt: new Date().toISOString(), workingDirectory: dir, command: [], logs: [], metadata: {} } as SessionSnapshot; sessions.set(session.id, session); return session; },
    getSession: (id: string) => sessions.get(id) ?? null, getAdapter: () => adapter, updateSessionMetadata: (id: string) => sessions.get(id),
    stopSession: async () => true,
  }, agentHost: "localhost", buildAgentUrl: (host: string, port: number, path: string) => new URL(`http://${host}:${port}${path}`),
  messageStore: { recordSession() {} }, syncSessionMessages: async () => {}, scheduleSessionArchive() {}, isAgentType: (value: string) => value === "codex" } as unknown as SessionApiContext;
}

test("explicit agent IDs in nested loops and parallel items retain stable keys parents and distinct items", async () => {
  const def = definition([
    { id: "repeat-id", name: "repeat-name", type: "loop", iterations: 2, steps: [{ id: "agent-id", name: "agent-name", type: "agent", prompt: "Return synthetic answer", assign: "$.answer" }] },
    { id: "map-id", name: "map-name", type: "parallel", source: "$.items", itemKey: "$item.id", step: { id: "worker-id", name: "worker-name", type: "agent", prompt: "Return synthetic answer" } },
  ]);
  const run = await runDeclarativePipeline({ ...runner(def, callbackSessionContext()), input: { items: [{ id: "a" }, { id: "b" }] } });
  if (run.status !== "ok") throw new Error(run.error ?? "runtime failed");
  expect(run.status).toBe("ok");
  const summary = await assertRuntimeViewer("nested-parallel-agents", store, run.id);
  const nested = summary.steps.filter(step => step.logicalKey === "repeat-id/agent-id");
  expect(nested).toHaveLength(2); expect(nested.map(step => step.attempt)).toEqual([1, 2]);
  expect(nested.every(step => step.parentStepId === summary.steps.find(step => step.logicalKey === "repeat-id")!.id)).toBe(true);
  const items = summary.steps.filter(step => step.logicalKey === "map-id/worker-id");
  expect(items.map(step => step.itemKey)).toEqual(["a", "b"]); expect(new Set(items.map(step => step.id)).size).toBe(2);
  expect(items.every(step => step.parentStepId === summary.steps.find(step => step.logicalKey === "map-id")!.id)).toBe(true);
});

test("native memory block agent and code descendants map to pinned definition nodes", async () => {
  const def = definition([{ id: "memory-id", name: "memory-name", type: "block", block: "memory.graphContext", assign: "$.context" }]);
  const run = await runDeclarativePipeline({ ...runner(def, callbackSessionContext()), input: { prompt: "synthetic" }, registry: {
    "memory.searchEntities": async () => ({ matches: [], warnings: [] }),
    "memory.consolidateGraphContext": async () => ({ context: "synthetic" }),
  } });
  expect(run.status).toBe("ok"); const snapshot = await assertRuntimeViewer("native-memory-block", store, run.id);
  const parent = snapshot.steps.find(step => step.logicalKey === "memory-id")!;
  expect(snapshot.steps.filter(step => step.parentStepId === parent.id)).toHaveLength(3);
  expect(snapshot.steps.find(step => step.kind === "agent")!.logicalKey).toBe("memory-id/memory-name / extract-memory-entities");
});

test("configured owner credential sanitizes resolved input before executor capture", async () => {
  const secret = "synthetic-owner-provider-secret";
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ context: secret }) } }] })) as typeof fetch;
  const def = definition([{ name: "judge", type: "classifier", prompt: "Inspect context", assign: "$.judgment" }]);
  const sessionApiContext = { getStoredInstanceSetting: (key: string) => key === "pipelines.classifier_openrouter_api_key" ? secret : null } as unknown as SessionApiContext;
  const run = await runDeclarativePipeline({ ...runner(def, sessionApiContext), input: { context: `echo ${secret}` } });
  expect(run.status).toBe("ok");
  for (const ref of store.evidence.list(run.id)) {
    expect(ref.redacted).toBe(true); expect(JSON.stringify(store.evidence.get(run.id, ref.id)!.value)).not.toContain(secret);
  }
});

test("resuming an interrupted classifier appends executor attempt identity on the same execution", async () => {
  process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = "synthetic-provider";
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: '{"answer":"resumed"}' } }] })) as typeof fetch;
  const def = definition([{ id: "classifier-id", name: "classifier-name", type: "classifier", prompt: "Resume", assign: "$.answer" }]);
  const run = store.createRun({ name: def.name, definitionId: def.id, scope: "shared", input: {} }); store.composition.pin(run.id, def, {});
  const step = store.createStep({ runId: run.id, stepIndex: 0, logicalKey: "classifier-id", name: "classifier-name", kind: "classifier", input: {} });
  store.evidence.capture({ runId: run.id, stepId: step.id, kind: "executor_request", scope: "assembled_model_request", value: { messages: [{ role: "user", content: "Previously sent request" }] }, attempt: 1 });
  store.setRunActiveStep(run.id, step.id);
  const resumed = await resumeDeclarativePipeline(runner(def), run.id); expect(resumed?.status).toBe("ok");
  const snapshot = await assertRuntimeViewer("classifier-interrupted-resume", store, run.id);
  expect(snapshot.steps).toHaveLength(1); expect(snapshot.steps[0]!.attempt).toBe(1);
  expect(snapshot.steps[0]!.evidence.filter(ref => ref.kind === "executor_request").map(ref => ref.attempt)).toEqual([1, 2]);
  expect(snapshot.steps[0]!.evidence.findLast(ref => ref.kind === "returned_output")!.attempt).toBe(2);
});

test("historical blocks without retained expansion are unavailable and never expanded on resume", async () => {
  const { Database } = await import("bun:sqlite");
  const def = definition([{ name: "legacy-block", type: "block", block: "flightdeck.threadInvocation" }]);
  const run = store.createRun({ name: def.name, definitionId: def.id, scope: "shared", input: {} }); store.composition.pin(run.id, def, {});
  const db = new Database(store.path); db.run("UPDATE pipeline_run_snapshots SET context_json = '{}' WHERE run_id = ?", [run.id]); db.close();
  const before = viewerSnapshot(run.id, store, "service");
  await assertRuntimeViewer("legacy-missing-expansion", store, run.id);
  expect(before.definition.availability).toBe("unavailable"); expect(before.definition.steps[0]!.children).toEqual([]);
  const resumed = await resumeDeclarativePipeline(runner(def), run.id);
  expect(resumed?.status).toBe("error"); expect(resumed?.error).toContain("Historical block expansion was not captured");
  expect(viewerSnapshot(run.id, store, "service").definition.hash).toBe(before.definition.hash);
});

test("completed legacy block uses recorded state without re-expansion; pending inventory is read-only", async () => {
  const { Database } = await import("bun:sqlite"); const { auditLegacyBlockResumes } = await import("./pipeline-block-resume-audit");
  const def = definition([{ id: "legacy-id", name: "legacy", type: "block", block: "flightdeck.threadInvocation" }, { name: "finish", type: "code", function: "finish" }]);
  const run = store.createRun({ name: def.name, definitionId: def.id, scope: "shared", input: {} }); store.composition.pin(run.id, def, {});
  const block = store.createStep({ runId: run.id, stepIndex: 0, name: "legacy", logicalKey: "legacy-id", kind: "block", input: {} });
  store.completeStep({ id: block.id, status: "ok", result: { recorded: "old" }, output: { recorded: "old" } }); store.setRunActiveStep(run.id, block.id);
  const db = new Database(store.path); db.run("UPDATE pipeline_run_snapshots SET context_json = '{}' WHERE run_id = ?", [run.id]); db.close();
  const readonly = new Database(store.path, { readonly: true });
  expect(auditLegacyBlockResumes(readonly)).toEqual([{ runId: run.id, status: "running", cursorIndex: 0, missingSnapshot: false, missingBlockKeys: ["legacy-id"], completedBlockKeys: ["legacy-id"] }]); readonly.close();
  store.completeRun(run.id, "error", null, "synthetic failure");
  const errorAudit = new Database(store.path, { readonly: true });
  expect(auditLegacyBlockResumes(errorAudit)[0]?.status).toBe("error"); errorAudit.close();
  store.reopenErroredRun(run.id);
  store.setRunActiveStep(run.id, block.id);
  const resumed = await resumeDeclarativePipeline({ ...runner(def), registry: { finish: async input => ({ used: input.recorded }) } }, run.id);
  expect(resumed?.status).toBe("ok"); expect(resumed?.result).toEqual({ used: "old" });
  const snapshot = await assertRuntimeViewer("legacy-completed-block", store, run.id); expect(snapshot.definition.availability).toBe("unavailable");
});

test("actual legacy executed block descendants remain visible through frontend projection", async () => {
  const { Database } = await import("bun:sqlite");
  const def = definition([{ id: "accept-id", name: "accept-name", type: "block", block: "flightdeck.threadInvocation" }]);
  const run = await runDeclarativePipeline({ ...runner(def), registry: { "flightdeck.threadInvocation": async () => ({ normalized: true }) } });
  expect(run.status).toBe("ok"); expect(store.listSteps(run.id)).toHaveLength(2);
  const db = new Database(store.path); db.run("UPDATE pipeline_run_snapshots SET context_json = '{}' WHERE run_id = ?", [run.id]); db.close();
  const snapshot = await assertRuntimeViewer("legacy-executed-block", store, run.id);
  expect(snapshot.definition.availability).toBe("unavailable"); expect(snapshot.steps).toHaveLength(2);
});

test("pending legacy run without a definition snapshot blocks instead of replaying latest code", async () => {
  const def = definition([{ name: "effect", type: "code", function: "effect" }]);
  const run = store.createRun({ name: def.name, definitionId: def.id, scope: "shared", input: { retained: "old" } });
  let calls = 0;
  const resumed = await resumeDeclarativePipeline({ ...runner(def), registry: { effect: async () => { calls++; return {}; } } }, run.id);
  expect(resumed?.status).toBe("error"); expect(resumed?.error).toContain("Historical pipeline definition snapshot was not captured");
  expect(calls).toBe(0); expect(store.getRun(run.id)!.input).toEqual({ retained: "old" }); expect(store.listSteps(run.id)).toEqual([]);
});


test("reopened viewer routes resolve configured provider secrets for all outward boundaries", async () => {
  const { handlePipelineViewerApi } = await import("./pipeline-viewer-routes");
  const { nip19 } = await import("nostr-tools");
  const owner = nip19.npubEncode("11".repeat(32));
  const secret = "synthetic-reopened-instance-provider";
  const settings = { getStoredInstanceSetting: (key: string) => key === "pipelines.classifier_openrouter_api_key" ? secret : null } as unknown as SessionApiContext;
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ context: secret }) } }] })) as typeof fetch;
  const def = definition([{ id: "judge", name: "judge", type: "classifier", prompt: secret, description: secret }]);
  def.spec.description = secret;
  const run = await runDeclarativePipeline({ ...runner(def, settings), ownerNpub: owner });
  expect(run.status).toBe("ok");
  const trusted = { workspaceId: "workspace", towerServiceNpub: "tower", appNpub: "app", initiatingAgentProfileId: "agent", initiatingAgentNpub: "bot" };
  store.addEvent({ runId: run.id, type: "flightdeck_invocation_context", level: "info", data: trusted });
  const refs = store.evidence.list(run.id);
  store = new PipelineStore(store.path);
  // Retired credentials must stay redacted without any current read-time resolver.
  expect(JSON.stringify(viewerSnapshot(run.id, store, "service"))).not.toContain(secret);
  const ctx = { store, identity: { pubkeyHex: "33".repeat(32) }, providerCredentialContext: settings,
    workspaceDelegationStore: { findActiveDelegation: () => null }, agentStore: { getByAgentId: () => ({ managedByNpub: owner, botNpub: "bot", enabled: true }), canInstruct: () => true },
    pipelineBindingStore: { listAvailableIds: () => [def.id] }, listPipelineDefinitions: async () => [def] };
  ctx.providerCredentialContext = {} as SessionApiContext;
  for (const path of [`runs/${run.id}`, `runs/${run.id}/updates`, "runs", "definitions", `definitions/${def.id}`, ...refs.map(ref => `runs/${run.id}/evidence/${ref.id}`)]) {
    const url = new URL(`https://synthetic.test/api/owners/${owner}/control-plane/v1/pipeline-viewer/${path}?workspace_id=workspace&tower_service_npub=tower&app_npub=app`);
    const response = await handlePipelineViewerApi(new Request(url), url, { authMethod: "nip98", npub: owner, subjectNpub: owner, signerNpub: owner } as never, ctx as never);
    expect(response?.status).toBe(200); const body = await response!.json(); expect(JSON.stringify(body)).not.toContain(secret);
    if (path === "definitions") expect(body.definitions[0].availability).toBe("redacted");
    if (path === `definitions/${def.id}`) expect(body.definition.availability).toBe("redacted");
  }
});


test("assigned-state wiring names captured source value and declared endpoint ports", () => {

  const def = definition([{ id: "source", name: "source", type: "code", function: "source", assign: "$.bird", display: { out: [{ label: "Tweets", path: "$.retrieval.tweets" }] } },
    { id: "target", name: "target", type: "code", function: "target", input: { pick: { state: "$.bird.retrieval" } }, display: { in: [{ label: "Tweets", path: "$.state.tweets" }] } }]);
  expect(viewerDefinition(def).wiring[0]).toMatchObject({ sourceStepKey: "source", sourcePath: "$.bird.retrieval", sourceValuePath: "$.retrieval", sourcePortPaths: ["$.retrieval.tweets"], targetPath: "$.state", targetPortPaths: ["$.state.tweets"] });
});
