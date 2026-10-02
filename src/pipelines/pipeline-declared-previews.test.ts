import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { declaredEvidencePreview, selectEvidenceField } from "./pipeline-declared-previews";
import { sanitizePreviewCapture } from "./pipeline-preview-metadata";
import { redactPipelineValue } from "./pipeline-evidence-redaction";
import { pipelineEvidencePreview } from "./pipeline-evidence-preview";

test("declared paths preserve late nested samples, exact null/missing and field-local truncation", () => {
  const tweets = Array.from({ length: 37 }, (_, index) => ({ id: String(index), text: `record ${index}` }));
  const value = { state: { a: 1, b: 2, c: 3, d: 4, e: 5, tweets }, nil: null, delivery: { delivered: true }, prose: "😀".repeat(2000) };
  const preview = declaredEvidencePreview(value, ["$.state.tweets", "$.nil", "$.absent", "$.delivery.delivered", "$.prose"]);
  expect(preview.fields?.["$.state.tweets"]).toEqual({ present: true, value: tweets.slice(0, 2), truncated: true, count: 37 });
  expect(preview.fields?.["$.nil"]).toEqual({ present: true, value: null, truncated: false, count: null });
  expect(preview.fields?.["$.absent"]).toEqual({ present: false, value: null, truncated: false, count: null });
  expect(preview.fields?.["$.delivery.delivered"]).toEqual({ present: true, value: true, truncated: false, count: null });
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(2048);
  expect(declaredEvidencePreview(value, [])).toEqual(pipelineEvidencePreview(value));
});

test("exact object paths reject prototype/array traversal and preserve empty/false/zero", () => {
  for (const value of [null, false, 0, "", []]) expect(selectEvidenceField({ value }, "$.value")).toEqual({ present: true, value });
  for (const path of ["$.toString", "$.records.0", "$.nil.child"]) expect(selectEvidenceField({ records: [1], nil: null }, path).present).toBe(false);
  expect(selectEvidenceField(null, "$")).toEqual({ present: true, value: null });
});

test("hostile declared path/value overhead is bounded with truthful omitted/sample states", () => {
  const value = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${index}${"\u0000".repeat(100)}`, "😀".repeat(1000)]));
  const paths = Object.keys(value).map(key => `$.${key}`);
  paths.push(`$.${"x".repeat(300)}`);
  const preview = declaredEvidencePreview(value, paths);
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(2048);
  expect(preview.truncated).toBe(true);
  expect(Object.keys(preview.fields!)).not.toHaveLength(paths.length);
  expect(Object.values(preview.fields!).every(field => field.present && field.truncated)).toBe(true);
});

test("capture metadata selects declared side only, never state assignment or executor aliases", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE pipeline_steps (id TEXT, metadata_json TEXT)");
  db.query("INSERT INTO pipeline_steps VALUES (?, ?)").run("step", JSON.stringify({ display: { in: [{ path: "$.state.tweets" }], out: [{ path: "$.message" }] }, assign: "$.response" }));
  expect(sanitizePreviewCapture(db, "step", "resolved_input", {}, null, redactPipelineValue).paths).toEqual(["$.state.tweets"]);
  expect(sanitizePreviewCapture(db, "step", "returned_output", {}, null, redactPipelineValue).paths).toEqual(["$.message"]);
  for (const kind of ["state_write", "executor_request", "side_effect_confirmation"]) expect(sanitizePreviewCapture(db, "step", kind, {}, null, redactPipelineValue).paths).toEqual([]);
  db.close();
});
