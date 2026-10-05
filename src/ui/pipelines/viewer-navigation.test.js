import { expect, test } from "bun:test";
import { pipelineNodes, scopedPipelineNodes } from "./viewer-projection.js";

test("overview contains only actual defined siblings and nested navigation retains attempts", () => {
  const definition = { steps: [{ logicalKey: "loop", title: "Bounded loop", children: [{ logicalKey: "loop/read", children: [] }] }] };
  const snapshot = { definition, steps: [{ logicalKey: "loop/read", id: "read-2", attempt: 2 }, { logicalKey: "orphan", id: "orphan", attempt: 1 }] };
  expect(pipelineNodes(definition, snapshot).map(node => node.logicalKey)).toEqual(["loop"]);
  const loop = pipelineNodes(definition, snapshot)[0];
  expect(loop.children.map(node => node.logicalKey)).toEqual(["loop/read"]);
  expect(loop.children[0].attempts[0].id).toBe("read-2");
  expect(scopedPipelineNodes(definition, snapshot, [{key:"loop"}])[0].logicalKey).toBe("loop/read");
  expect(() => scopedPipelineNodes(definition, snapshot, [{key:"missing"}])).toThrow("scope is missing");
});
