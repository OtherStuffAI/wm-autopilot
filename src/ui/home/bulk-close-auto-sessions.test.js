import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./bulk-close-auto-sessions.js", import.meta.url), "utf8");
const liveAgentsSource = readFileSync(new URL("./live-agents.js", import.meta.url), "utf8");

describe("Close > 21 control", () => {
  test("is adjacent to Launch Agent Session and exposes accessible confirmation and status", () => {
    const launchIndex = liveAgentsSource.indexOf("actions.append(launchBtn)");
    const closeIndex = liveAgentsSource.indexOf("actions.append(createBulkCloseAutoSessionsButton", launchIndex);
    const refreshIndex = liveAgentsSource.indexOf("actions.append(refreshBtn)", closeIndex);
    expect(launchIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(launchIndex);
    expect(refreshIndex).toBeGreaterThan(closeIndex);
    expect(source).toContain('button.textContent = "Close > 21"');
    expect(source).toContain('button.dataset.testid = "close-stale-auto-sessions"');
    expect(source).toContain('button.setAttribute("aria-label"');
    expect(source).toContain("await confirmClose");
    expect(source).toContain("eligible, ${closed} closed, ${skipped} skipped, ${failed} failed");
  });
});
