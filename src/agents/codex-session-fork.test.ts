import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forkCodexSessionFile } from "./codex-session-fork";

describe("forkCodexSessionFile", () => {
  test("copies a Codex JSONL session to a new native session id", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-fork-test-"));
    try {
      const sourceId = "019f019d-717c-7131-a7de-36c139badd31";
      const sourceDir = join(codexHome, "sessions", "2026", "06", "26");
      const sourceFile = join(sourceDir, `rollout-2026-06-26T09-48-43-${sourceId}.jsonl`);
      await mkdir(sourceDir, { recursive: true });
      await writeFile(sourceFile, [
        JSON.stringify({
          timestamp: "2026-06-26T01:49:32.721Z",
          type: "session_meta",
          payload: {
            id: sourceId,
            timestamp: "2026-06-26T01:48:43.280Z",
            cwd: "/tmp/project",
            thread_source: "user",
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-26T01:50:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Original prompt" }],
          },
        }),
        "",
      ].join("\n"));

      const result = await forkCodexSessionFile({
        codexHome,
        sourceSessionId: sourceId,
        workingDirectory: "/tmp/project",
        now: new Date("2026-06-26T03:00:00.000Z"),
      });

      expect(result.sourceFilePath).toBe(sourceFile);
      expect(result.forkedSessionId).not.toBe(sourceId);
      expect(result.forkedFilePath).toContain(result.forkedSessionId);
      const forkedContent = await readFile(result.forkedFilePath, "utf8");
      const lines = forkedContent.trimEnd().split("\n");
      const meta = JSON.parse(lines[0]!);
      expect(meta.payload.id).toBe(result.forkedSessionId);
      expect(meta.payload.cwd).toBe("/tmp/project");
      expect(meta.payload.thread_source).toBe("fork");
      expect(forkedContent).toContain("Original prompt");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("rejects a source file from a different working directory", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-fork-test-"));
    try {
      const sourceId = "019f019d-717c-7131-a7de-36c139badd31";
      const sourceFile = join(
        codexHome,
        "sessions",
        "2026",
        "06",
        "26",
        `rollout-2026-06-26T09-48-43-${sourceId}.jsonl`,
      );
      await mkdir(join(codexHome, "sessions", "2026", "06", "26"), { recursive: true });
      await writeFile(sourceFile, `${JSON.stringify({
        timestamp: "2026-06-26T01:49:32.721Z",
        type: "session_meta",
        payload: {
          id: sourceId,
          cwd: "/tmp/other",
        },
      })}\n`);

      await expect(forkCodexSessionFile({
        codexHome,
        sourceSessionId: sourceId,
        workingDirectory: "/tmp/project",
      })).rejects.toThrow("Native Codex session file not found");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("does not fork an oversized rollout even when its filename contains the session id", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-fork-oversized-test-"));
    try {
      const sourceId = "oversized-source";
      const sourceDir = join(codexHome, "sessions", "2026", "08", "20");
      const sourceFile = join(sourceDir, `rollout-2026-08-20T00-00-00-${sourceId}.jsonl`);
      await mkdir(sourceDir, { recursive: true });
      await writeFile(sourceFile, `${JSON.stringify({
        type: "session_meta",
        payload: { id: sourceId, cwd: "/tmp/project" },
      })}\n`);
      await truncate(sourceFile, (50 * 1024 * 1024) + 1);

      await expect(forkCodexSessionFile({
        codexHome,
        sourceSessionId: sourceId,
        workingDirectory: "/tmp/project",
      })).rejects.toThrow("Native Codex session file not found");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
