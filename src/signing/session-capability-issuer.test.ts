import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSnapshot } from "../agents/process-manager";
import { CapabilityBroker } from "./capability-broker";
import type { AgentSigningMode } from "./agent-signing-policy";
import { SessionCapabilityIssuer } from "./session-capability-issuer";
import { FileSigningPolicyStore, SigningPolicyRegistry } from "./signing-policy-registry";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionCapabilityIssuer", () => {
  test("uses the currently selected signing mode for new capability issuance", () => {
    const root = mkdtempSync(join(tmpdir(), "wingman-session-capability-issuer-"));
    roots.push(root);
    let mode: AgentSigningMode = "standard-agent";
    const ownerNpub = "npub1owner";
    const botRecord = {
      userNpub: ownerNpub,
      botNpub: "npub1bot",
      botPubkeyHex: "ab".repeat(32),
    };
    const sessions = new Map<string, SessionSnapshot>([
      ["session-a", { id: "session-a", agent: "codex", port: 3700, name: "A", status: "running", startedAt: new Date().toISOString(), npub: ownerNpub, command: [], workingDirectory: "/tmp", logs: [] }],
      ["session-b", { id: "session-b", agent: "codex", port: 3701, name: "B", status: "running", startedAt: new Date().toISOString(), npub: ownerNpub, command: [], workingDirectory: "/tmp", logs: [] }],
    ]);
    const manager = {
      getSession: (sessionId: string) => sessions.get(sessionId),
      bindSessionCapabilityIdentity: (sessionId: string, botNpub: string, profileId: string) => {
        const session = sessions.get(sessionId);
        if (!session) return null;
        const metadata = { ...(session.metadata as Record<string, unknown> | undefined), agentProfileId: profileId, agentChatBotNpub: botNpub };
        const next = { ...session, metadata } as SessionSnapshot;
        sessions.set(sessionId, next);
        return next;
      },
    };
    const broker = new CapabilityBroker({
      botKeyStore: {
        getActiveKeyForUser: () => botRecord,
        getActiveKeyForBotNpub: (botNpub) => botNpub === botRecord.botNpub ? botRecord : null,
      },
      keyVault: { withKey: async () => { throw new Error("not used by issuance"); } },
      getSession: (sessionId) => sessions.get(sessionId),
    });
    const issuer = new SessionCapabilityIssuer({
      broker,
      registry: new SigningPolicyRegistry(new FileSigningPolicyStore(join(root, "policies.json")), {
        forgejoCompletionUrl: "https://tower.example/api/v4/git/oidc/authorize/complete",
      }),
      getManager: () => manager,
      sharedAgentDispatch: false,
      adminNpub: null,
      towerUrl: "https://tower.example",
      autopilotUrl: "https://autopilot.example",
      getSigningMode: () => mode,
      listProfiles: () => [{ agentId: "builder", botNpub: botRecord.botNpub, enabled: true }],
      getDefaultProfile: () => ({ agentId: "builder", botNpub: botRecord.botNpub, enabled: true }),
      getActiveByBotNpub: (botNpub) => botNpub === botRecord.botNpub ? botRecord : null,
      ensureProvisioned: () => {},
      listTowerUrls: () => [],
    });

    issuer.issue({ sessionId: "session-a", ownerNpub });
    mode = "full-agent";
    issuer.issue({ sessionId: "session-b", ownerNpub });

    expect(broker.listActiveCapabilities().map((capability) => ({
      sessionId: capability.sessionId,
      policyMode: capability.policyMode,
    }))).toEqual([
      { sessionId: "session-a", policyMode: "standard-agent" },
      { sessionId: "session-b", policyMode: "full-agent" },
    ]);
  });
});
