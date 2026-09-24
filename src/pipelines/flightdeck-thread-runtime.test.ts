import { describe, expect, test } from "bun:test";
import { createFlightDeckThreadRuntime } from "./flightdeck-thread-runtime";

const invocation = {
  workspaceId: "2e5caefd-dd65-45d2-b747-ee874e8e5fc9",
  threadId: "c87e026d-23c5-4fe9-b752-117f18cf4a10",
  frmNpub: "npub1requester",
  prompt: "Question",
};

function fixture(options: { workspaceId?: string; hasThread?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const runtime = createFlightDeckThreadRuntime({
    agentStore: { getByBotNpub: () => ({ enabled: true, archived: false, botNpub: "npub1managed" }) as never },
    subscriptionStore: { listAll: () => [{
      workspaceId: options.workspaceId ?? invocation.workspaceId,
      subscriptionId: "subscription-1",
      backendBaseUrl: "https://tower.test",
      sourceAppNpub: "npub1app",
      botNpub: "npub1managed",
      lifecycleStatus: "active",
      managedByNpub: "npub1owner",
    } as never] },
    withAgentIdentity: async (_agent, operation) => await operation({ botNpub: "npub1managed" } as never),
    fetchScopes: async () => ({ scopes: [{ id: "scope-1" }], next_cursor: null }),
    fetchChannels: async () => ({ channels: [{ id: "channel-1" }], next_cursor: null }),
    fetchMessages: async () => ({
      messages: options.hasThread === false ? [] : [{ id: invocation.threadId, channel_id: "channel-1" }],
      next_cursor: null,
    }),
    createMessage: async (input) => {
      created.push(input as unknown as Record<string, unknown>);
      return { message: { id: "message-1" } };
    },
  });
  return { runtime, created };
}

describe("Flight Deck thread runtime", () => {
  test("resolves and delivers to the exact thread as the managed agent", async () => {
    const { runtime, created } = fixture();
    const resolution = await runtime.resolve(invocation, "npub1owner");
    const result = await runtime.send({ ...invocation, message: "# Final answer" });

    expect(resolution).toEqual({
      workspaceId: invocation.workspaceId,
      threadId: invocation.threadId,
      channelId: "channel-1",
      senderNpub: "npub1managed",
    });
    expect(created[0]).toMatchObject({
      workspaceId: invocation.workspaceId,
      channelId: "channel-1",
      threadId: invocation.threadId,
      body: "# Final answer",
      botIdentity: { botNpub: "npub1managed" },
      metadata: { requester_npub: "npub1requester" },
    });
    expect(result).toMatchObject({
      delivered: true,
      messageId: "message-1",
      senderNpub: "npub1managed",
      requesterNpub: "npub1requester",
      signatureProtocol: "flightdeck_pg_message_instruction",
    });
  });

  test("rejects an unresolved workspace or thread", async () => {
    await expect(fixture({ workspaceId: "00000000-0000-4000-8000-000000000000" }).runtime.resolve(invocation)).rejects.toThrow("No active");
    await expect(fixture({ hasThread: false }).runtime.resolve(invocation)).rejects.toThrow("was not found");
  });
});
