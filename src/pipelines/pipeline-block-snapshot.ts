import type { DeclarativeStep } from "./declarative";
import { expandPipelineBlock, type PipelineBlockExpansion } from "./pipeline-blocks";

export type PipelineBlockSnapshots = Record<string, PipelineBlockExpansion>;

/** Pin expansion structure and paths once, before execution or resume. */
export function snapshotPipelineBlocks(steps: DeclarativeStep[], expand = expandPipelineBlock): PipelineBlockSnapshots {
  const snapshots: PipelineBlockSnapshots = {};
  function visit(nodes: DeclarativeStep[], prefix = ""): void {
    for (const step of nodes) {
      const key = `${prefix}${step.id ?? step.name}`;
      if (step.type === "block") {
        const expansion = expand(step);
        snapshots[key] = expansion;
        visit(expansion.steps, `${key}/`);
      } else if (step.type === "loop") visit(step.steps ?? [], `${key}/`);
      else if (step.type === "parallel") visit([step.step], `${key}/`);
    }
  }
  visit(steps);
  return JSON.parse(JSON.stringify(snapshots));
}
