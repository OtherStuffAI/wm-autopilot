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

  test("uses the durable initiating agent instead of requester or workspace default for final signing", async () => {
    const signers: string[] = [];
    const runtime = createFlightDeckThreadRuntime({
      agentStore: { getByBotNpub: (npub) => ({ enabled: true, archived: false, botNpub: npub }) as never },
      subscriptionStore: { listAll: () => ['npub1default', 'npub1pipe'].map((botNpub, index) => ({
        workspaceId: invocation.workspaceId, subscriptionId: `subscription-${index}`, backendBaseUrl: 'https://tower.test',
        sourceAppNpub: 'npub1app', botNpub, lifecycleStatus: 'active', managedByNpub: 'npub1owner',
      })) as never },
      resolveTrustedAgentNpub: (runId) => runId === 'run-1' ? 'npub1pipe' : null,
      withAgentIdentity: async (agent, operation) => { signers.push(agent.botNpub); return await operation({ botNpub: agent.botNpub } as never); },
      fetchScopes: async () => ({ scopes: [{ id: 'scope-1' }], next_cursor: null }),
      fetchChannels: async () => ({ channels: [{ id: 'channel-1' }], next_cursor: null }),
      fetchMessages: async () => ({ messages: [{ id: invocation.threadId }], next_cursor: null }),
      createMessage: async () => ({ message: { id: 'message-1' } }),
    });
    await runtime.send({ ...invocation, pipelineRunId: 'run-1', message: 'Answer' });
    expect(signers).toEqual(['npub1pipe']);
  });

  test("rejects an unresolved workspace or thread", async () => {
    await expect(fixture({ workspaceId: "00000000-0000-4000-8000-000000000000" }).runtime.resolve(invocation)).rejects.toThrow("No active");
    await expect(fixture({ hasThread: false }).runtime.resolve(invocation)).rejects.toThrow("was not found");
  });

  test("continues scanning after a channel reports thread_not_found", async () => {
    const scannedChannels: string[] = [];
    const { runtime } = fixtureWithChannels(async (input) => {
      scannedChannels.push(input.channelId);
      if (input.channelId === "channel-1") throw towerError(404, "thread_not_found", "Flight Deck PG thread not found in this channel");
      return { messages: [{ id: invocation.threadId, channel_id: input.channelId }], next_cursor: null };
    });

    await expect(runtime.resolve(invocation)).resolves.toMatchObject({ channelId: "channel-2" });
    expect(scannedChannels).toEqual(["channel-1", "channel-2"]);
  });

  test("reports a workspace-level error after every channel misses", async () => {
    const scannedChannels: string[] = [];
    const { runtime } = fixtureWithChannels(async (input) => {
      scannedChannels.push(input.channelId);
      throw towerError(404, "thread_not_found", "Flight Deck PG thread not found in this channel");
    });

    await expect(runtime.resolve(invocation)).rejects.toThrow(
      `Thread ${invocation.threadId} was not found in workspace ${invocation.workspaceId}`,
    );
    expect(scannedChannels).toEqual(["channel-1", "channel-2"]);
  });

  test("propagates non-404 Tower errors without scanning later channels", async () => {
    const towerFailure = towerError(403, "flightdeck_pg_forbidden", "Not allowed to read this channel");
    const scannedChannels: string[] = [];
    const { runtime } = fixtureWithChannels(async (input) => {
      scannedChannels.push(input.channelId);
      throw towerFailure;
    });

    await expect(runtime.resolve(invocation)).rejects.toBe(towerFailure);
    expect(scannedChannels).toEqual(["channel-1"]);
  });
});

function fixtureWithChannels(fetchMessages: NonNullable<Parameters<typeof createFlightDeckThreadRuntime>[0]["fetchMessages"]>) {
  const runtime = createFlightDeckThreadRuntime({
    agentStore: { getByBotNpub: () => ({ enabled: true, archived: false, botNpub: "npub1managed" }) as never },
    subscriptionStore: { listAll: () => [{
      workspaceId: invocation.workspaceId,
      subscriptionId: "subscription-1",
      backendBaseUrl: "https://tower.test",
      sourceAppNpub: "npub1app",
      botNpub: "npub1managed",
      lifecycleStatus: "active",
      managedByNpub: "npub1owner",
    } as never] },
    withAgentIdentity: async (_agent, operation) => await operation({ botNpub: "npub1managed" } as never),
    fetchScopes: async () => ({ scopes: [{ id: "scope-1" }], next_cursor: null }),
    fetchChannels: async () => ({
      channels: [{ id: "channel-1" }, { id: "channel-2" }],
      next_cursor: null,
    }),
    fetchMessages,
  });
  return { runtime };
}

function towerError(status: number, detailCode: string, message: string): Error {
  return Object.assign(new Error(message), { status, detailCode });
}
