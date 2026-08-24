import { afterEach, describe, expect, test } from "bun:test";

import type { WingmanConfig } from "../config";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { CapabilityBroker, type SessionCapabilityPolicy } from "../signing/capability-broker";
import { ProcessManager } from "./process-manager";
import { resolveAndBindSessionCapabilityBotRecord } from "./session-capability-binding";

const ownerNpub = "npub1owner";
const activeBotNpub = "npub1active";
const retiredBotNpub = "npub1retired";
const workingDirectory = "/tmp";
const policy: SessionCapabilityPolicy = { operations: ["identity.read"] };

const activeRecord = {
  id: "active-record",
  userNpub: ownerNpub,
  botNpub: activeBotNpub,
  botPubkeyHex: "11".repeat(32),
  displayName: "Agent Alpha",
  encryptedToUser: "unused",
  encryptedEscrow: "unused",
  escrowUuid: "unused",
  isActive: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} satisfies BotKeyRecord;

const managers: ProcessManager[] = [];

afterEach(async () => {
  await Promise.all(managers.flatMap((manager) =>
    manager.listSessions().map((session) => manager.stopSession(session.id).catch(() => undefined)),
  ));
  managers.length = 0;
});

async function waitForBrokerEnvironment(manager: ProcessManager, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const logs = await manager.getLogs(sessionId) ?? [];
    if (logs.some((entry) => entry.includes("BROKER_ENV=ready"))) return;
    await Bun.sleep(20);
  }
  throw new Error(`spawned session ${sessionId} did not report its broker environment`);
}

async function launch(metadata?: Parameters<ProcessManager["createSession"]>[6]) {
  let manager!: ProcessManager;
  let broker!: CapabilityBroker;
  const config = {
    allowedHosts: "localhost,127.0.0.1",
    agentPortStart: 48770,
    agentPortMax: 48790,
    baseUrl: "http://localhost:3600",
    agents: {
      codex: {
        label: "Codex",
        command: () => [
          "/bin/sh",
          "-c",
          'if [ -n "$WINGMAN_CAPABILITY" ] && [ "$BOT_NPUB" = "npub1active" ] && [ "$WINGMAN_URL" = "http://localhost:3600" ]; then echo BROKER_ENV=ready; else echo BROKER_ENV=missing; fi; sleep 2',
        ],
      },
    },
  } as WingmanConfig;

  manager = new ProcessManager(config, {
    issueSessionCapability: ({ sessionId, ownerNpub: requestedOwnerNpub, profileId, botNpub }) => {
      const { record } = resolveAndBindSessionCapabilityBotRecord({
        manager,
        sessionId,
        ownerNpub: requestedOwnerNpub,
        requestedBotNpub: botNpub,
        profiles: [{
          botNpub: activeBotNpub,
          workingDirectory,
          enabled: true,
        }],
        getActiveByBotNpub: (candidateBotNpub) => candidateBotNpub === activeBotNpub ? activeRecord : null,
        getActiveForOwner: () => activeRecord,
      });
      return broker.issueSessionCapability({
        sessionId,
        ownerNpub: requestedOwnerNpub,
        profileId,
        botNpub: record.botNpub,
        policy,
      });
    },
    revokeSessionCapabilities: (sessionId) => broker.revokeSession(sessionId),
  });
  managers.push(manager);
  broker = new CapabilityBroker({
    botKeyStore: {
      getActiveKeyForUser: () => activeRecord,
      getActiveKeyForBotNpub: (candidateBotNpub) => candidateBotNpub === activeBotNpub ? activeRecord : null,
    },
    keyVault: {
      withKey: async () => { throw new Error("test does not perform signing"); },
    },
    getSession: (sessionId) => manager.getSession(sessionId),
  });

  const snapshot = await manager.createSession(
    "codex",
    workingDirectory,
    "Capability binding regression",
    null,
    undefined,
    ownerNpub,
    metadata,
  );
  await waitForBrokerEnvironment(manager, snapshot.id);
  return { manager, snapshot: manager.getSession(snapshot.id)! };
}

describe("session capability binding", () => {
  test("rebinds a stale resumed identity before issuing capability and MCP environment", async () => {
    const { snapshot } = await launch({
      AGENT: true,
      resumedFromWingmanSessionId: "retired-session",
      agentChatAgentId: "agent-alpha",
      agentChatBotNpub: retiredBotNpub,
      flightdeckAgentNpub: retiredBotNpub,
    });

    expect(snapshot.metadata?.agentChatBotNpub).toBe(activeBotNpub);
    expect(snapshot.metadata?.flightdeckAgentNpub).toBe(activeBotNpub);
    expect(snapshot.logs).toContainEqual(expect.stringContaining("BROKER_ENV=ready"));
  });

  test("binds a manual owner-authenticated session and launches it with capability and MCP environment", async () => {
    const { snapshot } = await launch();

    expect(snapshot.metadata?.AGENT).toBe(false);
    expect(snapshot.metadata?.agentChatBotNpub).toBe(activeBotNpub);
    expect(snapshot.logs).toContainEqual(expect.stringContaining("BROKER_ENV=ready"));
  });
});
