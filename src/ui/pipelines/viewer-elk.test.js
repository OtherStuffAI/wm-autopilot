import { expect, test } from "bun:test";
import ELK from "elkjs/lib/elk-api.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import retrieve from "../../../scripts/pipeline-native-bird-definition.json";
import timeline from "../../../scripts/pipeline-native-bird-timeline-definition.json";
import { viewerDefinition } from "../../pipelines/pipeline-viewer-dto.ts";
import { connectedPorts, INPUT_KEY, viewerMapping } from "./viewer-mapping.js";
import { createElkLayout, elkGraph, portId } from "./viewer-elk.js";
import { flattenPipelineNodes, pipelineNodes, scopedPipelineNodes } from "./viewer-projection.js";

function definition(spec) {
  return viewerDefinition({ id: spec.name, name: spec.name, spec });
}
function mapping(spec, trail = []) {
  const dto = definition(spec);
  return viewerMapping(scopedPipelineNodes(dto, null, trail), dto.wiring, trail.length > 0, new Set(flattenPipelineNodes(dto.steps).map(node => node.logicalKey)));
}
function measuredCards(model, direction) {
  return model.nodes.map(node => {
    const ports = ["inputs", "outputs"].flatMap(side => connectedPorts(node, side, model.wires).map((port, index) => ({
      id: portId(node.logicalKey, side, port.path), width: 0, height: 0,
      x: direction === "RIGHT" ? side === "outputs" ? 300 : 0 : 40 + index * 45,
      y: direction === "RIGHT" ? 45 + index * 24 : side === "outputs" ? 300 : 0,
      layoutOptions: { "elk.port.side": direction === "RIGHT" ? side === "outputs" ? "EAST" : "WEST" : side === "outputs" ? "SOUTH" : "NORTH" },
    })));
    return { key: node.logicalKey, width: 300, height: 300, ports };
  });
}

test("frozen Bird retrieval Request originates at a visible Pipeline input field", () => {
  const model = mapping(retrieve);
  expect(model.nodes[0]).toMatchObject({ logicalKey: INPUT_KEY, title: "Pipeline input", inputNode: true });
  expect(model.links).toContainEqual(expect.objectContaining({ sourceKey: INPUT_KEY, sourcePath: "$.request", targetKey: "prepare", targetPath: "$.request" }));
  expect(model.nodes[0].outputs.map(port => port.path)).toContain("$.request");
});

test("frozen timeline carried fields terminate on actual configured fields, never Response", () => {
  const model = mapping(timeline);
  const carried = model.links.filter(link => link.targetKey === "reply" && link.wire.carriedForward);
  expect(carried.length).toBeGreaterThan(0);
  const reply = model.nodes.find(node => node.logicalKey === "reply");
  const fields = connectedPorts(reply, "inputs", model.wires);
  for (const link of carried) {
    expect(link.targetPath).not.toBe("$.message");
    expect(fields.find(port => port.path === link.targetPath)).toMatchObject({ configured: true });
  }
  expect(model.links.find(link => link.targetKey === "reply" && !link.wire.carriedForward).targetPath).toBe("$.message");
});

test("hidden chatMetadata has its own exact port while unknown fields reveal their selector", () => {
  const nodes = [{ logicalKey: "reply", inputs: [{ label: "Response", path: "$.message" }], outputs: [] }];
  const wires = ["$.chatMetadata", "$.unfamiliar"].map(path => ({ sourceStepKey: null, sourcePath: path, targetStepKey: "reply", targetPath: path, carriedForward: true }));
  const model = viewerMapping(nodes, wires);
  expect(connectedPorts(nodes[0], "inputs", wires)).toContainEqual(expect.objectContaining({ path: "$.chatMetadata", label: "Chat metadata", configured: true }));
  expect(connectedPorts(nodes[0], "inputs", wires)).toContainEqual(expect.objectContaining({ path: "$.unfamiliar", label: "$.unfamiliar" }));
  expect(model.links.map(link => link.targetPath)).toEqual(["$.chatMetadata", "$.unfamiliar"]);
});

test("actual loop drill-down uses Scope input and retains captured attempts", () => {
  const dto = definition(retrieve), parent = dto.steps.find(node => node.children.length);
  const key = parent.children[0].logicalKey;
  const snapshot = { steps: [{ logicalKey: key, id: "attempt-2", attempt: 2 }, { logicalKey: key, id: "attempt-1", attempt: 1 }] };
  const nodes = scopedPipelineNodes(dto, snapshot, [{ key: parent.logicalKey }]);
  const model = viewerMapping(nodes, dto.wiring, true, new Set(flattenPipelineNodes(dto.steps).map(node => node.logicalKey)));
  expect(model.nodes[0].title).toBe("Scope input");
  expect(model.links.some(link => link.sourceKey === INPUT_KEY && link.targetKey === key)).toBe(true);
  expect(nodes[0].attempts.map(attempt => attempt.id)).toEqual(["attempt-1", "attempt-2"]);
  expect(pipelineNodes(dto, snapshot).map(node => node.logicalKey)).toEqual(dto.steps.map(node => node.logicalKey));
});

test("invalid selectors are unavailable and absent exact ports reject rather than attach elsewhere", () => {
  const model = viewerMapping([{ logicalKey: "target", inputs: [], outputs: [] }], [null, "missing", "$.", "$[bogus", "$.valid..broken"].map(sourcePath => ({ sourceStepKey: null, sourcePath, targetStepKey: "target", targetPath: "$.request" })));
  expect(model.links).toEqual([]);
  expect(model.unavailable).toHaveLength(5);
  expect(() => elkGraph([{ key: "target", width: 100, height: 100, ports: [] }], [{ sourceKey: "source", sourcePath: "$.chatMetadata", targetKey: "target", targetPath: "$.chatMetadata" }], "RIGHT")).toThrow("Exact field port unavailable");
});

for (const direction of ["RIGHT", "DOWN"]) test(`real ELK ${direction} routing retains exact fixed field endpoints`, async () => {
  const model = mapping(timeline), graph = elkGraph(measuredCards(model, direction), model.links, direction);
  expect(graph.children.every(node => node.layoutOptions["elk.portConstraints"] === "FIXED_POS")).toBe(true);
  // Bun defines self without document; ELK mistakes it for a worker global.
  // Load its pinned fake worker in a Node-shaped context for geometry tests.
  const context = { module: { exports: {} }, exports: {}, console, Error, Array, Object, Math, Date, JSON, setTimeout, clearTimeout };
  context.global = context;
  runInNewContext(readFileSync(import.meta.resolve("elkjs/lib/elk-worker.min.js").replace("file://", ""), "utf8"), context);
  const engine = createElkLayout(new ELK({ workerFactory: () => Object.assign(new context.module.exports.Worker(), { terminate() {} }) }));
  try {
    const result = await engine.layout(graph);
    expect(result.edges.length).toBe(model.links.length);
    for (const edge of result.edges) {
      expect(edge.sections.length).toBeGreaterThan(0);
      const index = Number(edge.id), link = model.links[index];
      expect(edge.sources).toEqual([portId(link.sourceKey, "outputs", link.sourcePath)]);
      expect(edge.targets).toEqual([portId(link.targetKey, "inputs", link.targetPath)]);
      for (const section of edge.sections) {
        const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
        for (let index = 1; index < points.length; index++) {
          const a = points[index - 1], b = points[index];
          expect(a.x === b.x || a.y === b.y).toBe(true);
          for (const node of result.children.filter(node => ![link.sourceKey, link.targetKey].includes(node.id))) {
            const overlap = a.x === b.x
              ? a.x > node.x && a.x < node.x + node.width && Math.max(a.y, b.y) > node.y && Math.min(a.y, b.y) < node.y + node.height
              : a.y > node.y && a.y < node.y + node.height && Math.max(a.x, b.x) > node.x && Math.min(a.x, b.x) < node.x + node.width;
            expect(overlap).toBe(false);
          }
        }
      }
      for (const [id, endpoint] of [[edge.sources[0], edge.sections[0].startPoint], [edge.targets[0], edge.sections.at(-1).endPoint]]) {
        const node = result.children.find(child => child.ports.some(port => port.id === id));
        const port = node.ports.find(port => port.id === id);
        expect(endpoint.x).toBeCloseTo(node.x + port.x, 5);
        expect(endpoint.y).toBeCloseTo(node.y + port.y, 5);
      }
    }
  } finally { engine.dispose(); }
});

test("nonexistent source step is unavailable, never a fabricated scope input", () => {
  const model = viewerMapping([{ logicalKey: "target", inputs: [], outputs: [] }], [{ sourceStepKey: "missing-step", sourcePath: "$.value", targetStepKey: "target", targetPath: "$.value" }]);
  expect(model.links).toEqual([]);
  expect(model.unavailable).toHaveLength(1);
  expect(model.nodes.some(node => node.inputNode)).toBe(false);
});

test("async layout discards superseded, scope-invalidated and disposed results", async () => {
  const pending = [], engine = { layout: graph => new Promise(resolve => pending.push(() => resolve(graph))), terminateWorker: () => engine.terminated = true };
  const gate = createElkLayout(engine);
  const old = gate.layout({ id: "old" }), current = gate.layout({ id: "current" });
  pending[1](); expect(await current).toEqual({ id: "current" });
  pending[0](); expect(await old).toBeNull();
  const scope = gate.layout({ id: "old-scope" }); gate.invalidate(); pending[2](); expect(await scope).toBeNull();
  const disposed = gate.layout({ id: "disposed" }); gate.dispose(); pending[3](); expect(await disposed).toBeNull();
  expect(engine.terminated).toBe(true);
});

test("rejected stale and disposed layouts are ignored while current errors remain visible", async () => {
  const pending = [];
  const gate = createElkLayout({ layout: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const stale = gate.layout({ id: "superseded" });
  const current = gate.layout({ id: "current" });
  pending[0].reject(new Error("Stale scope engine failure"));
  expect(await stale).toBeNull();
  pending[1].reject(new Error("Current engine failure"));
  await expect(current).rejects.toThrow("Current engine failure");
  const disposed = gate.layout({ id: "disposed" });
  gate.dispose();
  pending[2].reject(new Error("Disposed engine failure"));
  expect(await disposed).toBeNull();
});
