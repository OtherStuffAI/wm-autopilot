import { expect, test } from "bun:test";
import { validatePipelineDisplayRoles } from "./pipeline-display-roles";
import { viewerDefinition } from "./pipeline-viewer-dto";
import type { DeclarativePipeline, DeclarativeStep } from "./declarative";
import type { PipelineDefinitionRecord } from "./pipeline-loader";

function definition(steps: DeclarativeStep[]): PipelineDefinitionRecord {
  return { id: "roles", name: "roles", slug: "roles", path: "synthetic.json", scope: "shared", ownerAlias: null, spec: { name: "roles", steps } };
}

test("legacy fields remain unclassified and explicit source selects evidence independently of direction", () => {
  const result = viewerDefinition(definition([{ name: "step", type: "code", function: "noop", display: {
    in: [{ label: "Legacy", path: "$.request" }, { label: "Thread", path: "$.thread", role: "carried" }],
    out: [{ label: "Result", path: "$.result", role: "operation" }, { label: "State", path: "$.saved", source: "state", role: "carried" }, { label: "Input", path: "$.request", source: "input" }],
  } }]));
  expect(result.steps[0]!.inputs[0]).toEqual({ label: "Legacy", path: "$.request", format: "auto", source: "input", evidenceKind: "resolved_input" });
  expect(result.steps[0]!.inputs[1]!.role).toBe("carried");
  expect(result.steps[0]!.outputs.map(port => [port.role, port.source, port.evidenceKind])).toEqual([
    ["operation", "output", "returned_output"], ["carried", "state", "state_write"], [undefined, "input", "resolved_input"],
  ]);
});

test("whole-object selectors preserve nested meaningful ports without inventing state output provenance", () => {
  const result = viewerDefinition(definition([
    { name: "do", type: "code", function: "noop", assign: "$.workerResult", display: { out: [
      { label: "Result", path: "$.result", role: "operation" }, { label: "Saved", path: "$.result.evidence", source: "state" },
    ] } },
    { name: "review", type: "code", function: "noop", input: { pick: { workerOutput: "$.workerResult.result" } }, display: { in: [
      { label: "Evidence", path: "$.workerOutput.evidence", role: "operation" },
    ] } },
  ]));
  expect(result.wiring[0]).toMatchObject({ sourceStepKey: "do", sourceValuePath: "$.result", sourcePortPaths: ["$.result"], targetPortPaths: ["$.workerOutput.evidence"] });
});

test("role validation accepts omission and known values and rejects invalid nested declarations", () => {
  const step = { name: "do", type: "code", function: "noop", display: { in: [{ label: "Request", path: "$.request", role: "operation" }] } } as DeclarativeStep;
  expect(() => validatePipelineDisplayRoles({ name: "roles", steps: [step] })).not.toThrow();
  const invalid = JSON.parse(JSON.stringify(step)); invalid.display.in[0].role = "routing";
  for (const steps of [[invalid], [{ name: "loop", type: "loop", iterations: 2, steps: [invalid] }], [{ name: "parallel", type: "parallel", step: invalid }]]) {
    expect(() => validatePipelineDisplayRoles({ name: "roles", steps } as DeclarativePipeline)).toThrow("Invalid display role");
  }
});
