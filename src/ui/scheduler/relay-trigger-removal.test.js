import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("scheduler relay trigger UI removal", () => {
  test("does not offer relay triggers and clearly renders historical unsupported jobs", () => {
    const pageSource = readFileSync(join(import.meta.dir, "page.js"), "utf8");
    expect(pageSource).not.toContain("kind 9256");
    expect(pageSource).not.toContain("triggerType = 'nostr'");
    expect(pageSource).not.toContain("editTriggerType = 'nostr'");
    expect(pageSource).toContain("job.triggerType === 'unsupported'");
    expect(pageSource).toContain("job.unsupportedReason");
  });

  test("offers model and directory controls without Night Watchman", () => {
    const pageSource = readFileSync(join(import.meta.dir, "page.js"), "utf8");
    expect(pageSource).toContain('data-testid="scheduler-create-model"');
    expect(pageSource).toContain('data-testid="scheduler-edit-model"');
    expect(pageSource).toContain('data-testid="scheduler-create-working-directory-browse"');
    expect(pageSource).toContain('data-testid="scheduler-create-watch-directory-browse"');
    expect(pageSource).not.toContain("Night Watchman");
    expect(pageSource).not.toContain("nightwatchmanEnabled");
  });

  test("CLI trigger types are limited to schedule and file watcher", () => {
    const cliSource = readFileSync(join(import.meta.dir, "../../../clis/scheduler.ts"), "utf8");
    expect(cliSource).toContain("type TriggerType = 'cron' | 'file_watcher'");
    expect(cliSource).not.toContain("| 'nostr'");
    expect(cliSource).toContain("Nostr relay triggers are unsupported");
    expect(cliSource).toContain("--model <model>");
    expect(cliSource).not.toContain("--nightwatch");
  });
});
