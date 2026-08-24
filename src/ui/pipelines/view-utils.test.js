import { describe, expect, test } from "bun:test";

import { buildOutputDiff, collectTags, renderJsonBlock, renderJsonTransformBlock, renderTagPills } from "./view-utils.js";

describe("pipeline JSON rendering", () => {
  test("renders objects as expandable tree nodes", () => {
    const html = renderJsonBlock("Input", {
      prompt: "Review this",
      nested: { status: "ok" },
      items: [1, 2],
    });

    expect(html).toContain('data-testid="pipeline-json-tree"');
    expect(html).toContain("wm-pipeline-json-branch");
    expect(html).toContain("nested");
    expect(html).toContain("2 items");
    expect(html).not.toContain("<pre>");
  });

  test("renders multiline strings as numbered text lines", () => {
    const html = renderJsonBlock("Output", {
      content: "first line\nsecond line",
    });

    expect(html).toContain("wm-pipeline-json-text");
    expect(html).toContain('data-lines="2"');
    expect(html).toContain("first line");
    expect(html).toContain("second line");
  });

  test("renders top-level undefined as a scalar value", () => {
    const html = renderJsonBlock("Value", undefined);

    expect(html).toContain("undefined");
    expect(html).not.toContain("0 fields");
  });

  test("builds an output-only diff that omits carried forward values", () => {
    const diff = buildOutputDiff(
      {
        prompt: "same prompt",
        profile: { name: "Example Operator", status: "draft" },
        tags: ["one", "two"],
      },
      {
        prompt: "same prompt",
        profile: { name: "Example Operator", status: "ready" },
        tags: ["one", "three"],
        summary: "new output",
      },
    );

    expect(diff.changed).toBe(true);
    expect(diff.value).toEqual({
      profile: { status: "ready" },
      tags: { 1: "three" },
      summary: "new output",
    });
  });

  test("renders a clean transform area for changed output fields", () => {
    const html = renderJsonTransformBlock(
      { unchanged: "carried", text: "old" },
      { unchanged: "carried", text: "line one\nline two" },
    );

    expect(html).toContain('data-testid="pipeline-transform-block"');
    expect(html).toContain("New and changed output data");
    expect(html).toContain("line one");
    expect(html).toContain("line two");
    expect(html).not.toContain("carried");
  });

  test("normalises and renders pipeline tags", () => {
    expect(collectTags([{ tags: ["software", "Default"] }, { tags: ["review", "software"] }])).toEqual([
      "default",
      "review",
      "software",
    ]);
    expect(renderTagPills(["software"])).toContain("wm-pipeline-tag");
  });
});
