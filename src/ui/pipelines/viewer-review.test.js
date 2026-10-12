import { expect, test } from "bun:test";
import ELK from "elkjs/lib/elk-api.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { viewerDefinition } from "../../pipelines/pipeline-viewer-dto.ts";
import { definitionDto } from "./viewer-contract.js";
import { pipelineNodes } from "./viewer-projection.js";
import { viewerMapping } from "./viewer-mapping.js";
import { conditionLabel, domainPorts, executionFlow, selectedMappingLinks, stepType, reviewValidation } from "./viewer-review.js";
import { reviewGraph } from "./viewer-review-geometry.js";

function project(steps) {
  const definition = definitionDto(viewerDefinition({ id: "review", name: "Review", spec: { name: "Review", steps } }));
  return { definition, nodes: pipelineNodes(definition) };
}
const code = (name, extra = {}) => ({ name, type: "code", function: "identity", description: "A coherent operation", ...extra });

test("sequence and gated skip range reflect executor semantics without fabricated decisions", () => {
  const { nodes } = project([code("prepare", { assign: "$.decision", display: { out: [{ label: "Allowed", path: "$.allowed" }] } }),
    { name: "screen", type: "classifier", prompt: "Check" },
    code("build", { when: { path: "$.decision.allowed", equals: true } }),
    code("validate", { when: { path: "$.decision.allowed", equals: true } }), code("deliver")]);
  const flow = executionFlow(nodes);
  expect(flow.links.filter(row => row.kind === "execution").map(row => [row.sourceKey, row.targetKey])).toEqual([["prepare", "screen"], ["screen", "build"], ["build", "validate"], ["validate", "deliver"]]);
  expect(flow.links.find(row => row.kind === "skip")).toMatchObject({ sourceKey: "screen", targetKey: "deliver", label: "Otherwise · skip 2" });
  expect(flow.links.find(row => row.targetKey === "build").label).toBe("Allowed is true");
  expect(stepType(nodes[1])).toBe("Decision"); expect(stepType(nodes[2])).toBe("Code");
});
test("bounded target and body loops retain actual repeat range and missing targets surface", () => {
  const { nodes } = project([code("draft"), code("critique"), { name: "repeat", type: "loop", target: "draft", iterations: 3, history: "$.history", capture: { draft: "$.draft" } },
    { name: "body", type: "loop", iterations: 2, steps: [code("read")] }, code("exit")]);
  const flow = executionFlow(nodes);
  expect(flow.loops[0].keys).toEqual(["draft", "critique", "repeat"]);
  expect(flow.loops[0].label).toContain("collect $.history");
  expect(flow.links.find(row => row.kind === "repeat")).toMatchObject({ sourceKey: "repeat", targetKey: "draft" });
  expect(flow.links.find(row => row.sourceKey === "body").label).toBe("Bound reached");
  expect(nodes[3].children[0].logicalKey).toBe("body/read");
  nodes[2].review.target = "missing";
  expect(executionFlow(nodes).unavailable).toEqual(["Loop target unavailable: missing"]);
});
test("child navigation config, prompt, failure and redaction survive read projection", () => {
  const { nodes } = project([{ name: "child", type: "pipeline", pipeline: "child-id", version: 2, failurePolicy: "record_error" },
    { name: "agent", type: "agent", prompt: "Review evidence", input: { value: { apiKey: "private-secret" } } }]);
  expect(stepType(nodes[0])).toBe("Child pipeline");
  expect(nodes[0].review).toMatchObject({ pipeline: "child-id", version: 2, failurePolicy: "record_error" });
  expect(nodes[1].review.prompt).toBe("Review evidence");
  expect(JSON.stringify(nodes)).not.toContain("private-secret");
  expect(reviewValidation({ ...nodes[0], review: null }, nodes)[0]).toContain("unavailable");
});
test("domain fields stay compact and selected data traces exact producer and consumers", () => {
  const { definition, nodes } = project([code("producer", { assign: "$.result", display: { out: [{ label: "Summary", path: "$.summary" }] } }),
    code("consumer", { input: { pick: { message: "$.result.summary", requestId: "$.requestId" } }, display: { in: [{ label: "User message", path: "$.message" }] } })]);
  const mapping = viewerMapping(nodes, definition.wiring);
  expect(domainPorts(nodes[1], "inputs").map(row => row.label)).toEqual(["User message"]);
  expect(selectedMappingLinks(mapping, "producer", "$.summary", "outputs")).toHaveLength(1);
  expect(selectedMappingLinks(mapping, "consumer", "", "")).toHaveLength(2);
  expect(selectedMappingLinks(mapping, "", "", "")).toEqual([]);
});
test("execution layout does not depend on number of plumbing selectors", async () => {
  const { nodes } = project([code("a"), code("b", { when: { path: "$.allowed", equals: true } }), code("c")]);
  const cards = nodes.map(node => ({ key: node.logicalKey, width: 220, height: 180 }));
  const flow = executionFlow(nodes), graph = reviewGraph(cards, flow.links, "RIGHT");
  const context = { module: { exports: {} }, exports: {}, console, Error, Array, Object, Math, Date, JSON, setTimeout, clearTimeout };
  context.global = context;
  runInNewContext(readFileSync(import.meta.resolve("elkjs/lib/elk-worker.min.js").replace("file://", ""), "utf8"), context);
  const elk = new ELK({ workerFactory: () => Object.assign(new context.module.exports.Worker(), { terminate() {} }) }), result = await elk.layout(graph);
  expect(result.children).toHaveLength(3);
  expect(result.width).toBeLessThan(1100);
  expect(result.children[0].x).toBeLessThan(result.children[1].x);
  expect(result.children[1].x).toBeLessThan(result.children[2].x);
  const vertical = await elk.layout(reviewGraph(cards, flow.links, "DOWN"));
  expect(vertical.children[0].y).toBeLessThan(vertical.children[2].y);
});

test("condition summaries retain declared labels and bounded exact path context", () => {
  expect(conditionLabel({ path: "$.workContext.workPlan.reporting.mode", equals: "flightdeck_task" }, [])).toBe('reporting mode is "flightdeck_task"');
  expect(conditionLabel({ path: "$.builderAllowed", equals: true }, [])).toBe("builder Allowed is true");
  expect(conditionLabel({ path: "$." + "long".repeat(30), equals: true }, [])).toBe("Configured condition (see details)");
  expect(conditionLabel({ expression: "unknown expression" }, [])).toBe("Configured condition (see details)");
  expect(reviewGraph([], []).layoutOptions["elk.direction"]).toBe("DOWN");
});
