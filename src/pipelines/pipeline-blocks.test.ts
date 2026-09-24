import { describe, expect, test } from "bun:test";
import { expandPipelineBlock } from "./pipeline-blocks";

describe("expandPipelineBlock", () => {
  test("expands flightdeck.threadInvocation as the four-field entry contract", () => {
    const expansion = expandPipelineBlock({ name: "accept", type: "block", block: "flightdeck.threadInvocation" });
    expect(expansion.steps[0]).toMatchObject({ type: "code", function: "flightdeck.threadInvocation" });
    expect(expansion.outputPath).toBe("$.flightDeckInvocation");
  });
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

  test("expands jev.rerankCandidates into bounded judgment and deterministic composition", () => {
    const expansion = expandPipelineBlock({
      name: "rerank-editorial-candidates",
      type: "block",
      block: "jev.rerankCandidates",
      input: { pick: { query: "$.brief", candidates: "$.candidates" } },
      assign: "$.rerank",
    });

    expect(expansion.outputPath).toBe("$.rerank");
    expect(expansion.steps.map((step) => step.type)).toEqual(["parallel", "code"]);
    expect(expansion.steps[0]).toMatchObject({ source: "$.blocks.rerank_editorial_candidates.input.candidates" });
    expect(expansion.steps[1]).toMatchObject({ function: "jev.composeRerank", assign: "$.rerank" });
  });

  test("expands flightdeck.sendDirectMessage into deterministic delivery", () => {
    const expansion = expandPipelineBlock({
      name: "send-result",
      type: "block",
      block: "flightdeck.sendDirectMessage",
      input: { pick: { fromNpub: "$.from", toNpub: "$.to", message: "$.message" } },
      assign: "$.delivery",
    });

    expect(expansion.outputPath).toBe("$.delivery");
    expect(expansion.steps).toHaveLength(1);
    expect(expansion.steps[0]).toMatchObject({
      type: "code",
      function: "flightdeck.sendDirectMessage",
      assign: "$.delivery",
    });
  });

  test("expands flightdeck.returnToThread with the standard routing envelope", () => {
    const expansion = expandPipelineBlock({
      name: "return-result",
      type: "block",
      block: "flightdeck.returnToThread",
      input: { pick: { workspaceId: "$.workspaceId", threadId: "$.threadId", frmNpub: "$.frmNpub", prompt: "$.prompt", message: "$.final" } },
      assign: "$.delivery",
    });

    expect(expansion.outputPath).toBe("$.delivery");
    expect(expansion.steps[0]).toMatchObject({
      type: "code",
      function: "flightdeck.returnToThread",
      assign: "$.delivery",
    });
  });
});
