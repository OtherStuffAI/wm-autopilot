import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "./pipeline-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-pipeline-store-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const makeStore = () => new PipelineStore(join(tempDir, "pipelines.sqlite"));

describe("PipelineStore run summaries", () => {
  test("persists step metadata with full step records and summaries", () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition-1",
      name: "metadata run",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { value: 1 },
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "normalise",
      kind: "code",
      input: { text: "hello" },
      metadata: {
        type: "code",
        input: { pick: { text: "$.text" } },
        assign: "$.normalised",
        executor: { kind: "function", function: "text.normalise" },
      },
    });

    expect(store.getStep(step.id)?.metadata).toEqual({
      type: "code",
      input: { pick: { text: "$.text" } },
      assign: "$.normalised",
      executor: { kind: "function", function: "text.normalise" },
    });
    expect(store.listStepSummaries(run.id)[0]?.metadata).toMatchObject({
      assign: "$.normalised",
      executor: { function: "text.normalise" },
    });
  });

  test("records compact step events instead of duplicating payloads", () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition-1",
      name: "compact events",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { value: 1 },
    });
    const largeInput = { text: "x".repeat(4096) };
    const largeResult = { report: "y".repeat(8192) };
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "large-step",
      kind: "code",
      input: largeInput,
      metadata: { assign: "$.report" },
    });
    store.completeStep({ id: step.id, status: "ok", result: largeResult, output: { report: "done" } });

    const events = store.listEventsForStep(step.id);
    const started = events.find((event) => event.type === "step_started");
    const completed = events.find((event) => event.type === "step_completed");
    const startedData = JSON.parse(String(started?.data_json ?? "{}")) as Record<string, unknown>;
    const completedData = JSON.parse(String(completed?.data_json ?? "{}")) as Record<string, unknown>;

    expect(String(started?.data_json ?? "").length).toBeLessThan(512);
    expect(String(completed?.data_json ?? "").length).toBeLessThan(512);
    expect(startedData).toMatchObject({
      storage: "compact",
      phase: "started",
      assign: "$.report",
    });
    expect(Number(startedData.inputBytes)).toBeGreaterThan(4096);
    expect(completedData).toMatchObject({
      storage: "compact",
      phase: "completed",
      status: "ok",
      assign: "$.report",
    });
    expect(Number(completedData.resultBytes)).toBeGreaterThan(8192);
  });

  test("compacts completed step and event payloads while preserving running payloads", () => {
    const store = makeStore();
    const completed = store.createRun({
      definitionId: "definition-1",
      name: "completed",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { value: 1 },
    });
    const completedStep = store.createStep({
      runId: completed.id,
      stepIndex: 0,
      name: "completed-step",
      kind: "code",
      input: { text: "x".repeat(1024) },
    });
    store.completeStep({ id: completedStep.id, status: "ok", result: { text: "y".repeat(1024) } });
    store.completeRun(completed.id, "ok", { done: true });

    const running = store.createRun({
      definitionId: "definition-1",
      name: "running",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { value: 2 },
    });
    const runningStep = store.createStep({
      runId: running.id,
      stepIndex: 0,
      name: "running-step",
      kind: "code",
      input: { text: "z".repeat(1024) },
    });

    const dryRun = store.compactCompletedRunPayloads({ ownerNpub: "npub-owner", dryRun: true });
    const result = store.compactCompletedRunPayloads({ ownerNpub: "npub-owner" });

    expect(dryRun).toEqual({ matchedRuns: 1, compactedSteps: 1, compactedEvents: 2 });
    expect(result).toEqual({ matchedRuns: 1, compactedSteps: 1, compactedEvents: 2 });
    expect(store.getStep(completedStep.id)?.input).toEqual({});
    expect(store.getStep(completedStep.id)?.result).toBeNull();
    expect(store.getStep(completedStep.id)?.metadata?.compactedDisplay).toMatchObject({
      in: [{ name: "text", inspectValue: "x".repeat(1024) }],
      out: [{ name: "text", inspectValue: "y".repeat(1024) }],
    });
    expect(store.listEventsForStep(completedStep.id).map((event) => event.data_json)).toEqual(["{}", "{}"]);
    expect(store.getRun(completed.id)?.result).toEqual({ done: true });
    expect(store.getStep(runningStep.id)?.input).toEqual({ text: "z".repeat(1024) });
  });

  test("lists run metadata and payload sizes without decoded run payloads", () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition-1",
      definitionPath: join(tempDir, "definition.json"),
      name: "heavy run",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { prompt: "x".repeat(1024) },
    });
    store.completeRun(run.id, "ok", { report: "y".repeat(2048) });

    const summaries = store.listRunSummaries({ ownerNpub: "npub-owner" });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: run.id,
      name: "heavy run",
      status: "ok",
      ownerNpub: "npub-owner",
      hasInput: true,
      hasCurrent: true,
      hasResult: true,
    });
    expect(summaries[0] as Record<string, unknown>).not.toHaveProperty("input");
    expect(summaries[0] as Record<string, unknown>).not.toHaveProperty("current");
    expect(summaries[0] as Record<string, unknown>).not.toHaveProperty("result");
    expect(summaries[0].inputBytes).toBeGreaterThan(1000);
    expect(summaries[0].resultBytes).toBeGreaterThan(2000);
  });

  test("gets one run summary without decoded run payloads", () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition-1",
      name: "single run",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { value: 1 },
    });

    const summary = store.getRunSummary(run.id);

    expect(summary).toMatchObject({
      id: run.id,
      name: "single run",
      status: "running",
      hasInput: true,
      hasCurrent: true,
      hasResult: false,
    });
    expect(summary as Record<string, unknown>).not.toHaveProperty("input");
  });

  test("cancels a running run and any active steps", () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition-1",
      name: "cancel run",
      ownerNpub: "npub-owner",
      ownerAlias: "owner-alias",
      scope: "user",
      input: { value: 1 },
    });
    const runningStep = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "running",
      kind: "agent",
      input: {},
    });
    const queuedStep = store.createStep({
      runId: run.id,
      stepIndex: 1,
      name: "queued",
      kind: "agent",
      input: {},
      status: "queued",
    });
    store.setRunActiveStep(run.id, runningStep.id);

    const cancelled = store.cancelRun(run.id, "Stopped by test");

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.activeStepId).toBeNull();
    expect(cancelled?.error).toBe("Stopped by test");
    expect(store.listSteps(run.id).map((step) => [step.id, step.status, step.error])).toEqual([
      [runningStep.id, "cancelled", "Stopped by test"],
      [queuedStep.id, "cancelled", "Stopped by test"],
    ]);
  });
});
