import type { DeclarativePipeline, DeclarativeStep } from "./declarative";

/** Validate only the additive role contract; legacy display metadata stays valid. */
export function validatePipelineDisplayRoles(spec: DeclarativePipeline): void {
  function visit(steps: DeclarativeStep[]): void {
    for (const step of steps) {
      for (const direction of ["in", "out"] as const) {
        for (const field of step.display?.[direction] ?? []) {
          if (field.role !== undefined && field.role !== "operation" && field.role !== "carried") {
            throw new Error(`Invalid display role on ${step.id ?? step.name}.${direction}: ${String(field.role)}`);
          }
        }
      }
      if (step.type === "loop" && step.steps) visit(step.steps);
      if (step.type === "parallel") visit([step.step]);
    }
  }
  visit(spec.steps);
}
