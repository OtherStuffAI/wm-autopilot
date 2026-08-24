import { describe, expect, test } from "bun:test";

import {
  renderHumanInspectionValue,
  serializeInspectionValue,
} from "./value-inspector.js";

describe("pipeline value inspector", () => {
  test("renders prompt objects as readable human fields", () => {
    const html = renderHumanInspectionValue({
      prompt: "This is the prompt that was used when we kicked off the work.\n\nIt is formatted like a human might read it.",
      working_dir: "~/code/wingmanbefree/wm-fd-2",
      instructions: {
        goal: "Implement the selected document.",
        guardrails: "Keep the prompt readable when inspected.",
      },
    });

    expect(html).toContain('data-testid="pipeline-human-fields"');
    expect(html).toContain("<h4>Prompt</h4>");
    expect(html).toContain("<p>This is the prompt that was used when we kicked off the work.</p>");
    expect(html).toContain("<p>It is formatted like a human might read it.</p>");
    expect(html).toContain("<h4>Working Dir</h4>");
    expect(html).toContain("~/code/wingmanbefree/wm-fd-2");
    expect(html).toContain("<span>Instructions</span>");
    expect(html).toContain("<small>2 fields</small>");
    expect(html).toContain("<h4>Goal</h4>");
    expect(html).toContain("Implement the selected document.");
  });

  test("renders strings as prose instead of JSON strings", () => {
    const html = renderHumanInspectionValue("Line one\n\nLine two");

    expect(html).toContain("<h4>Value</h4>");
    expect(html).toContain("<p>Line one</p>");
    expect(html).toContain("<p>Line two</p>");
    expect(html).not.toContain("wm-pipeline-json-tree");
  });

  test("serializes undefined explicitly for clickable values", () => {
    const encoded = serializeInspectionValue(undefined);

    expect(decodeURIComponent(encoded)).toContain("__pipelineValueType");
    expect(decodeURIComponent(encoded)).toContain("undefined");
  });
});
