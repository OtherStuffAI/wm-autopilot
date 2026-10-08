import { expect, test } from "bun:test";
import { scheduledPipelineLaunchOptions } from "./pipeline-launch-options";
import type { ScheduledJob } from "./scheduler-store";

test("passes saved signer to pipeline worker authority separately from engine/input", () => {
  const job = { botNpub: "npub-rick", agentId: "rick", pipelineAgent: "claude" } as ScheduledJob;
  expect(scheduledPipelineLaunchOptions(job, { subject: "moon", keep: true }, { subject: "mars", keep: null, agent: { profileId: "other", botNpub: "npub-other" } })).toEqual({
    input: { subject: "mars", keep: true, agent: { profileId: "other", botNpub: "npub-other" } },
    initiatingAgentNpub: "npub-rick",
  });
  expect(scheduledPipelineLaunchOptions({ ...job, agentId: null }, {}, {}).initiatingAgentNpub).toBe("npub-rick");
  expect(() => scheduledPipelineLaunchOptions({ ...job, botNpub: "" }, {}, {})).toThrow("Run as identity");
});
