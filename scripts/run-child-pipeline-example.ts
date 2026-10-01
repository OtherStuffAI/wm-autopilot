import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStore } from "../src/pipelines/pipeline-store";
import { getPipelineDefinition } from "../src/pipelines/pipeline-loader";
import { loadPipelineFunctionRegistry } from "../src/pipelines/function-loader";
import { builtinPipelineFunctions } from "../src/pipelines/functions";
import { runDeclarativePipeline } from "../src/pipelines/pipeline-runner";
import type { DeclarativePipeline } from "../src/pipelines/declarative";

// A self-contained example: no managed server, model, credentials or messages.
const directory = await mkdtemp(join(tmpdir(), "wingmen-child-example-"));
const previousRoot = process.env.WINGMEN_PIPELINES_ROOT;
process.env.WINGMEN_PIPELINES_ROOT = directory;
try {
  const definitions = join(directory, "shared", "definitions");
  await mkdir(definitions, { recursive: true });
  const child: DeclarativePipeline = {
    name: "example.normalise", version: 1, description: "Reusable deterministic text normalisation.",
    steps: [{ name: "normalise", type: "code", function: "text.normalise", input: { pick: { text: "$.text" } },
      description: "Normalise supplied text.", display: { in: [{ label: "Text", path: "$.text", format: "text" }], out: [{ label: "Text", path: "$.text", format: "text" }] } }],
  };
  const parent: DeclarativePipeline = {
    name: "example.compose", version: 1, description: "Call text normalisation as a child pipeline.",
    steps: [{ name: "normalise-child", type: "pipeline", pipeline: "example.normalise", version: 1,
      input: { pick: { text: "$.request" } }, assign: "$.normalised", timeoutMs: 5000,
      description: "Wait for the reusable normalisation pipeline.", display: { in: [{ label: "Text", path: "$.text", format: "text" }], out: [{ label: "Text", path: "$.text", format: "text" }] } }],
  };
  await writeFile(join(definitions, "example.normalise.v1.json"), JSON.stringify(child));
  await writeFile(join(definitions, "example.compose.v1.json"), JSON.stringify(parent));
  const definition = await getPipelineDefinition("example.compose", null);
  if (!definition) throw new Error("Example definition was not loaded");
  const store = new PipelineStore(join(directory, "example.sqlite"));
  const { registry } = await loadPipelineFunctionRegistry(null, builtinPipelineFunctions);
  const run = await runDeclarativePipeline({ store, definition, registry, input: { request: "  Reusable child pipelines  " },
    ownerNpub: null, ownerAlias: null, callbackOrigin: "http://localhost", sessionApiContext: {} as never });
  if (run.status !== "ok") throw new Error(run.error ?? "Example failed");
  await Bun.write(Bun.stdout, JSON.stringify({ status: run.status, result: run.result,
    children: store.composition.children(run.id).map(link => ({ ...link, definitionHash: store.composition.snapshot(link.childRunId)?.hash })) }, null, 2) + "\n");
} finally {
  if (previousRoot === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
  else process.env.WINGMEN_PIPELINES_ROOT = previousRoot;
  await rm(directory, { recursive: true, force: true });
}
