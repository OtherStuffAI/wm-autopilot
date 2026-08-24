import type { DeclarativeStep, SelectorSpec } from "./declarative";
import type { JsonObject } from "./pipeline-store";

export function buildPipelineStepMetadata(step: DeclarativeStep, options: {
  inputSelector?: SelectorSpec;
  parent?: JsonObject;
} = {}): JsonObject {
  const inputSelector = options.inputSelector ?? step.input ?? null;
  return compactObject({
    definitionStepId: step.id ?? null,
    name: step.name,
    description: step.description ?? null,
    display: step.display ?? null,
    type: step.type,
    input: inputSelector,
    assign: "assign" in step ? step.assign ?? null : null,
    when: step.when ?? null,
    parent: options.parent ?? null,
    executor: buildExecutorMetadata(step),
  });
}

function buildExecutorMetadata(step: DeclarativeStep): JsonObject {
  if (step.type === "code") {
    return compactObject({
      kind: "function",
      function: step.function,
    });
  }
  if (step.type === "agent") {
    return compactObject({
      kind: "agent",
      agent: step.agent ?? null,
      model: step.model ?? null,
      directory: step.directory ?? null,
      timeoutMs: step.timeoutMs ?? null,
      prompt: step.prompt,
    });
  }
  if (step.type === "classifier") {
    return compactObject({
      kind: "classifier",
      provider: step.provider ?? "openrouter",
      model: step.model ?? null,
      timeoutMs: step.timeoutMs ?? null,
      retries: step.retries ?? null,
      prompt: step.prompt,
    });
  }
  if (step.type === "block") {
    return compactObject({
      kind: "block",
      block: step.block,
      config: step.config ?? null,
    });
  }
  if (step.type === "loop") {
    return compactObject({
      kind: "loop",
      iterations: step.iterations ?? null,
      target: step.target ?? null,
      history: step.history ?? null,
      capture: step.capture ?? null,
      counter: step.counter ?? null,
      nestedStepCount: Array.isArray(step.steps) ? step.steps.length : 0,
    });
  }
  return compactObject({
    kind: "parallel",
    source: step.source,
    itemKey: step.itemKey ?? null,
    itemInput: step.itemInput ?? null,
    maxConcurrency: step.maxConcurrency ?? null,
    agentLaunchConcurrency: step.agentLaunchConcurrency ?? null,
    agentStartupRetries: step.agentStartupRetries ?? null,
    agentStartupRetryBackoffMs: step.agentStartupRetryBackoffMs ?? null,
    failurePolicy: step.failurePolicy ?? null,
    childStep: summarizeChildStep(step.step),
  });
}

function summarizeChildStep(step: DeclarativeStep): JsonObject {
  return compactObject({
    definitionStepId: step.id ?? null,
    name: step.name,
    description: step.description ?? null,
    display: step.display ?? null,
    type: step.type,
    input: step.input ?? null,
    assign: "assign" in step ? step.assign ?? null : null,
    executor: buildExecutorMetadata(step),
  });
}

function compactObject(input: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
