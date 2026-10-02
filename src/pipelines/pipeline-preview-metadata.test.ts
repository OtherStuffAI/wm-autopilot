import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "./pipeline-store";
import { viewerSnapshot } from "./pipeline-viewer-dto";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { runDeclarativePipeline } from "./pipeline-runner";
import { retainedCredentialExposure } from "./pipeline-evidence-scope";
import { PipelineEvidenceStore } from "./pipeline-evidence-store";

let directory: string; let store: PipelineStore;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "preview-selectors-")); store = new PipelineStore(join(directory, "runs.sqlite")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

for (const origin of ["callback", "input", "provider", "shaped"]) test(`${origin} credentials redact selectors/object keys before capture and remain safe after retirement`, () => {
  const secret = origin === "shaped" ? "nsec1syntheticcredential" : `synthetic-${origin}-selector-credential`;
  if (origin === "provider") store.evidence.registerSecret(secret);
  const value = { [secret]: "safe", ...(origin === "input" ? { apiKey: secret } : {}) };
  const path = `$.${secret}`;
  const run = store.createRun({ definitionId: "synthetic", name: "synthetic", scope: "shared", input: {} });
  const definition = { id: "synthetic", name: "synthetic", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "synthetic", steps: [{ id: "safe", name: "safe", type: "code", function: "safe", display: { in: [{ label: "Value", path }], out: [{ label: "Value", path }] } }] } } as PipelineDefinitionRecord;
  store.composition.pin(run.id, definition, {});
  const pin = store.composition.snapshot(run.id)!;
  const step = store.createStep({ runId: run.id, stepIndex: 0, name: "safe", kind: "code", input: value,
    callbackToken: origin === "callback" ? secret : null,
    metadata: { display: { in: [{ label: "Value", path }], out: [{ label: "Value", path }] } } });
  store.completeStep({ id: step.id, status: "ok", output: value, result: value }); store.completeRun(run.id, "ok", {});
  const before = store.evidence.list(run.id);
  for (const ref of before.filter(ref => ["resolved_input", "returned_output"].includes(ref.kind))) {
    expect(ref.redacted).toBe(true);
    expect(ref.preview!.fields!["$.[REDACTED]"]).toEqual({ present: true, value: "safe", truncated: false, count: null });
  }
  expect(JSON.stringify(before)).not.toContain(secret);
  expect(JSON.stringify(viewerSnapshot(run.id, store, "synthetic-service"))).not.toContain(secret);
  expect(store.composition.snapshot(run.id)!.definition).toEqual(pin.definition);
  expect(store.composition.snapshot(run.id)!.hash).toBe(pin.hash);
  expect(JSON.stringify(store.getStep(step.id)!.metadata)).not.toContain(secret);
  store = new PipelineStore(store.path); store.compactCompletedRunPayloads({});
  expect(store.evidence.list(run.id)).toEqual(before);
  expect(JSON.stringify(viewerSnapshot(run.id, store, "synthetic-service"))).not.toContain(secret);
  for (const ref of before) expect(JSON.stringify(store.evidence.get(run.id, ref.id))).not.toContain(secret);
  // A new boundary alias still uses durable safe paths when the configured provider is gone.
  const extra = store.evidence.capture({ runId: run.id, stepId: step.id, kind: "returned_output", scope: "retired-alias", value });
  expect(JSON.stringify(extra)).not.toContain(secret);
  expect(extra.preview!.fields!["$.[REDACTED]"]!.present).toBe(true);
});

test("output-discovered credentials jointly sanitize persisted metadata and preview paths", () => {
  const secret = "synthetic-late-output-selector";
  const run = store.createRun({ definitionId: "synthetic", name: "synthetic", scope: "shared", input: {} });
  const definition = { id: "synthetic", name: "synthetic", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "synthetic", steps: [{ id: "safe", name: "safe", type: "code", function: "safe", display: { out: [{ label: "Value", path: `$.${secret}` }] } }] } } as PipelineDefinitionRecord;
  store.composition.pin(run.id, definition, {}); const pin = store.composition.snapshot(run.id)!;
  const step = store.createStep({ runId: run.id, stepIndex: 0, name: "safe", kind: "code", input: {},
    metadata: { display: { out: [{ label: "Value", path: `$.${secret}` }] } } });
  store.completeStep({ id: step.id, status: "ok", output: { apiKey: secret, [secret]: "safe" }, result: {} });
  const ref = store.evidence.list(run.id).find(ref => ref.kind === "returned_output")!;
  expect(ref.redacted).toBe(true); expect(ref.preview!.fields!["$.[REDACTED]"]!.value).toBe("safe");
  expect(JSON.stringify(store.getStep(step.id)!.metadata)).not.toContain(secret);
  store = new PipelineStore(store.path);
  expect(JSON.stringify(store.evidence.list(run.id))).not.toContain(secret);
  expect(JSON.stringify(viewerSnapshot(run.id, store, "synthetic-service"))).not.toContain(secret);
  expect(store.composition.snapshot(run.id)!.definition).toEqual(pin.definition);
  expect(store.composition.snapshot(run.id)!.hash).toBe(pin.hash);
});

test("pin captures invocation credentials before any step or retirement, preserving raw definition/hash", () => {
  const secret = "synthetic-pin-input-selector";
  const run = store.createRun({ definitionId: "synthetic", name: "synthetic", scope: "shared", input: { apiKey: secret } });
  const definition = { id: "synthetic", name: "synthetic", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "synthetic", steps: [{ name: "safe", type: "code", function: "safe", display: { in: [{ label: "Value", path: `$.${secret}` }] } }] } } as PipelineDefinitionRecord;
  store.composition.pin(run.id, definition, {});
  const pin = store.composition.snapshot(run.id)!;
  expect(pin.definition).toEqual(definition);
  expect(JSON.stringify(pin.context.viewerDefinition)).not.toContain(secret);
  expect(pin.context.viewerRedacted).toBe(true);
  store = new PipelineStore(store.path);
  expect(JSON.stringify(viewerSnapshot(run.id, store, "synthetic-service"))).not.toContain(secret);
  expect(store.composition.snapshot(run.id)!.hash).toBe(pin.hash);
});

test("actual runner output credentials refine pinned viewer structure without changing execution evidence", async () => {
  const secret = "synthetic-runner-output-selector";
  const definition = { id: "synthetic", name: "synthetic", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "synthetic", steps: [{ id: "emit", name: "emit", type: "code", function: "emit", display: { out: [{ label: "Value", path: `$.${secret}` }] } }] } } as PipelineDefinitionRecord;
  const run = await runDeclarativePipeline({ store, definition, registry: { emit: () => ({ apiKey: secret, [secret]: "safe" }) },
    input: {}, ownerNpub: null, ownerAlias: null, callbackOrigin: "http://localhost", sessionApiContext: {} as never });
  expect(run.status).toBe("ok"); expect(run.result!.apiKey).toBe(secret);
  const pinned = store.composition.snapshot(run.id)!; expect(pinned.definition).toEqual(definition);
  store = new PipelineStore(store.path); store.compactCompletedRunPayloads({});
  const snapshot = viewerSnapshot(run.id, store, "synthetic-service");
  expect(JSON.stringify(snapshot)).not.toContain(secret); expect(snapshot.definition.availability).toBe("redacted");
  expect(snapshot.steps[0]!.outputs[0]!.path).toBe("$.[REDACTED]");
  const ref = snapshot.steps[0]!.evidence.find(ref => ref.kind === "returned_output")!;
  expect(ref.preview!.fields!["$.[REDACTED]"]).toEqual({ present: true, value: "safe", truncated: false, count: null });
  expect(store.composition.snapshot(run.id)!.hash).toBe(pinned.hash);
});

test("child-discovered credentials refine actual ancestor viewer pins within the verified owner chain", () => {
  const secret = "synthetic-child-selector";
  const definition = { id: "synthetic", name: "synthetic", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "synthetic", steps: [{ name: "safe", type: "code", function: "safe", display: { in: [{ label: "Value", path: `$.${secret}` }] } }] } } as PipelineDefinitionRecord;
  const parent = store.createRun({ definitionId: "synthetic", name: "parent", scope: "shared", input: {} }); store.composition.pin(parent.id, definition, {});
  const parentPin = store.composition.snapshot(parent.id)!;
  const parentStep = store.createStep({ runId: parent.id, stepIndex: 0, name: "child", kind: "pipeline", input: {} });
  const value = { apiKey: secret, [secret]: "safe" };
  const child = store.createRun({ definitionId: "synthetic", name: "child", scope: "shared", input: value }); store.composition.pin(child.id, definition, {});
  store.composition.link({ parentRunId: parent.id, parentStepId: parentStep.id, childRunId: child.id, deadline: Date.now() + 1000 });
  store.createStep({ runId: child.id, stepIndex: 0, name: "safe", kind: "code", input: value, metadata: { display: definition.spec.steps[0]!.display } });
  store = new PipelineStore(store.path);
  for (const run of [parent, child]) expect(JSON.stringify(viewerSnapshot(run.id, store, "synthetic-service"))).not.toContain(secret);
  expect(store.composition.snapshot(parent.id)!.definition).toEqual(parentPin.definition);
  expect(store.composition.snapshot(parent.id)!.hash).toBe(parentPin.hash);
});

test("retired redacted sources refuse changed or unproven legacy selectors atomically", () => {
  const secret = "synthetic-retired-selector"; store.evidence.registerSecret(secret);
  const run = store.createRun({ definitionId: "synthetic", name: "synthetic", scope: "shared", input: {} });
  const value = { [secret]: "safe" };
  const step = store.createStep({ runId: run.id, stepIndex: 0, name: "safe", kind: "code", input: value,
    metadata: { display: { in: [{ path: `$.${secret}` }], out: [{ path: `$.${secret}` }] } } });
  const before = store.evidence.list(run.id);
  const db = new Database(store.path);
  const originalMetadata = store.getStep(step.id)!.metadata;
  for (const retainMarker of [false, true]) {
    const metadata = { ...originalMetadata, display: { out: [{ path: `$.${secret}` }] } };
    if (!retainMarker) delete metadata.previewCaptureMetadata;
    db.query("UPDATE pipeline_steps SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), step.id);
    store = new PipelineStore(store.path);
    expect(() => store.evidence.capture({ runId: run.id, stepId: step.id, kind: "returned_output", scope: "unsafe-legacy-alias", value })).toThrow("sanitized display provenance");
    expect(store.evidence.list(run.id)).toEqual(before);
  }
  db.close();
});

test("new aliases after credential retirement cannot attest themselves or retain unsafe step metadata", () => {
  const secret = "synthetic-new-alias-retired-selector"; store.evidence.registerSecret(secret);
  const run = store.createRun({ definitionId: "synthetic", name: "synthetic", scope: "shared", input: {} });
  const value = { [secret]: "safe" };
  const metadata = { display: { in: [{ path: `$.${secret}` }], out: [{ path: `$.${secret}` }] } };
  const first = store.createStep({ runId: run.id, stepIndex: 0, name: "first", kind: "code", input: value, metadata });
  // While the provider context is still available, a new named boundary may share the exact safe body.
  store.createStep({ runId: run.id, stepIndex: 1, name: "active-alias", kind: "code", input: value, metadata });
  const count = store.listSteps(run.id).length;
  store = new PipelineStore(store.path);
  expect(() => store.createStep({ runId: run.id, stepIndex: 2, name: "unsafe-retired-alias", kind: "code", input: value, metadata })).toThrow("sanitized display provenance");
  expect(store.listSteps(run.id)).toHaveLength(count);
  expect(store.listEvents(run.id).some(event => event.message === "unsafe-retired-alias")).toBe(false);
  expect(JSON.stringify(store.listStepSummaries(run.id))).not.toContain(secret);
  // Provisional metadata from unrelated input cannot authorize a later retired source either.
  const different = store.createStep({ runId: run.id, stepIndex: 2, name: "different-input", kind: "code", input: {}, metadata });
  expect(() => store.completeStep({ id: different.id, status: "ok", output: value, result: {} })).toThrow("sanitized display provenance");
  expect(store.getStep(different.id)!.status).toBe("running");
  const safe = store.evidence.capture({ runId: run.id, stepId: first.id, kind: "returned_output", scope: "verified-retired-alias", value });
  expect(JSON.stringify(safe)).not.toContain(secret);
});

test("late child discovery quarantines actual parent and child projections with atomic rollback", async () => {
  const secret = "synthetic-late-child-preview-credential";
  const definition = { id: "synthetic", name: "synthetic", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "synthetic", steps: [{ id: "emit", name: "emit", type: "code", function: "emit", display: { in: [{ label: "Value", path: `$.${secret}` }] } }] } } as PipelineDefinitionRecord;
  let releaseParent!: (value: Record<string, unknown>) => void;
  let releaseChild!: (value: Record<string, unknown>) => void;
  let enteredParent!: () => void; let enteredChild!: () => void;
  const parentEntered = new Promise<void>(resolve => { enteredParent = resolve; });
  const childEntered = new Promise<void>(resolve => { enteredChild = resolve; });
  const start = (registry: Record<string, (value: unknown) => Promise<Record<string, unknown>>>, onRunCreated?: (run: { id: string }) => void) => runDeclarativePipeline({ store, definition, registry, onRunCreated,
    input: { message: "x".repeat(1000) + secret }, ownerNpub: null, ownerAlias: null, callbackOrigin: "http://localhost", sessionApiContext: {} as never });
  const parentPromise = start({ emit: () => new Promise(resolve => { releaseParent = resolve; enteredParent(); }) });
  await parentEntered;
  const parent = store.listRuns()[0]!; const parentStep = store.listSteps(parent.id)[0]!;
  const childPromise = start({ emit: () => new Promise(resolve => { releaseChild = resolve; enteredChild(); }) }, child => {
    store.composition.link({ parentRunId: parent.id, parentStepId: parentStep.id, childRunId: child.id, deadline: Date.now() + 10000 });
  });
  await childEntered;
  const child = store.listRuns().find(run => run.id !== parent.id)!; const childStep = store.listSteps(child.id)[0]!;
  const db = new Database(store.path);
  const before = store.composition.snapshot(parent.id)!;
  const records = () => JSON.stringify(Object.fromEntries(["pipeline_steps", "pipeline_run_snapshots", "pipeline_evidence", "pipeline_evidence_payloads", "pipeline_events"]
    .map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const beforeRecords = records();
  db.run("CREATE TRIGGER reject_late_output BEFORE INSERT ON pipeline_evidence WHEN NEW.kind = 'returned_output' BEGIN SELECT RAISE(ABORT, 'synthetic capture rejection'); END");
  expect(() => store.evidence.capture({ runId: child.id, stepId: childStep.id, kind: "returned_output", scope: "rollback", value: { apiKey: secret } })).toThrow("synthetic capture rejection");
  expect(store.composition.snapshot(parent.id)).toEqual(before);
  expect(records()).toBe(beforeRecords);
  expect(() => viewerSnapshot(parent.id, store, "synthetic")).not.toThrow();
  db.run("DROP TRIGGER reject_late_output"); db.close();
  releaseChild({ apiKey: secret }); expect((await childPromise).status).toBe("ok");
  releaseParent({}); expect((await parentPromise).status).toBe("ok");
  store = new PipelineStore(store.path); store.compactCompletedRunPayloads({});
  for (const run of [parent, child]) {
    expect(() => viewerSnapshot(run.id, store, "synthetic")).toThrow("pipeline-viewer-evidence-redaction-review-required");
    expect(store.evidence.list(run.id).some(ref => ref.kind === "resolved_input")).toBe(true);
  }
});

for (const mismatch of ["owner", "alias", "parent-step"]) test(`foreign ${mismatch} descendants cannot influence root refusal or viewer pins`, () => {
  const secret = "synthetic-foreign-history-credential";
  const definition = { id: "synthetic", name: "safe", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "safe", steps: [] } } as PipelineDefinitionRecord;
  const root = store.createRun({ definitionId: "synthetic", name: "safe", scope: "shared", ownerNpub: "owner-A", ownerAlias: "alias-A", input: {} });
  const foreign = store.createRun({ definitionId: "synthetic", name: "safe", scope: "shared",
    ownerNpub: mismatch === "owner" ? "owner-B" : "owner-A", ownerAlias: mismatch === "alias" ? "alias-B" : "alias-A", input: {} });
  for (const run of [root, foreign]) store.composition.pin(run.id, definition, {});
  const step = store.createStep({ runId: root.id, stepIndex: 0, name: "safe", kind: "code", input: {} });
  const foreignStep = store.createStep({ runId: foreign.id, stepIndex: 0, name: "foreign", kind: "code", input: { message: "x".repeat(1000) + secret },
    metadata: { display: { in: [{ label: "Value", path: `$.${secret}` }] } } });
  store.composition.link({ parentRunId: root.id, parentStepId: mismatch === "parent-step" ? foreignStep.id : step.id, childRunId: foreign.id, deadline: Date.now() + 10000 });
  const before = store.composition.snapshot(foreign.id);
  store.completeStep({ id: step.id, status: "ok", output: { apiKey: secret }, result: {} });
  expect(store.composition.snapshot(root.id)!.context.viewerEvidenceUnsafe).toBeUndefined();
  expect(store.composition.snapshot(foreign.id)).toEqual(before);
  expect(() => store.evidence.assertViewerSafe(root.id)).not.toThrow();
  expect(() => store.evidence.assertViewerSafe(foreign.id)).toThrow("composition authority mismatch");
});

test("actual retained shared bodies bound credential verification work without hydration or duplicate counting", async () => {
  const definition = { id: "synthetic", name: "safe", scope: "shared", path: "/synthetic.json", ownerAlias: null,
    spec: { name: "safe", steps: [{ name: "echo", type: "code", function: "echo" }] } } as PipelineDefinitionRecord;
  const run = await runDeclarativePipeline({ store, definition, registry: { echo: input => input },
    input: { message: "x".repeat(1024 * 1024) }, ownerNpub: null, ownerAlias: null, callbackOrigin: "http://localhost", sessionApiContext: {} as never });
  expect(run.status).toBe("ok");
  const db = new Database(store.path);
  const size = db.query("SELECT sum(bytes) AS bytes, count(*) AS count FROM pipeline_evidence_payloads WHERE root_run_id = ?").get(run.id) as { bytes: number; count: number };
  expect(size.count).toBe(2); expect(store.evidence.list(run.id)).toHaveLength(4);
  expect(retainedCredentialExposure(db, run.id, ["absent-credential"], size.bytes)).toBe(false);
  expect(retainedCredentialExposure(db, run.id, ["absent-credential"], size.bytes - 1)).toBe(true);
  expect(retainedCredentialExposure(db, run.id, ["absent-credential", "second-absent-credential"], size.bytes)).toBe(true);
  expect(retainedCredentialExposure(db, run.id, [], 0)).toBe(false);
  // The complete readonly query returns only a scalar; application full-body reads remain lazy.
  expect(retainedCredentialExposure(db, run.id, ["x".repeat(1000)], size.bytes)).toBe(true);
  // Reproduce the additive pre-sharing layout with actual runner values, not a populated API fixture.
  db.run("DROP TRIGGER pipeline_evidence_immutable_update");
  db.query(`UPDATE pipeline_evidence SET
    value_json = replace((SELECT value_json FROM pipeline_evidence_payloads WHERE id = pipeline_evidence.payload_id), 'x', ?),
    bytes = length(CAST(replace((SELECT value_json FROM pipeline_evidence_payloads WHERE id = pipeline_evidence.payload_id), 'x', ?) AS BLOB)),
    payload_id = NULL, content_hash = NULL, source_hash = NULL WHERE run_id = ?`).run("\\u0078", "\\u0078", run.id);
  db.run("CREATE TRIGGER pipeline_evidence_immutable_update BEFORE UPDATE ON pipeline_evidence BEGIN SELECT RAISE(ABORT, 'Pipeline evidence is immutable'); END");
  const legacy = db.query("SELECT sum(bytes) AS bytes FROM pipeline_evidence WHERE run_id = ?").get(run.id) as { bytes: number };
  expect(retainedCredentialExposure(db, run.id, ["absent-credential"], legacy.bytes)).toBe(false);
  expect(retainedCredentialExposure(db, run.id, ["x".repeat(1000)], legacy.bytes)).toBe(true);
  store.evidence = new PipelineEvidenceStore(db, { runBytes: legacy.bytes - 1 });
  store.evidence.capture({ runId: run.id, stepId: store.listSteps(run.id)[0]!.id, kind: "returned_output", scope: "bounded-verification", value: { apiKey: "absent-credential" } });
  expect(() => store.evidence.assertViewerSafe(run.id)).toThrow("pipeline-viewer-evidence-redaction-review-required");
  db.close();
});
