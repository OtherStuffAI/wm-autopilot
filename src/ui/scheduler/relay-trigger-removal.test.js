import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPageTemplate } from "./list-template.js";

const pageSource = () => readFileSync(join(import.meta.dir, "page.js"), "utf8") + getPageTemplate();

describe("scheduler relay trigger UI removal", () => {
  test("does not offer relay triggers and clearly renders historical unsupported jobs", () => {
    const source = pageSource();
    expect(source).not.toContain("kind 9256");
    expect(source).not.toContain("triggerType = 'nostr'");
    expect(source).not.toContain("editTriggerType = 'nostr'");
    expect(source).toContain("job.triggerType === 'unsupported'");
    expect(source).toContain("job.unsupportedReason");
  });

  test("offers model and directory controls without Night Watchman", () => {
    const source = pageSource();
    expect(source).toContain('data-testid="scheduler-create-model"');
    expect(source).toContain('data-testid="scheduler-edit-model"');
    expect(source).toContain('data-testid="scheduler-create-working-directory-browse"');
    expect(source).toContain('data-testid="scheduler-create-watch-directory-browse"');
    expect(source).not.toContain("Night Watchman");
    expect(source).not.toContain("nightwatchmanEnabled");
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
