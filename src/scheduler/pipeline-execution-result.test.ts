import { describe, expect, test } from "bun:test";

import { requireSuccessfulPipelineExecution } from "./pipeline-execution-result";

describe("requireSuccessfulPipelineExecution", () => {
  test("returns the run id for a successful pipeline", () => {
    expect(requireSuccessfulPipelineExecution({ id: "run-ok", status: "ok" })).toBe("run-ok");
  });

  test("retains the pipeline error when a run fails", () => {
    expect(() => requireSuccessfulPipelineExecution({
      id: "run-error",
      status: "error",
      error: "agent readiness failed",
    })).toThrow("Pipeline run run-error failed: agent readiness failed");
  });

  test("surfaces a non-success status when no explicit error exists", () => {
    expect(() => requireSuccessfulPipelineExecution({
      id: "run-needs-input",
      status: "needs_input",
    })).toThrow("Pipeline run run-needs-input failed: Pipeline finished with status needs_input");
  });
});
