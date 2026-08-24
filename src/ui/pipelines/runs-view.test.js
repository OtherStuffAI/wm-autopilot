import { describe, expect, test } from "bun:test";

import { renderRunsWorkspace, renderStepDetail } from "./runs-view.js";
import { renderJsonBlock } from "./view-utils.js";

function makeState() {
  return {
    runs: [],
    runSearch: "",
    runFilter: "all",
    selectedRunTab: "overview",
    selectedRun: {
      run: {
        id: "run-1",
        name: "Pipeline run",
        status: "ok",
        input: { prompt: "same" },
        result: { prompt: "same", summary: "new output" },
        startedAt: "2026-05-01T01:00:00.000Z",
        completedAt: "2026-05-01T01:01:00.000Z",
      },
      steps: [
        {
          id: "step-1",
          stepIndex: 1,
          name: "Extract summary",
          kind: "agent",
          status: "ok",
          input: { prompt: "same" },
          output: { summary: "new output" },
          result: { prompt: "same", summary: "new output" },
          wingmanSessionId: "session-1",
        },
      ],
    },
    selectedStep: {
      step: {
        id: "step-1",
        name: "Extract summary",
        status: "ok",
        stepIndex: 1,
        input: { prompt: "same" },
        output: { summary: "new output" },
        result: { prompt: "same", summary: "new output" },
        wingmanSessionId: "session-1",
      },
      events: [],
      callbacks: [],
      previousSteps: [],
    },
  };
}

function makeErroredState() {
  const state = makeState();
  state.selectedRun.run.status = "error";
  state.selectedRun.run.error = "temporary failure";
  state.selectedRun.run.completedAt = "2026-05-01T01:01:00.000Z";
  return state;
}

function makeRunningState() {
  const state = makeState();
  state.selectedRun.run.status = "running";
  state.selectedRun.run.completedAt = null;
  state.cancellingRunId = null;
  return state;
}

describe("pipeline run detail rendering", () => {
  test("renders selected step details in a full screen modal", () => {
    const html = renderRunsWorkspace(makeState());

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-testid="pipeline-step-modal"');
    expect(html).toContain('data-action="close-step-detail"');
  });

  test("renders step cards as the default run overview", () => {
    const html = renderRunsWorkspace(makeState());

    expect(html).toContain('data-testid="pipeline-step-card-timeline"');
    expect(html).toContain('data-testid="pipeline-step-card"');
    expect(html).toContain("Fields In");
    expect(html).toContain("Fields Out");
    expect(html).toContain("<code>prompt</code>");
    expect(html).toContain("<code>summary</code>");
  });

  test("renders state ledger tab from recorded state writes", () => {
    const state = makeState();
    state.selectedRunTab = "ledger";
    const html = renderRunsWorkspace(state);

    expect(html).toContain('data-testid="pipeline-state-ledger"');
    expect(html).toContain('data-testid="pipeline-ledger-row"');
    expect(html).toContain("$.summary");
    expect(html).toContain("Extract summary");
  });

  test("keeps source input and raw output collapsed below the transform", () => {
    const html = renderRunsWorkspace(makeState());

    expect(html).toContain('data-testid="pipeline-transform-block"');
    expect(html).toContain('class="wm-pipeline-step-data-panel"');
    expect(html).toContain("<summary>Input</summary>");
    expect(html).toContain("<summary>Raw output</summary>");
    expect(html).toContain("<summary>State after step</summary>");
    expect(html).not.toContain('<details class="wm-pipeline-step-data-panel" open');
  });

  test("offers manual resume only for errored runs", () => {
    const okHtml = renderRunsWorkspace(makeState());
    const errorHtml = renderRunsWorkspace(makeErroredState());

    expect(okHtml).not.toContain('data-action="resume-run-from-failure"');
    expect(errorHtml).toContain('data-action="resume-run-from-failure"');
    expect(errorHtml).toContain("Resume from Failed Step");
  });

  test("offers stop only for active runs", () => {
    const okHtml = renderRunsWorkspace(makeState());
    const runningHtml = renderRunsWorkspace(makeRunningState());

    expect(okHtml).not.toContain('data-action="cancel-run"');
    expect(runningHtml).toContain('data-action="cancel-run"');
    expect(runningHtml).toContain('data-testid="pipeline-cancel-run-action"');
    expect(runningHtml).toContain("Stop Run");
  });

  test("formats agent transform text only when the flag is enabled", () => {
    const state = makeState();
    state.selectedStep.step.kind = "agent";
    state.selectedStep.step.output = {
      summary: "Cleartext should be\n  only relay-safe classification.",
    };
    state.selectedStep.step.result = {
      prompt: "same",
      summary: "Cleartext should be\n  only relay-safe classification.",
    };

    const rawHtml = renderStepDetail(state);
    const formattedHtml = renderStepDetail({
      ...state,
      agentOutputFormattingEnabled: true,
    });

    expect(rawHtml).not.toContain("Cleartext should be only relay-safe classification.");
    expect(formattedHtml).toContain("Cleartext should be only relay-safe classification.");
    expect(formattedHtml).toContain("<summary>Raw output</summary>");
  });

  test("renders prompt-like scalar strings as readable text blocks", () => {
    const html = renderJsonBlock("Value", "Please dispatch a software pipeline to implement the selected document and preserve the full prompt for inspection.");

    expect(html).toContain("wm-pipeline-json-text");
    expect(html).toContain("Please dispatch a software pipeline");
    expect(html).not.toContain("wm-pipeline-json-value-string");
  });
});
