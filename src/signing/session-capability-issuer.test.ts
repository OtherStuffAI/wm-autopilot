import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSnapshot } from "../agents/process-manager";
import { CapabilityBroker, type PersistedCapabilityRecord, type WalletConstraint } from "./capability-broker";
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
    let walletGrant: WalletConstraint | undefined;
    let saved: PersistedCapabilityRecord[] = [];
    const ownerNpub = "npub1owner";
    const botRecord = {
      id: "fixture-bot-record", displayName: "Fixture", encryptedToUser: "fixture", encryptedEscrow: "fixture", escrowUuid: "fixture", isActive: 1 as const, createdAt: "2026-01-01", updatedAt: "2026-01-01",
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
      stateStore: { load: () => [], save: records => { saved = structuredClone(records); } },
      botKeyStore: {
        getActiveKeyForUser: () => botRecord,
        getActiveKeyForBotNpub: (botNpub) => botNpub === botRecord.botNpub ? botRecord : null,
      },
      keyVault: { withKey: async () => { throw new Error("not used by issuance"); } },
      getSession: (sessionId) => sessions.get(sessionId),
    });
    const issuer = new SessionCapabilityIssuer({
      broker,
      getWalletPolicy: npub => { expect(npub).toBe(botRecord.botNpub); return walletGrant; },
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
    expect(saved[0]?.policy.operations).not.toContain("wallet.read");
    expect(saved[0]?.policy.operations).not.toContain("wallet.spend");
    walletGrant = { readMethods: ["get_balance"], spendMethods: ["pay_invoice"], maxSpendMsats: 1000, maxTotalSpendMsats: 2000 };
    mode = "full-agent";
    issuer.issue({ sessionId: "session-b", ownerNpub });

    expect(saved.find(record => record.sessionId === "session-b")?.policy.wallet).toEqual(walletGrant);
    expect(saved.find(record => record.sessionId === "session-b")?.policy.operations).toContain("wallet.read");
    expect(saved.find(record => record.sessionId === "session-b")?.policy.operations).toContain("wallet.spend");

    const projectSession={...sessions.get("session-a")!,id:"project-session",metadata:{role:"completed-turn",nativeProjectTools:true}} as SessionSnapshot;
    sessions.set(projectSession.id,projectSession);
    issuer.issue({sessionId:projectSession.id,ownerNpub});
    const narrow=saved.find(record=>record.sessionId===projectSession.id)!;
    expect(narrow.policy.operations).toEqual(["identity.read","capability.refresh"]);
    expect(narrow.policy.nip98).toBeUndefined();
    expect(narrow.policy.wallet).toBeUndefined();
    expect(narrow.policy.nostr).toBeUndefined();

    expect(broker.listActiveCapabilities().filter(c=>c.sessionId!=="project-session").map((capability) => ({
      sessionId: capability.sessionId,
      policyMode: capability.policyMode,
    }))).toEqual([
      { sessionId: "session-a", policyMode: "standard-agent" },
      { sessionId: "session-b", policyMode: "full-agent" },
    ]);
  });
});
