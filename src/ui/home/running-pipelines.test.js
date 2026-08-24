import { describe, expect, test } from "bun:test";

import {
  getHomePipelineRows,
  getHomePipelineSections,
  getHomeRunningPipelineRows,
} from "./running-pipelines.js";

describe("home running pipelines", () => {
  test("keeps only active pipeline runs", () => {
    const rows = getHomeRunningPipelineRows([
      { id: "run-1", name: "Task Dispatch", status: "running", definitionSlug: "task-dispatch" },
      { id: "run-2", name: "Done", status: "ok", definitionSlug: "done" },
      { id: "run-3", name: "Needs Input", status: "needs_input", definitionId: "do-and-review" },
      { id: "run-4", name: "Failed", status: "error", definitionSlug: "failed" },
    ]);

    expect(rows.map((row) => row.id)).toEqual(["run-1"]);
    expect(rows[0]).toMatchObject({
      name: "Task Dispatch",
      status: "running",
      statusLabel: "Running",
      definitionLabel: "task-dispatch",
    });
  });

  test("falls back to stable run labels", () => {
    const rows = getHomeRunningPipelineRows([
      { id: "run-empty-name", name: "   ", status: "queued" },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "run-empty-name",
      definitionLabel: "pipeline",
      statusLabel: "Queued",
    });
  });

  test("separates active runs from historical runs", () => {
    const sections = getHomePipelineSections([
      { id: "run-1", name: "Running", status: "running", definitionSlug: "active" },
      { id: "run-2", name: "Complete", status: "ok", definitionSlug: "done" },
      { id: "run-3", name: "Needs Input", status: "needs_input", definitionId: "review" },
      { id: "run-4", name: "Queued", status: "queued", definitionSlug: "queued" },
    ]);

    expect(sections.active.map((row) => row.id)).toEqual(["run-1", "run-4"]);
    expect(sections.history.map((row) => row.id)).toEqual(["run-2", "run-3"]);
    expect(sections.history[0]).toMatchObject({
      name: "Complete",
      statusLabel: "Complete",
      definitionLabel: "done",
    });
  });

  test("caps recent historical pipeline rows", () => {
    const rows = getHomePipelineRows([
      { id: "run-active", name: "Active", status: "running" },
      { id: "run-history-1", name: "History 1", status: "ok" },
      { id: "run-history-2", name: "History 2", status: "error" },
      { id: "run-history-3", name: "History 3", status: "cancelled" },
    ], { recentHistoryLimit: 2 });

    expect(rows.map((row) => [row.section, row.id])).toEqual([
      ["Running", "run-active"],
      ["Recent History", "run-history-1"],
      ["Recent History", "run-history-2"],
    ]);
  });
});
