import type { DeclarativeStep, FunctionRegistry } from "./declarative";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { expandPipelineBlock } from "./pipeline-blocks";

export const runtimeFunctionHash = Symbol.for("wingmen.pipeline.runtimeFunctionHash");

export function pipelineFunctionHashes(definition: PipelineDefinitionRecord, registry: FunctionRegistry): Record<string, string> {
  const hashes: Record<string, string> = {};
  function visit(steps: DeclarativeStep[]): void {
    for (const step of steps) {
      if (step.type === "code" && step.agentTools) {
        if(step.function!=='session.completedTurn'||typeof step.agentTools!=='object'||Array.isArray(step.agentTools)||!Object.keys(step.agentTools).length||Object.keys(step.agentTools).length>16||Object.entries(step.agentTools).some(([name,value])=>!/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/.test(name)||typeof value!=='string'||!value))throw new Error('Invalid native project tool definition');
        for (const name of Object.values(step.agentTools)) {
          const hash = (registry[name] as unknown as Record<symbol, unknown> | undefined)?.[runtimeFunctionHash];
          if (typeof hash !== "string") throw new Error(`Agent tool function must be hash pinned: ${name}`);
          hashes[name] = hash;
        }
      }
      const functionName = step.type === "code" ? step.function : step.type === "classifier" ? step.inputFunction : undefined;
      if (functionName) {
        const hash = (registry[functionName] as unknown as Record<symbol, unknown> | undefined)?.[runtimeFunctionHash];
        if (typeof hash === "string") hashes[functionName] = hash;
      }
      if (step.type === "block") visit(expandPipelineBlock(step).steps);
      if (step.type === "loop" && step.steps) visit(step.steps);
      if (step.type === "parallel") visit([step.step]);
    }
  }
  visit(definition.spec.steps);
  return hashes;
}

export function assertPipelineFunctionPins(pins: Record<string, string> | undefined, registry: FunctionRegistry): void {
  for (const [name, expected] of Object.entries(pins ?? {})) {
    const actual = (registry[name] as unknown as Record<symbol, unknown> | undefined)?.[runtimeFunctionHash];
    if (actual !== expected) throw new Error(`Pinned pipeline function changed or is unavailable: ${name}. Start a new run to use the new implementation.`);
  }
}
