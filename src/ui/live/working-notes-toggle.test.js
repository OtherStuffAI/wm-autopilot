import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { getWorkingNotesPanelKey, isWorkingNotesPanelOpen } from "./working-notes-toggle.js";

describe("working notes toggle integration", () => {
  test("keeps the panel key stable when reconciliation replaces the local row id", () => {
    const message = { id: 12, createdAt: "2026-08-08T01:00:00.000Z" };
    const reconciled = { ...message, id: 47 };

    expect(getWorkingNotesPanelKey("session-1", message)).toBe(
      getWorkingNotesPanelKey("session-1", reconciled),
    );
  });

  test("uses the requested default until the panel has remembered state", () => {
    expect(isWorkingNotesPanelOpen("unseen-thinking", true)).toBe(true);
    expect(isWorkingNotesPanelOpen("unseen-tools", false)).toBe(false);
  });

  test("exports and attaches the working notes double-click handler", () => {
    const indexSource = readFileSync(new URL("./index.js", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const toggleSource = readFileSync(new URL("./working-notes-toggle.js", import.meta.url), "utf8");

    expect(indexSource).toContain('export { attachWorkingNotesToggle } from "./working-notes-toggle.js";');
    expect(appSource).toContain("attachWorkingNotesToggle,");
    expect(appSource).toContain("attachWorkingNotesToggle();");
    expect(toggleSource).toContain("root.addEventListener('click'");
    expect(toggleSource).toContain("root.addEventListener('dblclick'");
    expect(toggleSource).toContain("root.addEventListener('toggle'");
    expect(toggleSource).toContain("panelOpenState.set(key, panel.open)");
    expect(toggleSource).toContain("message?.turnId ??");
    expect(toggleSource).toContain("message?.createdAt ??");
    expect(toggleSource).toContain("isWorkingNotesCloseControl(event.target)");
    expect(toggleSource).toContain("panel.open = true;");
    expect(toggleSource).toContain('.wm-message[data-role="agent-working"]');
    expect(toggleSource).toContain('.wm-message[data-role="agent-context"]');
  });
});
