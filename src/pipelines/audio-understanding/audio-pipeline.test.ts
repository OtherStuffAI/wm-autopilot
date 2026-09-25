import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionRegistry } from "../declarative";
import { getPipelineDefinition } from "../pipeline-loader";
import { runDeclarativePipeline } from "../pipeline-runner";
import { PipelineStore, type JsonObject } from "../pipeline-store";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.WINGMEN_PIPELINES_ROOT;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("audio understanding declarative pipeline", () => {
  test("loads and runs the deterministic path with fake adapters while optional stages skip", async () => {
    const root = await mkdtemp(join(tmpdir(), "audio-pipeline-run-"));
    roots.push(root);
    process.env.WINGMEN_PIPELINES_ROOT = join(root, "definitions");
    const definition = await getPipelineDefinition("audio-understanding", null);
    expect(definition).not.toBeNull();
    const calls: string[] = [];
    const registry: FunctionRegistry = {};
    for (const step of definition!.spec.steps) {
      if (step.type !== "code") continue;
      registry[step.function] = async (input: JsonObject) => {
        calls.push(step.function);
        if (step.function === "audio.validateRequest") return { ...input, source: { kind: "local", path: "/fixture.wav" }, options: input.options, returnTo: input.returnTo };
        if (step.function === "audio.preflight") return { ready: true };
        if (step.function === "audio.normalise") return { path: "/normalised.wav" };
        if (step.function === "audio.transcribe") return { words: [{ text: "Hello", start: 0, end: 1 }], rawTranscript: "Hello" };
        if (step.function === "audio.diarize") return { segments: [{ speaker: "Speaker 1", start: 0, end: 1 }] };
        if (step.function === "audio.merge") return { words: [], turns: [], speakers: [], rawTranscript: "Hello" };
        if (step.function === "audio.correct") return { words: [], turns: [], speakers: [], rawTranscript: "Hello", correctedTranscript: "Hello", corrections: [] };
        if (step.function === "audio.package") return { correctedTranscript: "Hello", metrics: { wordCount: 1, speakerCount: 1 } };
        if (step.function === "audio.persist") return { correctedTranscript: "Hello", metrics: { wordCount: 1, speakerCount: 1 }, artifacts: [], downstream: input.downstream };
        if (step.function === "audio.consume") return { proofread: { status: "skipped" }, summary: { status: "skipped" }, graph: { status: "skipped" }, pipeline: { status: "skipped" } };
        if (step.function === "audio.prepareDelivery") return { requested: true, route: input.request as JsonObject, message: "Done", idempotencyKey: "audio:test" };
        return { delivered: true };
      };
    }
    const route = { workspaceId: "11111111-1111-4111-8111-111111111111", scopeId: "22222222-2222-4222-8222-222222222222", channelId: "33333333-3333-4333-8333-333333333333", threadId: "44444444-4444-4444-8444-444444444444" };
    const run = await runDeclarativePipeline({
      store: new PipelineStore(join(root, "runs.sqlite")), sessionApiContext: {} as never, definition: definition!, registry,
      input: { audioRef: "/fixture.wav", returnTo: route, options: { correctTranscript: true, proofreadTranscript: false, summarise: false, extractGraph: false, downstreamPipelineId: null } },
      ownerNpub: "npub1test", ownerAlias: null, callbackOrigin: "http://localhost",
    });
    expect(run.status).toBe("ok");
    expect(calls).not.toContain("agent");
    expect(run.result?.result).toMatchObject({ downstream: { summary: { status: "skipped" }, graph: { status: "skipped" } } });
  });
});
