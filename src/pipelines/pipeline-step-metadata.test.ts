import { describe, expect, test } from "bun:test";
import { buildPipelineStepMetadata } from "./pipeline-step-metadata";

describe("buildPipelineStepMetadata", () => {
  test("persists declarative display fields for run rendering", () => {
    const metadata = buildPipelineStepMetadata({
      name: "analyse-intent",
      description: "Analyse the hydrated thread.",
      type: "agent",
      prompt: "Return JSON.",
      input: { pick: { chatDispatchInput: "$.chatDispatchInput" } },
      assign: "$.agentDecision",
      display: {
        in: [
          { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages", limit: 5 },
        ],
        out: [
          { label: "Intent", path: "$.intent" },
        ],
      },
    });

    expect(metadata).toMatchObject({
      description: "Analyse the hydrated thread.",
      display: {
        in: [
          { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages", limit: 5 },
        ],
        out: [
          { label: "Intent", path: "$.intent" },
        ],
      },
    });
  });
});
