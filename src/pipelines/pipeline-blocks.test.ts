import { describe, expect, test } from "bun:test";
import { expandPipelineBlock } from "./pipeline-blocks";

describe("expandPipelineBlock", () => {
  test("expands memory.graphContext into entity extraction, search, and consolidation steps", () => {
    const expansion = expandPipelineBlock({
      name: "recall-memory",
      type: "block",
      block: "memory.graphContext",
      input: { pick: { prompt: "$.prompt" } },
      assign: "$.memory.graph",
    });

    expect(expansion.inputPath).toBe("$.blocks.recall_memory.input");
    expect(expansion.outputPath).toBe("$.memory.graph");
    expect(expansion.steps.map((step) => step.name)).toEqual([
      "recall-memory / extract-memory-entities",
      "recall-memory / search-graph-memory",
      "recall-memory / consolidate-graph-context",
    ]);
    expect(expansion.steps.map((step) => step.type)).toEqual(["agent", "code", "code"]);
  });
});
