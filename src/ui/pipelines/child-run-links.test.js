import { expect, test } from "bun:test";
import { renderPipelineComposition, renderPipelineRunLink } from "./child-run-links.js";
import { renderRunsWorkspace } from "./runs-view.js";

test("composition links use accessible existing run navigation and escape record values", () => {
  const html = renderPipelineComposition({ parent: { parentRunId: "parent" }, children: [{ childRunId: "child" }], definitionVersion: 2, definitionHash: "hash" });
  expect(html).toContain('data-action="open-run"'); expect(html).toContain('data-id="parent"'); expect(html).toContain('data-id="child"');
  expect(html).toContain('aria-label="Open child run child"'); expect(html).toContain('data-testid="pipeline-child-run-link"');
  expect(html).toContain("Definition version: 2");
  expect(renderPipelineRunLink('" onclick="evil', "<child>")).not.toContain('data-id="" onclick="evil');
  expect(renderPipelineRunLink(null, "child")).toBe("");
});

test("run detail displays durable composition and child links", () => {
  const state = { runs: [], runSearch: "", runFilter: "all", selectedRunTab: "overview", selectedRun: {
    run: { id: "parent", name: "Parent", status: "running" }, composition: { children: [{ childRunId: "child" }], definitionVersion: 1 },
    steps: [{ id: "step", name: "Retrieve", kind: "pipeline", status: "running", stepIndex: 0, childRunId: "child" }] } };
  const html = renderRunsWorkspace(state);
  expect(html).toContain('data-testid="pipeline-composition"'); expect(html).toContain('data-id="child"');
});
