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
    agentStore: { getByBotNpub: () => ({ agentId: "managed", managedByNpub: "npub1owner", enabled: true, archived: false, botNpub: "npub1managed" }) as never },
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
    fetchChannels: async () => ({ channels: [{ scope_id: "scope-1", id: "channel-1" }], next_cursor: null }),
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
      scopeId: "scope-1",
      senderNpub: "npub1managed",
      towerServiceNpub: null, appNpub: "npub1app", agentProfileId: "managed",
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

  test("uses an addressed agent profile linked to a shared app subscription", async () => {
    const sharedSubscription = {
      workspaceId: invocation.workspaceId,
      subscriptionId: 'subscription-shared',
      backendBaseUrl: 'https://tower.test',
      sourceAppNpub: 'npub1sharedapp',
      botNpub: 'npub1default',
      lifecycleStatus: 'active',
      managedByNpub: 'npub1owner',
    } as never;
    const signers: string[] = [];
    const runtime = createFlightDeckThreadRuntime({
      agentStore: {
        getByBotNpub: (npub) => ({
          agentId: npub === 'npub1piper' ? 'piper' : 'rick',
          enabled: true,
          archived: false,
          botNpub: npub,
          managedByNpub: 'npub1owner',
        }) as never,
      },
      profileStore: {
        listWorkspacesForProfile: (profileId) => profileId === 'piper' ? [{
          profileId: 'piper',
          managedByNpub: 'npub1owner',
          subscriptionId: 'subscription-shared',
          workspaceId: invocation.workspaceId,
        } as never] : [],
      },
      subscriptionStore: { listAll: () => [sharedSubscription] },
      resolveTrustedAgentNpub: () => 'npub1piper',
      withAgentIdentity: async (agent, operation) => {
        signers.push(agent.botNpub);
        return await operation({ botNpub: agent.botNpub } as never);
      },
      fetchChannels: async () => ({ channels: [{ id: 'channel-1' }], next_cursor: null }),
      fetchMessages: async () => ({ messages: [{ id: invocation.threadId }], next_cursor: null }),
      createMessage: async () => ({ message: { id: 'message-1' } }),
    });

    await runtime.send({
      ...invocation,
      pipelineRunId: 'run-1',
      scopeId: 'scope-1',
      channelId: 'channel-1',
      message: 'Answer',
    });

    expect(signers).toEqual(['npub1piper']);
  });

  test("rejects ambiguous active subscriptions linked to an addressed agent profile", async () => {
    const runtime = createFlightDeckThreadRuntime({
      agentStore: {
        getByBotNpub: (npub) => ({ agentId: 'piper', enabled: true, archived: false, botNpub: npub, managedByNpub: 'npub1owner' }) as never,
      },
      profileStore: {
        listWorkspacesForProfile: () => ['subscription-1', 'subscription-2'].map((subscriptionId) => ({
          profileId: 'piper', managedByNpub: 'npub1owner', subscriptionId, workspaceId: invocation.workspaceId,
        })) as never,
      },
      subscriptionStore: { listAll: () => ['subscription-1', 'subscription-2'].map((subscriptionId) => ({
        workspaceId: invocation.workspaceId, subscriptionId, backendBaseUrl: 'https://tower.test',
        sourceAppNpub: 'npub1sharedapp', botNpub: 'npub1default', lifecycleStatus: 'active', managedByNpub: 'npub1owner',
      })) as never },
      resolveTrustedAgentNpub: () => 'npub1piper',
      withAgentIdentity: async (_agent, operation) => await operation({ botNpub: 'npub1piper' } as never),
    });

    await expect(runtime.send({ ...invocation, pipelineRunId: 'run-1', message: 'Answer' })).rejects.toThrow(
      `Trusted agent npub1piper does not resolve one active subscription for workspace ${invocation.workspaceId}`,
    );
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
      channels: [{ scope_id: "scope-1", id: "channel-1" }, { id: "channel-2" }],
      next_cursor: null,
    }),
    fetchMessages,
  });
  return { runtime };
}

function towerError(status: number, detailCode: string, message: string): Error {
  return Object.assign(new Error(message), { status, detailCode });
}

test("wrong requested owner never resolves a foreign subscription or invokes identity/Tower", async () => {
  const { runtime } = fixture();
  await expect(runtime.resolve(invocation, "npub1wrong-owner")).rejects.toThrow("requested-owner subscription");
});

test("requested initiating profile resolves its linked subscription and persists trusted identities", async () => {
  const runtime = createFlightDeckThreadRuntime({
    agentStore: { getByBotNpub: npub => ({ agentId: "addressed", managedByNpub: "npub1owner", botNpub: npub, enabled: true }) as never },
    profileStore: { listWorkspacesForProfile: () => [{ workspaceId: invocation.workspaceId, subscriptionId: "linked" }] as never },
    subscriptionStore: { listAll: () => [{ workspaceId: invocation.workspaceId, subscriptionId: "linked", managedByNpub: "npub1owner",
      botNpub: "npub1subscription", sourceAppNpub: "npub1trusted-app", towerServiceNpub: "npub1trusted-tower", lifecycleStatus: "active" }] as never },
    withAgentIdentity: async (agent, op) => op({ botNpub: agent.botNpub } as never),
    fetchScopes: async () => ({ scopes: [{ id: "scope" }], next_cursor: null }),
    fetchChannels: async () => ({ channels: [{ id: "channel" }], next_cursor: null }),
    fetchMessages: async () => ({ messages: [{ id: invocation.threadId }], next_cursor: null }),
  });
  const resolution = await runtime.resolve(invocation, "npub1owner", "npub1addressed");
  expect(resolution).toMatchObject({ senderNpub: "npub1addressed", agentProfileId: "addressed", towerServiceNpub: "npub1trusted-tower", appNpub: "npub1trusted-app" });
});
