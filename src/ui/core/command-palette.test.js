import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  createCommandPaletteArchiveItem,
  createCommandPaletteLaunchItems,
  createCommandPaletteQuickItems,
  filterCommandPaletteItems,
  getCommandPaletteKeyboardItems,
  getCommandPaletteSessionEntries,
  getNextCommandPaletteActiveId,
  getRecentLaunchProjects,
  isCommandPaletteActiveSession,
  rememberRecentItem,
} from "./command-palette-utils.js";

const commandPaletteSource = readFileSync(new URL("./command-palette.js", import.meta.url), "utf8");

describe("autopilot command palette helpers", () => {
  test("keeps recent items newest first and unique", () => {
    const items = rememberRecentItem(
      [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
      ],
      { id: "b", title: "Beta updated", updatedAt: "2026-05-30T00:00:00.000Z" },
    );

    expect(items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(items[0].title).toBe("Beta updated");
  });

  test("filters commands across title subtitle group and search text", () => {
    const items = [
      { title: "New Session", subtitle: "Launch an agent", groupLabel: "Shortcuts" },
      { title: "App restart", subtitle: "Calendar", groupLabel: "Recent App Restarts" },
      { title: "Pipeline", subtitle: "Review", searchText: "workflow run" },
    ];

    expect(filterCommandPaletteItems(items, "agent").map((item) => item.title)).toEqual(["New Session"]);
    expect(filterCommandPaletteItems(items, "recent app").map((item) => item.title)).toEqual(["App restart"]);
    expect(filterCommandPaletteItems(items, "workflow").map((item) => item.title)).toEqual(["Pipeline"]);
  });

  test("keeps fixed shortcut keys stable and adds home", () => {
    expect(createCommandPaletteQuickItems()
      .filter((item) => item.shortcutKey)
      .map((item) => `${item.shortcutKey}:${item.title}`)).toEqual([
      "0:Home",
      "1:Sessions",
      "2:Apps",
      "3:Pipelines",
      "4:Files",
    ]);
    expect(createCommandPaletteQuickItems().map((item) => item.title)).not.toContain("Stop Pipeline Run");
  });

  test("passes existing file favourites into the command file browser", () => {
    expect(commandPaletteSource).toContain("favourites: state?.files?.favourites ?? []");
  });

  test("keeps the command search input mounted while typing", () => {
    expect(commandPaletteSource).toContain("render({ syncInputValue: false })");
    expect(commandPaletteSource).not.toContain("requestAnimationFrame(() => overlay?.querySelector(\"[data-command-palette-input]\")?.focus())");
  });

  test("builds launch items with modal on 0 and recent projects on 1-9", () => {
    const projects = Array.from({ length: 11 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      directoryPath: `/workspace/project-${index + 1}`,
    }));

    const items = createCommandPaletteLaunchItems(projects);

    expect(items.map((item) => `${item.shortcutKey}:${item.title}`)).toEqual([
      "0:New Session",
      "1:Project 1",
      "2:Project 2",
      "3:Project 3",
      "4:Project 4",
      "5:Project 5",
      "6:Project 6",
      "7:Project 7",
      "8:Project 8",
      "9:Project 9",
      ":Archive",
    ]);
    expect(items[0].action).toBe("open-session-modal");
    expect(items[1].action).toBe("launch-project-session");
    expect(items[9].targetId).toBe("project-9");
    expect(items[10].action).toBe("archive-sessions");
    expect(items[10].groupLabel).toBe("Archived Sessions");
  });

  test("builds an archive command for session lists", () => {
    expect(createCommandPaletteArchiveItem()).toEqual({
      group: "recent-session",
      groupLabel: "Recent Sessions",
      id: "recent-session:archive",
      title: "Archive",
      subtitle: "Filter archived sessions and resume from disk",
      action: "archive-sessions",
      shortcutKey: "",
      targetId: "",
      searchText: "archive archived sessions resume disk history",
    });
    expect(commandPaletteSource).toContain("showArchiveSessionsModal");
    expect(commandPaletteSource).toContain("resumeNativeSession");
  });

  test("launch projects require an id and directory", () => {
    const projects = [
      { id: "missing-directory", name: "Missing Directory" },
      { directoryPath: "/workspace/missing-id", name: "Missing Id" },
      { id: "valid", name: "Valid", directoryPath: "/workspace/valid" },
    ];

    expect(getRecentLaunchProjects(projects)).toEqual([
      { id: "valid", name: "Valid", directoryPath: "/workspace/valid" },
    ]);
  });

  test("recent session entries include every active session", () => {
    const sessions = [
      { id: "recent-running", name: "Recent Running", status: "running", workingDirectory: "/repo/recent" },
      { id: "inactive-recent", name: "Inactive Recent", status: "stopped", workingDirectory: "/repo/inactive" },
      { id: "active-not-recent", name: "Active Not Recent", status: "running", workingDirectory: "/repo/active" },
      { id: "runtime-active", name: "Runtime Active", status: "stopped", agentRuntimeStatus: "running", directory: "/repo/runtime" },
      { id: "inactive-hidden", name: "Inactive Hidden", status: "stopped", workingDirectory: "/repo/hidden" },
    ];

    const entries = getCommandPaletteSessionEntries(
      [{ id: "recent-running" }, { id: "inactive-recent" }],
      sessions,
      (session) => session.name,
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "recent-running",
      "inactive-recent",
      "active-not-recent",
      "runtime-active",
    ]);
    expect(entries.find((entry) => entry.id === "runtime-active")?.subtitle).toBe("/repo/runtime");
  });

  test("detects command palette active sessions", () => {
    expect(isCommandPaletteActiveSession({ status: "starting" })).toBe(true);
    expect(isCommandPaletteActiveSession({ status: "running" })).toBe(true);
    expect(isCommandPaletteActiveSession({ status: "stopped", agentRuntimeStatus: "running" })).toBe(true);
    expect(isCommandPaletteActiveSession({ status: "stopped", agentRuntimeStatus: "stable" })).toBe(false);
  });

  test("cycles active command ids with arrow navigation semantics", () => {
    const items = [
      { id: "home" },
      { id: "sessions" },
      { id: "apps" },
    ];

    expect(getNextCommandPaletteActiveId(items, "", 1)).toBe("home");
    expect(getNextCommandPaletteActiveId(items, "home", 1)).toBe("sessions");
    expect(getNextCommandPaletteActiveId(items, "apps", 1)).toBe("home");
    expect(getNextCommandPaletteActiveId(items, "", -1)).toBe("apps");
    expect(getNextCommandPaletteActiveId(items, "home", -1)).toBe("apps");
  });

  test("keyboard navigation prefers result items over shortcut hotkeys", () => {
    const items = [
      { id: "quick:home", group: "shortcut" },
      { id: "quick:sessions", group: "shortcut" },
      { id: "session:1", group: "recent-session" },
      { id: "app:1", group: "recent-app" },
    ];

    expect(getCommandPaletteKeyboardItems(items).map((item) => item.id)).toEqual([
      "session:1",
      "app:1",
    ]);
  });

  test("keyboard navigation falls back to shortcuts when no list items exist", () => {
    const items = [
      { id: "quick:home", group: "shortcut" },
      { id: "quick:sessions", group: "shortcut" },
    ];

    expect(getCommandPaletteKeyboardItems(items).map((item) => item.id)).toEqual([
      "quick:home",
      "quick:sessions",
    ]);
  });
});
