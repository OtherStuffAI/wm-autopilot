import { describe, expect, test } from "bun:test";
import { buildPipelineAnalysisPrompt } from "./pipeline-analysis";

describe("pipeline analysis prompt", () => {
  test("includes run, definition, and related-run references", () => {
    const prompt = buildPipelineAnalysisPrompt({
      callbackOrigin: "http://localhost:3600",
      definition: {
        id: "shared:review-loop",
        slug: "review-loop",
        name: "Review Loop",
        path: "/Users/example/.wingmen/pipelines/shared/definitions/review-loop.json",
        scope: "shared",
        ownerAlias: null,
        spec: {
          name: "Review Loop",
          steps: [],
        },
      },
      run: {
        id: "run-1",
        definitionId: "shared:review-loop",
        definitionPath: "/Users/example/.wingmen/pipelines/shared/definitions/review-loop.json",
        name: "Review Loop",
        status: "error",
        ownerNpub: "npub1viewer",
        ownerAlias: "viewer-alias",
        scope: "shared",
        input: {},
        current: {},
        cursorIndex: 2,
        activeStepId: null,
        result: null,
        error: "Step failed",
        startedAt: "2026-05-01T01:00:00.000Z",
        completedAt: "2026-05-01T01:01:00.000Z",
      },
      steps: [
        {
          id: "step-1",
          runId: "run-1",
          stepIndex: 0,
          name: "Inspect",
          kind: "agent",
          status: "error",
          error: "Agent failed",
          wingmanSessionId: "session-1",
          parentStepId: null,
          logicalKey: null,
          callbackToken: null,
          metadata: null,
          startedAt: "2026-05-01T01:00:00.000Z",
          completedAt: "2026-05-01T01:01:00.000Z",
          inputBytes: 2,
          resultBytes: 2,
          outputBytes: 2,
          hasInput: true,
          hasResult: true,
          hasOutput: true,
        },
      ],
    });

    expect(prompt).toContain("run-1");
    expect(prompt).toContain("shared:review-loop");
    expect(prompt).toContain("/api/pipelines/runs/run-1?includePayload=1");
    expect(prompt).toContain("Other runs from this pipeline");
    expect(prompt).toContain("filter for definitionId=\"shared:review-loop\"");
    expect(prompt).toContain("/api/pipelines/definitions/shared%3Areview-loop");
    expect(prompt).toContain("/Users/example/.wingmen/pipelines/shared/definitions/review-loop.json");
  });
});
