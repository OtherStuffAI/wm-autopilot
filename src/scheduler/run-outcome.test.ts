import { expect, test } from "bun:test";
import { describeSchedulerRun } from "./run-outcome";

test("launch and historical session success never certify completion or delivery", () => {
  for (const status of ["launched", "success"] as const) {
    expect(describeSchedulerRun({ status, sessionId: "session", pipelineRunId: null })).toMatchObject({
      statusLabel: status === "success" ? "Launched (legacy)" : "Launched", deliveryStatus: "unverified",
    });
  }
});
test("pipeline runtime completion leaves delivery unverified; cleanup has no delivery", () => {
  expect(describeSchedulerRun({ status: "success", sessionId: null, pipelineRunId: "pipeline" })).toMatchObject({
    statusLabel: "Runtime complete", deliveryStatus: "unverified",
  });
  expect(describeSchedulerRun({ status: "success", sessionId: null, pipelineRunId: null }).deliveryStatus).toBe("not_applicable");
});
