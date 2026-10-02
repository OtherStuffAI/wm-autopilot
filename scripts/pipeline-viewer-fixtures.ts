import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { installationIdForIdentity } from "../src/control-plane/connect-package";
import { PipelineStore } from "../src/pipelines/pipeline-store";
import { viewerDefinition, viewerRunSummary, viewerSnapshot } from "../src/pipelines/pipeline-viewer-dto";
import { buildPipelineStepMetadata } from "../src/pipelines/pipeline-step-metadata";
import type { DeclarativePipeline } from "../src/pipelines/declarative";
import type { PipelineDefinitionRecord } from "../src/pipelines/pipeline-loader";
import chatSpec from "../src/pipelines/default-definitions/bird.timeline.chat.v2.json";
import retrieveSpec from "../src/pipelines/default-definitions/bird.retrieve.v2.json";

const directory = mkdtempSync(join(tmpdir(), "pipeline-viewer-fixture-"));
const target = new URL("../docs/fixtures/pipeline-viewer/", import.meta.url).pathname;
mkdirSync(target, { recursive: true });
const store = new PipelineStore(join(directory, "fixtures.sqlite"));
const serviceId = installationIdForIdentity({ pubkeyHex: "33".repeat(32) });
const envelope = { version: 1, serviceId };
const definition = (spec: unknown): PipelineDefinitionRecord => ({ id: (spec as { name: string }).name, slug: (spec as { name: string }).name,
  name: (spec as { name: string }).name, scope: "shared", ownerAlias: null, path: "synthetic.json", spec: spec as DeclarativePipeline });
const chat = definition(chatSpec); const retrieve = definition(retrieveSpec);
const save = (name: string, value: unknown) => writeFileSync(join(target, name), JSON.stringify(value, null, 2) + "\n");
const prompt = "Retrieve 35 tweets from my Following feed.\n" + "Synthetic long request for exact-copy inspection.\n".repeat(600);
const tweets = Array.from({ length: 35 }, (_, index) => ({ id: String(1000 + index), text: `Synthetic exact tweet ${index + 1}\nSecond line.`,
  author: { username: "example", name: "Example" }, url: `https://x.com/example/status/${1000 + index}` }));
const started = performance.now();
const run = store.createRun({ definitionId: chat.id, name: chat.name, scope: "shared", ownerNpub: "synthetic-owner", input: { prompt } });
store.composition.pin(run.id, chat, { initiatingAgentProfileId: "synthetic-agent", initiatingAgentNpub: "synthetic-bot" });
for (const [index, step] of chat.spec.steps.entries()) {
  const record = store.createStep({ runId: run.id, stepIndex: index, name: step.name, kind: step.type,
    logicalKey: step.id ?? step.name, input: index < 2 ? { request: prompt } : { tweets }, metadata: buildPipelineStepMetadata(step) });
  const output = index === 0 ? { prompt } : index === 1 ? { retrieval: { verdict: "complete", reason: "requested_count_reached", tweets } }
    : index === 2 ? { message: tweets.map(tweet => `${tweet.text}\n${tweet.url}`).join("\n\n") }
    : { delivered: true, messageId: "synthetic-message", threadId: "synthetic-thread" };
  if (index === 1) {
    const child = store.createRun({ definitionId: retrieve.id, name: retrieve.name, scope: "shared", ownerNpub: "synthetic-owner", input: { request: prompt } });
    store.composition.pin(child.id, retrieve, {});
    store.composition.link({ parentRunId: run.id, parentStepId: record.id, childRunId: child.id, deadline: Date.now() + 75_000 });
    const loop = retrieve.spec.steps[1]!;
    const loopRecord = store.createStep({ runId: child.id, stepIndex: 0, name: loop.name, kind: "loop", logicalKey: loop.id, input: {}, metadata: buildPipelineStepMetadata(loop) });
    if (loop.type === "loop") for (const [i, stage] of (loop.steps ?? []).entries()) {
      const active = stage.name === "choose" || stage.name === "execute";
      const node = store.createStep({ runId: child.id, stepIndex: i + 1, name: `${loop.name} #1 / ${stage.name}`, kind: stage.type,
        logicalKey: `${loop.id}/${stage.id}`, parentStepId: loopRecord.id, input: { request: prompt }, metadata: buildPipelineStepMetadata(stage) });
      if (stage.type === "classifier" && active) store.evidence.capture({ runId: child.id, stepId: node.id, kind: "executor_request",
        scope: "assembled_model_request", value: { model: "synthetic-model", state: { request: prompt }, questions: stage.questions } });
      store.completeStep({ id: node.id, status: active ? "ok" : "skipped", result: {}, output: active ? { verdict: "complete", reason: "requested_count_reached", tweets } : undefined });
    }
    store.completeStep({ id: loopRecord.id, status: "ok", result: {}, output: { iterations: 3 } });
    store.completeRun(child.id, "ok", { retrieval: { verdict: "complete", tweets } });
    save("child-run.json", { ...envelope, ...viewerSnapshot(child.id, store, serviceId) });
  }
  if (index === 3) store.evidence.capture({ runId: run.id, stepId: record.id, kind: "side_effect_confirmation", scope: "delivery_adapter_confirmation", value: output });
  store.completeStep({ id: record.id, status: "ok", output, result: output });
}
store.completeRun(run.id, "ok", {});
const captureMs = performance.now() - started;
store.compactCompletedRunPayloads({});
const readStart = performance.now();
const retrieveStep = store.listSteps(run.id).find(step => step.name === "retrieve")!;
const arrayRef = store.evidence.capture({ runId: run.id, stepId: retrieveStep.id, kind: "returned_output", scope: "synthetic_record_collection", value: tweets });
const snapshot = viewerSnapshot(run.id, store, serviceId);
save("definitions.json", { ...envelope, definitions: [viewerDefinition(chat), viewerDefinition(retrieve)], nextCursor: null });
save("completed-run.json", { ...envelope, ...snapshot });
save("runs.json", { ...envelope, runs: [viewerRunSummary(run, store, serviceId)], nextCursor: null });
save("unchanged-updates.json", { ...envelope, ...snapshot, unchanged: true });
for (const kind of ["resolved_input", "side_effect_confirmation"] as const) {
  const ref = store.evidence.list(run.id).find(ref => ref.kind === kind)!;
  save(`${kind}.json`, { ...envelope, ...store.evidence.get(run.id, ref.id), nextOffset: null });
}
save("tweets-page-1.json", { ...envelope, evidence: arrayRef, value: tweets.slice(0, 20), nextOffset: 20 });
save("tweets-page-2.json", { ...envelope, evidence: arrayRef, value: tweets.slice(20), nextOffset: null });
const readMs = performance.now() - readStart;
const refs = store.composition.tree(run.id).flatMap(id => store.evidence.list(id));
const evidenceReadStart = performance.now();
for (const ref of refs) store.evidence.get(ref.runId, ref.id);
const lazyValueReadMs = performance.now() - evidenceReadStart;
const checkpoint = new Database(store.path);
checkpoint.run("PRAGMA wal_checkpoint(TRUNCATE)"); checkpoint.close();
const metrics = { fixture: "synthetic 35 tweets and long request", captureMs: Math.round(captureMs * 100) / 100,
  readAndWriteFixtureMs: Math.round(readMs * 100) / 100, evidenceRecords: refs.length, redactedJsonBytes: refs.reduce((sum, ref) => sum + ref.bytes, 0),
  previewJsonBytes: refs.reduce((sum, ref) => sum + Buffer.byteLength(JSON.stringify(ref.preview ?? null)), 0),
  lazyValueReadMs: Math.round(lazyValueReadMs * 100) / 100, sqliteBytes: statSync(store.path).size, walBytes: statSync(`${store.path}-wal`).size };
save("measurements.json", metrics);
rmSync(directory, { recursive: true, force: true });
process.stdout.write(JSON.stringify(metrics) + "\n");
