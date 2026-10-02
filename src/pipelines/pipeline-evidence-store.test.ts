import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "./pipeline-store";
import { PipelineEvidenceStore } from "./pipeline-evidence-store";
import { redactPipelineValue } from "./pipeline-evidence-redaction";

let dir: string; let store: PipelineStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pipeline-evidence-")); store = new PipelineStore(join(dir, "runs.sqlite")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const run = store.createRun({ name: "synthetic", definitionId: "synthetic", scope: "shared", input: {} });
  const text = "  Exact long request\n" + "x".repeat(80_000) + "\n end  ";
  const tweets = Array.from({ length: 35 }, (_, index) => ({ id: String(index + 1), text: `exact tweet ${index}` }));
  const step = store.createStep({ runId: run.id, stepIndex: 0, name: "retrieve", kind: "code", input: { text }, callbackToken: "synthetic-callback-secret" });
  return { run, step, text, tweets };
}
test("full exact values survive compaction and reopening; immutable and no expiry", () => {
  const { run, step, text, tweets } = fixture();
  store.completeStep({ id: step.id, status: "ok", output: { tweets }, result: { tweets } });
  store.completeRun(run.id, "ok", { tweets });
  const refs = store.evidence.list(run.id);
  const before = refs.map(ref => store.evidence.get(run.id, ref.id));
  store.compactCompletedRunPayloads({});
  expect(store.getStep(step.id)!.input).toEqual({});
  expect(refs.map(ref => store.evidence.get(run.id, ref.id))).toEqual(before);
  expect(store.evidence.get(run.id, refs.find(ref => ref.kind === "resolved_input")!.id)!.value).toEqual({ text });
  store = new PipelineStore(join(dir, "runs.sqlite"));
  expect(store.evidence.get(run.id, refs.find(ref => ref.kind === "returned_output")!.id)!.value).toEqual({ tweets });
  expect(refs.every(ref => ref.expiresAt === null)).toBe(true);
  const db = new Database(store.path);
  expect(() => db.run("DELETE FROM pipeline_evidence")).toThrow("forbids deletion");
  expect(() => db.run("UPDATE pipeline_evidence SET scope='changed'")).toThrow("immutable"); db.close();
});
test("archive failure rolls back compaction and retains inline legacy values", () => {
  const { run, step, tweets } = fixture();
  store.completeStep({ id: step.id, status: "ok", output: { tweets }, result: { tweets } }); store.completeRun(run.id, "ok", {});
  const db = new Database(store.path);
  // Force missing archive kinds, as in a pre-migration step, then reject archival writes.
  db.run("DROP TRIGGER pipeline_evidence_immutable_delete"); db.run("DELETE FROM pipeline_evidence");
  db.run("CREATE TRIGGER fail_archive BEFORE INSERT ON pipeline_evidence BEGIN SELECT RAISE(ABORT, 'synthetic archive failure'); END");
  expect(() => store.compactCompletedRunPayloads({})).toThrow("synthetic archive failure");
  expect(store.getStep(step.id)!.output).toEqual({ tweets }); expect(store.getStep(step.id)!.input.text).toBeString(); db.close();
});
test("limits explicitly mark oversized rather than truncate complete content", () => {
  const { run, step } = fixture(); const db = new Database(store.path);
  const evidence = new PipelineEvidenceStore(db, { valueBytes: 20, runBytes: 100 });
  const ref = evidence.capture({ runId: run.id, stepId: step.id, kind: "executor_request", scope: "test", value: "x".repeat(40) });
  expect(ref.availability).toBe("oversized"); expect(evidence.get(run.id, ref.id)!.value).toBeNull(); db.close();
});
test("credential fields, callback values, headers and private keys redact, user text stays exact", () => {
  const text = "  exact \n ordinary text about tokens and passwords  ";
  const result = redactPipelineValue({ text, apiKey: "secret", headers: { authorization: "Bearer a", "proxy-authorization": "proxysecret", cookie: "session=b", "set-cookie": "cookiesecret" }, token: "tokensecret",
    prompt: "callback: synthetic-token nsec1secret123", nested: { private_key: "private" } }, ["synthetic-token"]);
  expect(JSON.stringify(result.value)).not.toContain("proxysecret");
  expect(JSON.stringify(result.value)).not.toContain("cookiesecret");
  expect(JSON.stringify(result.value)).not.toContain("tokensecret");
  expect(result.redacted).toBe(true); expect((result.value as { text: string }).text).toBe(text);
  expect(JSON.stringify(result.value)).not.toContain("synthetic-token"); expect(JSON.stringify(result.value)).not.toContain("nsec1secret123");
  expect((result.value as { apiKey: string }).apiKey).toBe("[REDACTED]");
});

test("archive matches each exact inline version and repeat compaction adds no evidence", () => {
  const { run, step } = fixture();
  store.completeStep({ id: step.id, status: "ok", output: { version: 1 }, result: { version: 1 } });
  const db = new Database(store.path);
  db.run(`UPDATE pipeline_steps SET output_json = '{"version":2}', result_json = '{"version":2}' WHERE id = ?`, [step.id]);
  store.completeRun(run.id, "ok", {}); store.compactCompletedRunPayloads({});
  expect(store.evidence.list(run.id).filter(ref => ref.kind === "returned_output").map(ref => store.evidence.get(run.id, ref.id)!.value)).toContainEqual({ version: 2 });
  const count = store.evidence.list(run.id).length;
  store.compactCompletedRunPayloads({}); expect(store.evidence.list(run.id)).toHaveLength(count); db.close();
});

test("caller preview status cannot bypass byte limits; over-budget inline is retained", () => {
  const { run, step, text } = fixture();
  const db = new Database(store.path);
  const limited = new PipelineEvidenceStore(db, { valueBytes: 30, runBytes: 60 });
  const ref = limited.capture({ runId: run.id, stepId: step.id, kind: "returned_output", scope: "test", value: text, availability: "preview_only" });
  expect(ref.availability).toBe("oversized"); expect(limited.get(run.id, ref.id)!.value).toBeNull();
  // A missing full archive that exceeds the actual store ceiling must not erase inline copies.
  db.run("DROP TRIGGER pipeline_evidence_immutable_delete"); db.run("DELETE FROM pipeline_evidence");
  const large = "😀".repeat(4_200_000);
  db.run("UPDATE pipeline_steps SET input_json = ? WHERE id = ?", [JSON.stringify({ large }), step.id]);
  store.completeRun(run.id, "ok", {}); const result = store.compactCompletedRunPayloads({});
  expect(result.compactedSteps).toBe(0); expect(store.getStep(step.id)!.input.large).toBe(large);
  expect(store.evidence.list(run.id)[0]!.availability).toBe("oversized"); db.close();
});
