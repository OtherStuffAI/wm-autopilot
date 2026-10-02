import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "./pipeline-store";
import { PipelineEvidenceStore, type EvidenceCapture } from "./pipeline-evidence-store";
import { evidenceDigest } from "./pipeline-evidence-payloads";

let directory: string;
let store: PipelineStore;
let db: Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pipeline-sharing-"));
  store = new PipelineStore(join(directory, "runs.sqlite"));
  db = new Database(store.path);
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

function run(owner = "synthetic-owner", input = {}) {
  return store.createRun({ definitionId: "synthetic", name: "synthetic", scope: "user", ownerNpub: owner, ownerAlias: owner, input });
}
function emptyStep(runId: string, name = "synthetic") {
  return store.createStep({ runId, stepIndex: 0, name, kind: "code", status: "skipped", input: {} });
}
function capture(runId: string, stepId: string, value: unknown): EvidenceCapture {
  return { runId, stepId, value, kind: "returned_output", scope: "synthetic" };
}
function counts() {
  return db.query(`SELECT (SELECT count(*) FROM pipeline_evidence) AS refs,
    (SELECT count(*) FROM pipeline_evidence_payloads) AS bodies`).get() as { refs: number; bodies: number };
}

test("native, block and parent/child boundaries retain distinct identities with one exact body", () => {
  const value = { prompt: "  exact long prompt\n" + "synthetic ".repeat(9000),
    records: Array.from({ length: 37 }, (_, i) => ({ id: i, text: `record ${i}\nexact` })), nullable: null };
  const parent = run();
  const wrapper = store.createStep({ runId: parent.id, stepIndex: 0, name: "wrapper", kind: "pipeline", input: value });
  const block = store.createStep({ runId: parent.id, stepIndex: 1, name: "block", kind: "block", input: value });
  const native = store.createStep({ runId: parent.id, stepIndex: 2, name: "native", kind: "code", parentStepId: block.id, input: value });
  const child = run();
  store.composition.link({ parentRunId: parent.id, parentStepId: wrapper.id, childRunId: child.id, deadline: Date.now() + 1000 });
  const classifier = store.createStep({ runId: child.id, stepIndex: 0, name: "classifier", kind: "classifier", input: value });
  const agent = store.createStep({ runId: child.id, stepIndex: 1, name: "agent", kind: "agent", input: value });
  store.evidence.capture({ ...capture(child.id, classifier.id, value), kind: "executor_request", attempt: 1 });
  store.evidence.capture({ ...capture(child.id, classifier.id, value), kind: "executor_request", attempt: 2 });
  store.evidence.capture({ ...capture(child.id, agent.id, value), kind: "executor_request", attempt: 1 });
  for (const step of [wrapper, block, native, classifier, agent]) {
    store.completeStep({ id: step.id, status: "ok", output: value, result: value });
  }
  store.completeRun(child.id, "ok", value);
  store.completeRun(parent.id, "ok", value);
  const refs = [parent, child].flatMap(r => store.evidence.list(r.id));
  expect(refs).toHaveLength(18);
  expect(new Set(refs.map(ref => ref.id)).size).toBe(18);
  expect(counts()).toEqual({ refs: 18, bodies: 1 });
  const physical = db.query("SELECT bytes, length(CAST(value_json AS BLOB)) AS stored FROM pipeline_evidence_payloads").get() as { bytes: number; stored: number };
  expect(physical).toEqual({ bytes: Buffer.byteLength(JSON.stringify(value)), stored: Buffer.byteLength(JSON.stringify(value)) });
  expect(db.query("SELECT count(*) AS n FROM pipeline_evidence WHERE value_json IS NOT NULL").get()).toEqual({ n: 0 });
  const before = refs.map(ref => store.evidence.get(ref.runId, ref.id));
  expect(before.every(row => JSON.stringify(row!.value) === JSON.stringify(value))).toBe(true);
  expect(refs.filter(ref => ref.stepId === classifier.id && ref.kind !== "resolved_input").map(ref => ref.attempt)).toEqual([1, 2, 2, 2]);
  store.compactCompletedRunPayloads({});
  store = new PipelineStore(store.path);
  expect(refs.map(ref => store.evidence.get(ref.runId, ref.id))).toEqual(before);
  expect(counts()).toEqual({ refs: 18, bodies: 1 });
  expect(store.evidence.get(child.id, refs[0]!.id)).toBeNull();
  expect(() => db.run("UPDATE pipeline_evidence_payloads SET bytes = 0")).toThrow("immutable");
  expect(() => db.run("DELETE FROM pipeline_evidence_payloads")).toThrow("forbids deletion");
});

test("nullable additive migration leaves old inline-schema rows byte-for-byte readable", () => {
  const r = run(); const step = emptyStep(r.id);
  db.run("DROP TABLE pipeline_evidence");
  db.run("DROP TABLE pipeline_evidence_payloads");
  db.run(`CREATE TABLE pipeline_evidence (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL, content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL, availability TEXT NOT NULL, redacted INTEGER NOT NULL, captured_at TEXT NOT NULL, value_json TEXT)`);
  const values = [null, { records: Array.from({ length: 31 }, (_, i) => i), text: " exact\n" + "x".repeat(9000) }];
  for (const [i, value] of values.entries()) {
    const json = JSON.stringify(value);
    db.query("INSERT INTO pipeline_evidence VALUES (?, ?, ?, 1, 'returned_output', 'old-inline', 'application/json', ?, 'complete', 0, 'synthetic', ?)")
      .run(`old-${i}`, r.id, step.id, Buffer.byteLength(json), json);
  }
  const original = db.query("SELECT id, value_json FROM pipeline_evidence ORDER BY rowid").all();
  store = new PipelineStore(store.path);
  for (const [i, value] of values.entries()) expect(store.evidence.get(r.id, `old-${i}`)!.value).toEqual(value);
  expect(store.evidence.get(r.id, "absent")).toBeNull();
  expect(db.query("SELECT id, value_json FROM pipeline_evidence ORDER BY rowid").all()).toEqual(original);
  expect(db.query("SELECT payload_id, source_hash, content_hash FROM pipeline_evidence").all()).toEqual(values.map(() => ({ payload_id: null, source_hash: null, content_hash: null })));
  expect(counts().bodies).toBe(0);
  const limited = new PipelineEvidenceStore(db, { valueBytes: 10_000, runBytes: Buffer.byteLength(JSON.stringify(values[1])) + 4 });
  expect(limited.capture(capture(r.id, step.id, values[1])).availability).toBe("complete");
  const ref = store.evidence.capture(capture(r.id, step.id, values[1]));
  expect(store.evidence.get(r.id, ref.id)!.value).toEqual(values[1]);
});

test("payload and reference failures roll back capture, outer step and compaction transactions", () => {
  const r = run(); const step = emptyStep(r.id);
  db.run("CREATE TRIGGER reject_payload BEFORE INSERT ON pipeline_evidence_payloads BEGIN SELECT RAISE(ABORT, 'payload interrupted'); END");
  expect(() => store.evidence.capture(capture(r.id, step.id, { body: 1 }))).toThrow("payload interrupted");
  expect(counts()).toEqual({ refs: 0, bodies: 0 });
  db.run("DROP TRIGGER reject_payload");
  db.run("CREATE TRIGGER reject_ref BEFORE INSERT ON pipeline_evidence BEGIN SELECT RAISE(ABORT, 'reference interrupted'); END");
  expect(() => store.evidence.capture(capture(r.id, step.id, { body: 1 }))).toThrow("reference interrupted");
  expect(counts()).toEqual({ refs: 0, bodies: 0 });
  db.run("DROP TRIGGER reject_ref");
  const active = store.createStep({ runId: r.id, stepIndex: 1, name: "active", kind: "code", input: { original: true } });
  const before = counts();
  db.run("CREATE TRIGGER reject_state BEFORE INSERT ON pipeline_evidence WHEN NEW.kind = 'state_write' BEGIN SELECT RAISE(ABORT, 'state interrupted'); END");
  expect(() => store.completeStep({ id: active.id, status: "ok", output: { newBody: 1 }, result: { newBody: 1 } })).toThrow("state interrupted");
  expect(store.getStep(active.id)!.status).toBe("running");
  expect(store.getStep(active.id)!.output).toBeNull();
  expect(counts()).toEqual(before);
  db.run("DROP TRIGGER reject_state");
  db.run("UPDATE pipeline_steps SET output_json = ?, result_json = ?, status = 'ok' WHERE id = ?", [JSON.stringify({ legacy: 1 }), JSON.stringify({ legacy: 2 }), active.id]);
  store.completeRun(r.id, "ok", {});
  db.run("CREATE TRIGGER reject_compaction BEFORE INSERT ON pipeline_evidence WHEN NEW.kind = 'state_write' BEGIN SELECT RAISE(ABORT, 'compaction interrupted'); END");
  expect(() => store.compactCompletedRunPayloads({})).toThrow("compaction interrupted");
  expect(counts()).toEqual(before);
  expect(store.getStep(active.id)!.input).toEqual({ original: true });
  expect(store.getStep(active.id)!.output).toEqual({ legacy: 1 });
  expect(store.getStep(active.id)!.result).toEqual({ legacy: 2 });
});

test("per-value and per-run budgets count unique content even when another authorized run shares it", () => {
  const parent = run(); const wrapper = emptyStep(parent.id); const child = run(); const childStep = emptyStep(child.id);
  store.composition.link({ parentRunId: parent.id, parentStepId: wrapper.id, childRunId: child.id, deadline: 1 });
  const limited = new PipelineEvidenceStore(db, { valueBytes: 25, runBytes: 30 });
  const first = limited.capture(capture(parent.id, wrapper.id, "x".repeat(20)));
  const repeat = limited.capture({ ...capture(parent.id, wrapper.id, "x".repeat(20)), kind: "state_write" });
  expect([first.availability, repeat.availability]).toEqual(["complete", "complete"]);
  const childFirst = limited.capture(capture(child.id, childStep.id, "y".repeat(15)));
  expect(childFirst.availability).toBe("complete");
  const childRepeat = limited.capture(capture(child.id, childStep.id, "x".repeat(20)));
  expect(childRepeat.availability).toBe("oversized");
  const excess = limited.capture(capture(parent.id, wrapper.id, "z".repeat(26)));
  expect(excess.availability).toBe("oversized");
  expect(limited.get(parent.id, excess.id)!.value).toBeNull();
  expect(counts().bodies).toBe(2);
  expect(db.query("SELECT payload_id, value_json FROM pipeline_evidence WHERE availability = 'oversized'").all()).toEqual([
    { payload_id: null, value_json: null }, { payload_id: null, value_json: null }]);
  const defaults = new PipelineEvidenceStore(db);
  expect(defaults.valueLimit).toBe(16 * 1024 * 1024); expect(defaults.runLimit).toBe(128 * 1024 * 1024);
});

test("unrelated roots and owners never share bodies, provenance or budget", () => {
  const secret = "synthetic-retired-sharing-secret";
  const first = run("owner-one", { workspaceId: "untrusted" }); const a = emptyStep(first.id);
  store.evidence.registerSecret(secret);
  const redacted = store.evidence.capture(capture(first.id, a.id, { prose: secret }));
  store = new PipelineStore(store.path);
  const refs = [redacted];
  for (const owner of ["owner-one", "owner-two"]) {
    const r = run(owner, { workspaceId: "untrusted", parentRunId: first.id }); const s = emptyStep(r.id);
    const ref = store.evidence.capture(capture(r.id, s.id, { prose: secret }));
    expect(ref.redacted).toBe(false); expect(store.evidence.get(r.id, ref.id)!.value).toEqual({ prose: secret }); refs.push(ref);
  }
  expect(counts().bodies).toBe(3);
  expect(new Set(db.query("SELECT root_run_id FROM pipeline_evidence_payloads").all().map(row => (row as { root_run_id: string }).root_run_id)).size).toBe(3);
  expect(store.evidence.get(first.id, refs[1]!.id)).toBeNull();
  const foreign = run("owner-two"); const f = emptyStep(foreign.id);
  store.composition.link({ parentRunId: first.id, parentStepId: a.id, childRunId: foreign.id, deadline: 1 });
  expect(() => store.evidence.capture(capture(foreign.id, f.id, { safe: true }))).toThrow("authority mismatch");
  expect(() => store.evidence.capture(capture(first.id, f.id, null))).toThrow("step/run mismatch");
});

test("retired source provenance protects new wrapper and child aliases without storing secrets", () => {
  const secret = "synthetic-retired-source"; store.evidence.registerSecret(secret);
  const parent = run(); const native = emptyStep(parent.id); const wrapper = emptyStep(parent.id);
  const child = run(); const childStep = emptyStep(child.id);
  store.composition.link({ parentRunId: parent.id, parentStepId: wrapper.id, childRunId: child.id, deadline: 1 });
  const value = { text: "before\n" + secret + "\nafter", collection: Array.from({ length: 35 }, (_, i) => i) };
  const original = store.evidence.capture(capture(child.id, childStep.id, value));
  store = new PipelineStore(store.path);
  for (const step of [native, wrapper, childStep]) {
    const alias = store.evidence.capture({ ...capture(step.runId, step.id, value), kind: "state_write" });
    expect(alias.redacted).toBe(true); expect(alias.availability).toBe("redacted");
    expect(store.evidence.get(step.runId, alias.id)!.value).toEqual(store.evidence.get(child.id, original.id)!.value);
    expect(JSON.stringify(alias.preview)).not.toContain(secret);
  }
  expect(counts()).toEqual({ refs: 4, bodies: 1 });
  expect(JSON.stringify(db.query("SELECT * FROM pipeline_evidence_payloads").all())).not.toContain(secret);
  expect(db.query("SELECT DISTINCT source_hash FROM pipeline_evidence").all()).toEqual([{ source_hash: evidenceDigest(JSON.stringify(value)) }]);
  db.run("DROP TRIGGER pipeline_evidence_immutable_update");
  db.run("UPDATE pipeline_evidence SET source_hash = NULL WHERE id = ?", [original.id]);
  expect(() => store.evidence.capture(capture(child.id, childStep.id, value))).toThrow("lacks exact source provenance");
  expect(() => store.evidence.ensureArchived(capture(child.id, childStep.id, value))).toThrow("lacks exact source provenance");
  const newWrapper = emptyStep(parent.id);
  expect(() => store.evidence.capture(capture(parent.id, newWrapper.id, value))).toThrow("lacks exact source provenance");
});

test("missing or corrupt payloads cannot read as null or authorize compaction", () => {
  const r = run();
  const step = store.createStep({ runId: r.id, stepIndex: 0, name: "active", kind: "code", input: { text: "retained" } });
  store.completeRun(r.id, "ok", {});
  const ref = store.evidence.list(r.id)[0]!;
  db.run("DROP TRIGGER pipeline_evidence_payloads_immutable_delete");
  db.run("DELETE FROM pipeline_evidence_payloads");
  expect(() => store.evidence.get(r.id, ref.id)).toThrow("Missing shared");
  expect(() => store.compactCompletedRunPayloads({})).toThrow("Missing shared");
  expect(store.getStep(step.id)!.input).toEqual({ text: "retained" });
  const payloadId = (db.query("SELECT payload_id FROM pipeline_evidence WHERE id = ?").get(ref.id) as { payload_id: string }).payload_id;
  db.query("INSERT INTO pipeline_evidence_payloads VALUES (?, ?, ?, ?, ?)").run(payloadId, r.id, evidenceDigest(JSON.stringify({ text: "retained" })), ref.bytes, JSON.stringify({ text: "corrupted" }));
  expect(() => store.evidence.get(r.id, ref.id)).toThrow("digest or size mismatch");
  expect(() => store.evidence.capture(capture(r.id, step.id, { text: "retained" }))).toThrow("digest or size mismatch");
});

test("content digest collisions fail rather than alias inconsistent immutable bytes", () => {
  const r = run(); const step = emptyStep(r.id);
  store.evidence.capture(capture(r.id, step.id, { apiKey: "synthetic-one" }));
  db.run("DROP TRIGGER pipeline_evidence_payloads_immutable_update");
  db.run("UPDATE pipeline_evidence_payloads SET value_json = ?", [JSON.stringify({ apiKey: "wrong-body" })]);
  expect(() => store.evidence.capture(capture(r.id, step.id, { apiKey: "synthetic-two" }))).toThrow("digest collision or inconsistent body");
  expect(counts()).toEqual({ refs: 1, bodies: 1 });
});

test("inconsistent source digests and cyclic composition fail explicitly", () => {
  const r = run(); const step = emptyStep(r.id);
  const ref = store.evidence.capture(capture(r.id, step.id, { original: true }));
  db.run("DROP TRIGGER pipeline_evidence_immutable_update");
  db.run("UPDATE pipeline_evidence SET source_hash = ? WHERE id = ?", [evidenceDigest(JSON.stringify({ different: true })), ref.id]);
  expect(() => store.evidence.capture(capture(r.id, step.id, { different: true }))).toThrow("digest or size mismatch");
  const child = run(); const c = emptyStep(child.id);
  store.composition.link({ parentRunId: r.id, parentStepId: step.id, childRunId: child.id, deadline: 1 });
  store.composition.link({ parentRunId: child.id, parentStepId: c.id, childRunId: r.id, deadline: 1 });
  expect(() => store.evidence.capture(capture(r.id, step.id, null))).toThrow("composition cycle");
});

test("unrelated corrupt provenance cannot affect another owner's capture or budget", () => {
  const foreign = run("foreign-owner"); const foreignStep = emptyStep(foreign.id);
  const value = { text: "synthetic-common-content" };
  const ref = store.evidence.capture(capture(foreign.id, foreignStep.id, value));
  db.run("DROP TRIGGER pipeline_evidence_immutable_update");
  db.run("UPDATE pipeline_evidence SET redacted = 1, source_hash = NULL WHERE id = ?", [ref.id]);
  store.composition.link({ parentRunId: foreign.id, parentStepId: foreignStep.id, childRunId: foreign.id, deadline: 1 });
  const own = run("own-owner"); const ownStep = emptyStep(own.id);
  const limited = new PipelineEvidenceStore(db, { valueBytes: 100, runBytes: Buffer.byteLength(JSON.stringify(value)) });
  const retained = limited.capture(capture(own.id, ownStep.id, value));
  expect(retained.availability).toBe("complete"); expect(retained.redacted).toBe(false);
  expect(limited.get(own.id, retained.id)!.value).toEqual(value);
  expect(limited.capture(capture(own.id, ownStep.id, { different: true })).availability).toBe("oversized");
});
