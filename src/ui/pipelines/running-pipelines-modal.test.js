import { describe, expect, test } from "bun:test";

import {
  buildPipelineRunDetailFetchOptions,
  getActivePipelineRuns,
  getPipelineRunDisplayName,
  getPipelineStepSessionId,
  getRecentPipelineRunPage,
  getRecentPipelineRunPageCount,
  isActivePipelineRun,
  renderRunningPipelineAgentSessionLink,
  renderRunningPipelineStepTimeline,
} from "./running-pipelines-modal.js";

describe("running pipelines modal helpers", () => {
  test("requests step payloads for run detail display fields", () => {
    expect(buildPipelineRunDetailFetchOptions()).toEqual({
      includeRunPayload: false,
      includeStepPayload: true,
      forceFresh: false,
    });
    expect(buildPipelineRunDetailFetchOptions({ forceFresh: true })).toEqual({
      includeRunPayload: false,
      includeStepPayload: true,
      forceFresh: true,
    });
  });

  test("identifies active pipeline run statuses", () => {
    expect(isActivePipelineRun({ status: "queued" })).toBe(true);
    expect(isActivePipelineRun({ status: "running" })).toBe(true);
    expect(isActivePipelineRun({ status: "needs_input" })).toBe(false);
    expect(isActivePipelineRun({ status: "ok" })).toBe(false);
    expect(isActivePipelineRun({ status: "error" })).toBe(false);
    expect(isActivePipelineRun({ status: "cancelled" })).toBe(false);
  });

  test("lists only active pipeline runs", () => {
    const runs = [
      { id: "run-1", status: "running" },
      { id: "run-2", status: "ok" },
      { id: "run-3", status: "needs_input" },
      { id: "run-4", status: "error" },
      { id: "run-5", status: "cancelled" },
    ];

    expect(getActivePipelineRuns(runs).map((run) => run.id)).toEqual(["run-1"]);
  });

  test("pages recent pipeline runs five at a time", () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({ id: `run-${index + 1}` }));

    expect(getRecentPipelineRunPage(runs).map((run) => run.id)).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
      "run-5",
    ]);
    expect(getRecentPipelineRunPage(runs, 1).map((run) => run.id)).toEqual([
      "run-6",
      "run-7",
      "run-8",
      "run-9",
      "run-10",
    ]);
    expect(getRecentPipelineRunPage(runs, 2).map((run) => run.id)).toEqual(["run-11", "run-12"]);
    expect(getRecentPipelineRunPageCount(runs)).toBe(3);
  });

  test("keeps recent run paging safe for empty and invalid inputs", () => {
    expect(getRecentPipelineRunPage(null)).toEqual([]);
    expect(getRecentPipelineRunPageCount(null)).toBe(1);
    expect(getRecentPipelineRunPage([{ id: "run-1" }], -10).map((run) => run.id)).toEqual(["run-1"]);
    expect(getRecentPipelineRunPageCount([{ id: "run-1" }], 0)).toBe(1);
  });

  test("formats a stable display name", () => {
    expect(getPipelineRunDisplayName({ id: "run-1", name: "Review Loop" })).toBe("Review Loop");
    expect(getPipelineRunDisplayName({ id: "run-2", name: "   " })).toBe("run-2");
  });

  test("renders an agent session link for pipeline steps with sessions", () => {
    const step = { wingmanSessionId: "session with/slash" };

    expect(getPipelineStepSessionId(step)).toBe("session with/slash");

    const html = renderRunningPipelineAgentSessionLink(step);
    expect(html).toContain('href="/live/session%20with%2Fslash"');
    expect(html).toContain('aria-label="Open agent session session with/slash"');
    expect(html).toContain('data-testid="running-pipeline-agent-session-link"');
  });

  test("omits the agent session link when a step has no session id", () => {
    expect(getPipelineStepSessionId({ wingmanSessionId: "   " })).toBe(null);
    expect(renderRunningPipelineAgentSessionLink({ kind: "code" })).toBe("");
  });

  test("renders pipeline step cards and selected step detail for the quick modal", () => {
    const run = {
      id: "run-1",
      input: { prompt: "Build cards" },
      status: "running",
    };
    const steps = [{
      id: "step-1",
      stepIndex: 1,
      name: "Plan",
      kind: "agent",
      status: "running",
      input: { prompt: "Build cards" },
      output: { summary: "Cards ready" },
      result: { plan: { summary: "Cards ready" } },
      metadata: {
        description: "Plan the modal cards.",
        display: {
          in: [{ label: "Prompt", path: "$.prompt", format: "text" }],
          out: [{ label: "Summary", path: "$.summary", format: "text" }],
        },
        executor: { kind: "agent", agent: "codex" },
      },
    }];
    const html = renderRunningPipelineStepTimeline(run, steps, {
      step: steps[0],
      events: [],
      callbacks: [],
      previousSteps: [],
    });

    expect(html).toContain('data-testid="pipeline-step-card-timeline"');
    expect(html).toContain('data-testid="pipeline-step-card"');
    expect(html).toContain("<code>Prompt</code>");
    expect(html).toContain("<code>Summary</code>");
    expect(html).toContain('data-testid="running-pipeline-step-modal"');
    expect(html).toContain('data-testid="pipeline-step-detail"');
  });
});
