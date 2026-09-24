import { describe, expect, test } from "bun:test";
import { createPipelineDirectMessageSender } from "./direct-message-runtime";

describe("createPipelineDirectMessageSender", () => {
  test("rejects a sender that is not an active Autopilot agent", async () => {
    const send = createPipelineDirectMessageSender({
      agentStore: { getByBotNpub: () => null },
      subscriptionStore: { listAll: () => [] },
      withAgentIdentity: async () => {
        throw new Error("identity resolution must not run");
      },
    });

    expect(send({
      fromNpub: "npub1notanagent",
      toNpub: "npub1recipient",
      message: "Hello",
    })).rejects.toThrow("fromNpub is not an active Autopilot agent");
  });
});
