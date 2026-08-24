import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManualDefinitionVersion } from "./definition-editor";
import type { PipelineDefinitionRecord } from "./pipeline-loader";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wingmen-definition-editor-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("manual pipeline definition edits", () => {
  test("writes a new versioned declaration with edited fields", async () => {
    mkdirSync(tempDir, { recursive: true });
    const sourcePath = join(tempDir, "content-review.v2.json");
    writeFileSync(sourcePath, "{}\n");

    const result = await writeManualDefinitionVersion(makeDefinition(sourcePath), {
      name: "Edited Content Review",
      description: "Updated by hand.",
      default: true,
      tags: ["Review", "content", "review"],
      input: { documentUrl: "file.md" },
      steps: [{ name: "critic-pass", type: "agent", prompt: "Review it." }],
    });

    expect(result.targetPath).toBe(join(tempDir, "content-review.v3.json"));
    const spec = JSON.parse(await readFile(result.targetPath, "utf8"));
    expect(spec.name).toBe("Edited Content Review");
    expect(spec.description).toBe("Updated by hand.");
    expect(spec.version).toBe(3);
    expect(spec.supersedes).toBe("content-review.v2.json");
    expect(spec.default).toBe(true);
    expect(spec.tags).toEqual(["content", "review"]);
    expect(spec.input).toEqual({ documentUrl: "file.md" });
    expect(spec.steps).toHaveLength(1);
  });

  test("rejects invalid edited steps", async () => {
    mkdirSync(tempDir, { recursive: true });
    const sourcePath = join(tempDir, "content-review.v1.json");
    writeFileSync(sourcePath, "{}\n");

    await expect(writeManualDefinitionVersion(makeDefinition(sourcePath), {
      name: "Bad Edit",
      input: {},
      steps: [{ type: "agent", prompt: "Missing name." }],
    })).rejects.toThrow("steps[0].name is required");
  });
});

function makeDefinition(path: string): PipelineDefinitionRecord {
  return {
    id: "definition-id",
    slug: "content-review.v2",
    name: "Content Review",
    scope: "user",
    ownerAlias: "tester",
    path,
    spec: {
      name: "Content Review",
      version: 2,
      input: { documentUrl: "draft.md" },
      steps: [{ name: "critic-pass", type: "agent", prompt: "Review." }],
    },
  };
}
