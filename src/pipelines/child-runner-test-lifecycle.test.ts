import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as runner from "./pipeline-runner";
import { cleanupChildRunnerFixture, observeChildRunnerLifecycle } from "./child-runner-test-lifecycle";

test("failed resumed execution restores globals and preserves its fixture", async () => {
  const originalStart = runner.startDeclarativePipeline;
  const originalResume = runner.resumeDeclarativePipeline;
  const previousRoot = process.env.WINGMEN_PIPELINES_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "child-cleanup-failure-"));
  const failure = new Error("Deliberate storage read failure");
  const lifecycle = observeChildRunnerLifecycle();
  process.env.WINGMEN_PIPELINES_ROOT = dir;
  try {
    const pending = runner.resumeDeclarativePipeline({ store: { getRun() { throw failure; } } } as never, "failed-child");
    await expect(pending).rejects.toBe(failure);
    await expect(cleanupChildRunnerFixture(lifecycle, () => {
      if (previousRoot === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
      else process.env.WINGMEN_PIPELINES_ROOT = previousRoot;
    }, () => rmSync(dir, { recursive: true, force: true }))).rejects.toBe(failure);
    expect(runner.startDeclarativePipeline).toBe(originalStart);
    expect(runner.resumeDeclarativePipeline).toBe(originalResume);
    expect(process.env.WINGMEN_PIPELINES_ROOT).toBe(previousRoot);
    expect(existsSync(dir)).toBe(true);
    const next = observeChildRunnerLifecycle();
    try { await next.drain(); } finally { next.restore(); }
    expect(runner.startDeclarativePipeline).toBe(originalStart);
    expect(runner.resumeDeclarativePipeline).toBe(originalResume);
  } finally {
    lifecycle.restore();
    if (previousRoot === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
    else process.env.WINGMEN_PIPELINES_ROOT = previousRoot;
    rmSync(dir, { recursive: true, force: true });
  }
});
