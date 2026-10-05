import { expandPipelineBlock } from "./pipeline-blocks.ts";
import type { PipelineDefinitionRecord } from "./pipeline-loader.ts";
import type { JsonObject } from "./pipeline-store.ts";

export function isChatAddressable(definition: PipelineDefinitionRecord): boolean {
  const first = definition.spec.steps[0];
  return Boolean(first?.type === "block" && first.block === "flightdeck.threadInvocation");
}

export function chatPipelineDescriptor(definition: PipelineDefinitionRecord): JsonObject {
  const first = definition.spec.steps[0];
  const invocation = first?.type === "block" ? expandPipelineBlock(first).steps[0] : null;
  const selector = invocation?.input;
  const fields = selector && typeof selector === "object" && "pick" in selector ? Object.keys(selector.pick ?? {}) : [];
  return {
    key: `pipeline:${definition.id}`, kind: "pipeline", name: definition.spec.name,
    version: definition.spec.version ?? null, description: (definition.spec.description ?? "").slice(0, 2000), source: definition.path,
    input: [...new Set([...Object.keys(definition.spec.input ?? {}), ...fields])],
    output: (definition.spec.steps.at(-1)?.display?.out ?? []).map(row => ({ label: row.label, format: row.format })),
    invocation: "Use the existing Flight Deck pipeline invocation path with this definition; current permissions still apply.",
  };
}
