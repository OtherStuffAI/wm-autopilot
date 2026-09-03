import { afterEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";

import { nip44Decrypt, nip44Encrypt } from "../nostr/nip44-crypto";
import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord } from "../identity/bot-key-store";
import {
  CapabilityBroker,
  DEFAULT_AGENT_NOSTR_EVENT_KINDS,
  SESSION_CAPABILITY_TTL_MS,
  buildDefaultAgentCapabilityPolicy,
  type CapabilityAuditEntry,
  type CapabilityBrokerDependencies,
  type PersistedCapabilityRecord,
  type SessionCapabilityPolicy,
} from "./capability-broker";
import { BrokerKeyNotProvisionedError } from "./broker-key-vault";

const ownerA = "npub1owner-a";
const ownerB = "npub1owner-b";
const botSecretA = generateSecretKey();
const botSecretB = generateSecretKey();
const botPubkeyA = getPublicKey(botSecretA);
const botPubkeyB = getPublicKey(botSecretB);

function record(ownerNpub: string, secretKey: Uint8Array): BotKeyRecord {
  const pubkey = getPublicKey(secretKey);
  return {
    id: `record-${ownerNpub}`,
    userNpub: ownerNpub,
    botPubkeyHex: pubkey,
    botNpub: nip19.npubEncode(pubkey),
    displayName: ownerNpub,
    encryptedToUser: "not-used",
    encryptedEscrow: "not-used",
    escrowUuid: "not-used",
    isActive: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const records = new Map([
  [ownerA, record(ownerA, botSecretA)],
  [ownerB, record(ownerB, botSecretB)],
]);
const botKeyStore = {
  getActiveKeyForUser: (npub: string) => records.get(npub) ?? null,
  getActiveKeyForBotNpub: (botNpub: string) => [...records.values()].find((candidate) => candidate.botNpub === botNpub) ?? null,
};

const sessions = new Map<string, SessionSnapshot>([
  ["session-a", { id: "session-a", agent: "codex", port: 3700, name: "A", status: "running", startedAt: new Date().toISOString(), npub: ownerA, command: [], workingDirectory: "/tmp", logs: [] }],
  ["session-b", { id: "session-b", agent: "claude", port: 3701, name: "B", status: "running", startedAt: new Date().toISOString(), npub: ownerB, command: [], workingDirectory: "/tmp", logs: [] }],
]);

const policy: SessionCapabilityPolicy = {
  operations: ["identity.read", "capability.refresh", "nip98.sign", "nostr.sign", "nip44.encrypt", "nip44.decrypt", "blossom.authorize", "wallet.read", "wallet.spend"],
  nip98: { origins: ["https://tower.example"], methods: ["GET", "POST"], pathPrefixes: ["/api/v4/flightdeck-pg"], requireBodyHashMethods: ["POST"] },
  nostr: { kinds: [1, 30_078], maxContentBytes: 100, maxTags: 4, allowedTagNames: ["d", "p"] },
  nip44: { encryptPeers: [botPubkeyB], decryptPeers: [botPubkeyB] },
  blossom: { servers: ["https://blossom.example"], methods: ["upload"], maxObjectBytes: 1_024 },
  wallet: { readMethods: ["get_balance"], spendMethods: ["pay_invoice"], maxSpendMsats: 1_000, maxTotalSpendMsats: 1_500 },
  maxCallsPerMinute: 20,
};

let now = 1_800_000_000_000;
const audit: CapabilityAuditEntry[] = [];
const walletCalls: unknown[] = [];
const testKeyVault: CapabilityBrokerDependencies["keyVault"] = {
  withKey: async (record, operation) => {
    const source = record.userNpub === ownerA ? botSecretA : botSecretB;
    const copy = new Uint8Array(source);
    try { return await operation(copy); } finally { copy.fill(0); }
  },
};
const broker = new CapabilityBroker({
  botKeyStore,
  keyVault: testKeyVault,
  getSession: (sessionId) => sessions.get(sessionId),
  now: () => now,
  audit: (entry) => audit.push(entry),
  wallet: {
    read: async (input) => ({ balanceMsats: 5_000, method: input.method }),
    spend: async (input) => { walletCalls.push(input); return { paid: true }; },
  },
});

function issue(sessionId = "session-a", ownerNpub = ownerA, override: Partial<SessionCapabilityPolicy> = {}) {
  return broker.issueSessionCapability({ sessionId, ownerNpub, policy: { ...policy, ...override }, ttlMs: 60_000 });
}

function request(path: string, token: string | null, body: Record<string, unknown>, nonce: string = crypto.randomUUID()): { request: Request; url: URL } {
  const url = new URL(`http://localhost${path}`);
  const headers: Record<string, string> = { "content-type": "application/json", "x-wingman-capability-nonce": nonce };
  if (token) headers.authorization = `Bearer ${token}`;
  return { url, request: new Request(url.toString(), { method: "POST", headers, body: JSON.stringify(body) }) };
}

async function call(path: string, token: string | null, body: Record<string, unknown>, nonce?: string): Promise<Response> {
  const input = request(path, token, body, nonce);
  return (await broker.handle(input.request, input.url, "POST"))!;
}

afterEach(() => {
  sessions.get("session-a")!.status = "running";
  sessions.get("session-a")!.npub = ownerA;
  now = 1_800_000_000_000;
  audit.length = 0;
  walletCalls.length = 0;
});

describe("CapabilityBroker", () => {
  test("issues default session capabilities for two hours", () => {
    const issued = broker.issueSessionCapability({ sessionId: "session-a", ownerNpub: ownerA, policy });
    expect(new Date(issued.expiresAt).getTime() - now).toBe(2 * 60 * 60_000);
    expect(SESSION_CAPABILITY_TTL_MS).toBe(2 * 60 * 60_000);
  });

  test("binds sibling profiles owned by one manager to distinct non-exportable identities", async () => {
    const BuilderSecret = generateSecretKey();
    const exampleAgent = records.get(ownerA)!;
    const Builder = record(ownerA, BuilderSecret);
    Builder.id = "record-Builder";
    const profileSessions = new Map<string, SessionSnapshot>([
      ["exampleAgent-session", { ...sessions.get("session-a")!, id: "exampleAgent-session", metadata: { agentChatAgentId: "exampleAgent", agentChatBotNpub: exampleAgent.botNpub } } as unknown as SessionSnapshot],
      ["Builder-session", { ...sessions.get("session-a")!, id: "Builder-session", agent: "goose", workingDirectory: "/tmp/Builder", metadata: { agentChatAgentId: "Builder21", agentChatBotNpub: Builder.botNpub } } as unknown as SessionSnapshot],
    ]);
    const profileBroker = new CapabilityBroker({
      botKeyStore: {
        getActiveKeyForUser: () => exampleAgent,
        getActiveKeyForBotNpub: (npub) => npub === exampleAgent.botNpub ? exampleAgent : npub === Builder.botNpub ? Builder : null,
      },
      getSession: (sessionId) => profileSessions.get(sessionId),
      keyVault: {
        withKey: async (botRecord, operation) => {
          const key = new Uint8Array(botRecord.botNpub === Builder.botNpub ? BuilderSecret : botSecretA);
          try { return await operation(key); } finally { key.fill(0); }
        },
      },
    });
    const exampleAgentCapability = profileBroker.issueSessionCapability({ sessionId: "exampleAgent-session", ownerNpub: ownerA, profileId: "exampleAgent", botNpub: exampleAgent.botNpub, policy });
    const BuilderCapability = profileBroker.issueSessionCapability({ sessionId: "Builder-session", ownerNpub: ownerA, profileId: "Builder21", botNpub: Builder.botNpub, policy });
    expect(exampleAgentCapability.botNpub).toBe(exampleAgent.botNpub);
    expect(BuilderCapability.botNpub).toBe(Builder.botNpub);
    const BuilderIdentityUrl = new URL("http://localhost/api/mcp/capabilities/identity?sessionId=Builder-session");
    const BuilderIdentityRequest = new Request(BuilderIdentityUrl.toString(), {
      headers: {
        authorization: `Bearer ${BuilderCapability.token}`,
        "x-wingman-capability-nonce": crypto.randomUUID(),
      },
    });
    const BuilderIdentityResponse = (await profileBroker.handle(BuilderIdentityRequest, BuilderIdentityUrl, "GET"))!;
    expect(BuilderIdentityResponse.status).toBe(200);
    expect(await BuilderIdentityResponse.json()).toMatchObject({ botNpub: Builder.botNpub, botPubkeyHex: Builder.botPubkeyHex });
    let mismatch = '';
    try {
      profileBroker.issueSessionCapability({ sessionId: "Builder-session", ownerNpub: ownerA, profileId: "exampleAgent", botNpub: exampleAgent.botNpub, policy });
    } catch (error) {
      mismatch = error instanceof Error ? error.message : String(error);
    }
    expect(mismatch).toContain("profile binding");
    BuilderSecret.fill(0);
  });

  test("keeps session ownership separate from a shared profile manager identity", async () => {
    const sharedProfile = records.get(ownerB)!;
    const sharedSession = {
      ...sessions.get("session-a")!,
      metadata: { agentChatAgentId: "shared-profile", agentChatBotNpub: sharedProfile.botNpub },
    } as unknown as SessionSnapshot;
    const sharedBroker = new CapabilityBroker({
      botKeyStore,
      keyVault: testKeyVault,
      getSession: (sessionId) => sessionId === "session-a" ? sharedSession : null,
      now: () => now,
    });
    const issued = sharedBroker.issueSessionCapability({
      sessionId: "session-a",
      ownerNpub: ownerA,
      identityManagerNpub: ownerB,
      profileId: "shared-profile",
      botNpub: sharedProfile.botNpub,
      policy,
    });
    const identityUrl = new URL("http://localhost/api/mcp/capabilities/identity?sessionId=session-a");
    const identityRequest = new Request(identityUrl, {
      headers: {
        authorization: `Bearer ${issued.token}`,
        "x-wingman-capability-nonce": crypto.randomUUID(),
      },
    });
    const response = (await sharedBroker.handle(identityRequest, identityUrl, "GET"))!;

    expect(sharedBroker.getPublicIdentity("session-a")).toEqual({
      botNpub: sharedProfile.botNpub,
      botPubkeyHex: sharedProfile.botPubkeyHex,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ botNpub: sharedProfile.botNpub });
  });

  test("brokers the instance identity without copying it into the agent key vault", async () => {
    const instanceSecret = generateSecretKey();
    const instancePubkeyHex = getPublicKey(instanceSecret);
    const instanceNpub = nip19.npubEncode(instancePubkeyHex);
    const instanceSession = {
      ...sessions.get("session-a")!,
      metadata: { agentChatAgentId: "flightdeck-agent", agentChatBotNpub: instanceNpub },
    } as unknown as SessionSnapshot;
    let vaultCalled = false;
    const instanceBroker = new CapabilityBroker({
      botKeyStore,
      keyVault: {
        withKey: async () => {
          vaultCalled = true;
          throw new Error("instance identity must remain outside the agent vault");
        },
      },
      getInstanceIdentity: () => ({ npub: instanceNpub, pubkeyHex: instancePubkeyHex, secretKey: instanceSecret }),
      getSession: (sessionId) => sessionId === "session-a" ? instanceSession : null,
      now: () => now,
    });
    const issued = instanceBroker.issueSessionCapability({
      sessionId: "session-a",
      ownerNpub: ownerA,
      identityManagerNpub: ownerB,
      profileId: "flightdeck-agent",
      botNpub: instanceNpub,
      policy,
    });
    const input = request("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-a",
      event: { kind: 1, content: "shared dispatch", tags: [] },
    });
    const response = (await instanceBroker.handle(input.request, input.url, "POST"))!;
    const payload = await response.json() as { event: Parameters<typeof verifyEvent>[0] };

    expect(response.status).toBe(200);
    expect(verifyEvent(payload.event)).toBe(true);
    expect(payload.event.pubkey).toBe(instancePubkeyHex);
    expect(vaultCalled).toBe(false);
    expect(instanceBroker.getPublicIdentity("session-a")).toEqual({ botNpub: instanceNpub, botPubkeyHex: instancePubkeyHex });
    instanceSecret.fill(0);
  });
  test("preserves a renewed capability through PM2 broker restart and session rehydration", async () => {
    let persisted: PersistedCapabilityRecord[] = [];
    let sessionRehydrated = true;
    const stateStore = {
      load: () => structuredClone(persisted),
      save: (records: PersistedCapabilityRecord[]) => { persisted = structuredClone(records); },
    };
    const dependencies = {
      botKeyStore,
      keyVault: testKeyVault,
      getSession: (sessionId: string) => sessionRehydrated ? sessions.get(sessionId) : null,
      now: () => now,
      stateStore,
    };
    const beforeRestart = new CapabilityBroker(dependencies);
    const issued = beforeRestart.issueSessionCapability({ sessionId: "session-a", ownerNpub: ownerA, policy, ttlMs: 60_000 });
    expect(JSON.stringify(persisted)).not.toContain(issued.token);
    const refresh = request("/api/mcp/capabilities/refresh", issued.token, { sessionId: "session-a" });
    expect((await beforeRestart.handle(refresh.request, refresh.url, "POST"))!.status).toBe(200);
    now += 61_000;

    sessionRehydrated = false;
    const afterRestart = new CapabilityBroker(dependencies);
    sessionRehydrated = true;
    const valid = request("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-a", event: { kind: 1, content: "after restart", tags: [] },
    });
    expect((await afterRestart.handle(valid.request, valid.url, "POST"))!.status).toBe(200);

    const crossSession = request("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-b", event: { kind: 1, content: "wrong session", tags: [] },
    });
    expect((await afterRestart.handle(crossSession.request, crossSession.url, "POST"))!.status).toBe(403);
  });

  test("renews an expired capability after a PM2 broker restart only for its live session", async () => {
    let persisted: PersistedCapabilityRecord[] = [];
    const stateStore = {
      load: () => structuredClone(persisted),
      save: (saved: PersistedCapabilityRecord[]) => { persisted = structuredClone(saved); },
    };
    const dependencies = {
      botKeyStore,
      keyVault: testKeyVault,
      getSession: (sessionId: string) => sessions.get(sessionId),
      now: () => now,
      stateStore,
    };
    const beforeRestart = new CapabilityBroker(dependencies);
    const issued = beforeRestart.issueSessionCapability({ sessionId: "session-a", ownerNpub: ownerA, policy, ttlMs: 60_000 });
    now += 61_000;

    const afterRestart = new CapabilityBroker(dependencies);
    const deniedSigning = request("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-a", event: { kind: 1, content: "still expired", tags: [] },
    });
    expect((await afterRestart.handle(deniedSigning.request, deniedSigning.url, "POST"))!.status).toBe(403);

    const refresh = request("/api/mcp/capabilities/refresh", issued.token, { sessionId: "session-a" });
    expect((await afterRestart.handle(refresh.request, refresh.url, "POST"))!.status).toBe(200);
    const renewedSigning = request("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-a", event: { kind: 1, content: "renewed", tags: [] },
    });
    expect((await afterRestart.handle(renewedSigning.request, renewedSigning.url, "POST"))!.status).toBe(200);

    now += SESSION_CAPABILITY_TTL_MS + 1;
    sessions.get("session-a")!.status = "stopped";
    const stoppedRefresh = request("/api/mcp/capabilities/refresh", issued.token, { sessionId: "session-a" });
    expect((await afterRestart.handle(stoppedRefresh.request, stoppedRefresh.url, "POST"))!.status).toBe(403);
  });

  test("returns a stable fail-closed diagnostic when the vault entry is missing", async () => {
    const missing = new CapabilityBroker({
      botKeyStore,
      getSession: (sessionId) => sessions.get(sessionId),
      keyVault: { withKey: async (record) => { throw new BrokerKeyNotProvisionedError(record.userNpub, record.botNpub); } },
    });
    const issued = missing.issueSessionCapability({ sessionId: "session-a", ownerNpub: ownerA, policy, ttlMs: 60_000 });
    const input = request("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: "https://tower.example/api/v4/flightdeck-pg/tasks", method: "POST", bodyHash: "ab".repeat(32),
    });
    const response = (await missing.handle(input.request, input.url, "POST"))!;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "broker_key_not_provisioned" });

    const missingEncrypt = request("/api/mcp/capabilities/nip44/encrypt", issued.token, {
      sessionId: "session-a",
      plaintext: "still fail closed",
      recipientPubkey: botPubkeyB,
    });
    expect((await missing.handle(missingEncrypt.request, missingEncrypt.url, "POST"))!.status).toBe(503);
    const missingDecrypt = request("/api/mcp/capabilities/nip44/decrypt", issued.token, {
      sessionId: "session-a",
      ciphertext: nip44Encrypt("still fail closed", botSecretB, botPubkeyA),
      senderPubkey: botPubkeyB,
    });
    expect((await missing.handle(missingDecrypt.request, missingDecrypt.url, "POST"))!.status).toBe(503);
  });

  test("signs exact NIP-98 semantics with the stable agent identity", async () => {
    const issued = issue();
    const response = await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: "https://tower.example/api/v4/flightdeck-pg/tasks", method: "POST", bodyHash: "ab".repeat(32),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { token: string; signedBy: string };
    const event = JSON.parse(Buffer.from(result.token.slice(6), "base64").toString("utf8"));
    expect(result.signedBy).toBe(records.get(ownerA)!.botNpub);
    expect(event.pubkey).toBe(botPubkeyA);
    expect(verifyEvent(event)).toBe(true);
    expect(broker.verifyNip98SessionBinding(event)).toBe("session-a");

    const forgedSession = structuredClone(event);
    const bindingTag = forgedSession.tags.find((tag: string[]) => tag[0] === "wm-session-capability");
    bindingTag[2] = "session-b";
    expect(broker.verifyNip98SessionBinding(forgedSession)).toBeNull();

    const forgedMac = structuredClone(event);
    const forgedBindingTag = forgedMac.tags.find((tag: string[]) => tag[0] === "wm-session-capability");
    forgedBindingTag[3] = "00".repeat(32);
    expect(broker.verifyNip98SessionBinding(forgedMac)).toBeNull();
  });

  test.each([
    ["origin", "https://evil.example/api/v4/flightdeck-pg/tasks", "POST"],
    ["method", "https://tower.example/api/v4/flightdeck-pg/tasks", "DELETE"],
    ["path", "https://tower.example/api/v4/admin", "POST"],
  ])("rejects widened NIP-98 %s", async (_label, url, method) => {
    const response = await call("/api/mcp/capabilities/nip98", issue().token, { sessionId: "session-a", url, method, bodyHash: "ab".repeat(32) });
    expect(response.status).toBe(403);
  });

  test("requires an exact payload hash for body-bearing NIP-98 methods", async () => {
    const response = await call("/api/mcp/capabilities/nip98", issue().token, {
      sessionId: "session-a", url: "https://tower.example/api/v4/flightdeck-pg/tasks", method: "POST",
    });
    expect(response.status).toBe(400);
  });

  test("keeps default Tower and local Autopilot target prefixes origin-specific", async () => {
    const issued = issue("session-a", ownerA, buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example",
      autopilotUrl: "http://localhost:3600",
      ownerNpub: ownerA,
    }));
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: `http://localhost:3600/api/owners/${ownerA}/apps`, method: "GET",
    })).status).toBe(200);
    for (const path of [
      "/api/sessions",
      "/api/sessions/session-a",
      "/api/delegate-sessions/session-a/messages",
      "/api/archive",
      "/api/archive/session-a/metadata",
      "/api/wapps/activation-catalog",
      "/api/wapps/install-intents/process",
      "/api/system/restart/status",
    ]) {
      expect((await call("/api/mcp/capabilities/nip98", issued.token, {
        sessionId: "session-a", url: `http://localhost:3600${path}`, method: "GET",
      })).status).toBe(200);
    }
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: "http://localhost:3600/api/system/restart", method: "POST",
    })).status).toBe(200);
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: "http://localhost:3600/api/system/restart-and-resume", method: "POST",
    })).status).toBe(200);
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a",
      url: "http://localhost:3600/api/admin/wapps/legacy-custody-migration",
      method: "POST",
      bodyHash: "ab".repeat(32),
    })).status).toBe(200);
    for (const [path, method] of [
      ["/api/admin/wapps/legacy-custody-migration", "GET"],
      ["/api/admin/wapps/legacy-custody-migration/extra", "POST"],
      ["/api/system/restart-and-resume", "GET"],
      ["/api/system/restart/status", "POST"],
      ["/api/system/restart/status/details", "GET"],
      ["/api/system/cleanup", "POST"],
    ]) {
      expect((await call("/api/mcp/capabilities/nip98", issued.token, {
        sessionId: "session-a", url: `http://localhost:3600${path}`, method,
      })).status).toBe(403);
    }
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: `http://localhost:3600/api/owners/${ownerB}/apps`, method: "GET",
    })).status).toBe(403);
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: `http://localhost:3600/api/owners/${ownerA}-unrelated/apps`, method: "GET",
    })).status).toBe(403);
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: "https://tower.example/api/sessions", method: "GET",
    })).status).toBe(403);
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a", url: "http://localhost:3600/api/v4/records", method: "GET",
    })).status).toBe(403);

    const flightDeckInstruction = await call("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-a",
      event: {
        kind: 33_358,
        content: "broker-backed Flight Deck reply",
        tags: [
          ["protocol", "flightdeck_pg_message_instruction"],
          ["body_sha256", "ab".repeat(32)],
          ["workspace_id", "workspace-a"],
          ["channel_id", "channel-a"],
          ["thread_id", "thread-a"],
        ],
      },
    });
    expect(flightDeckInstruction.status).toBe(200);
    const signedInstruction = await flightDeckInstruction.json() as { event: { kind: number; pubkey: string } };
    expect(signedInstruction.event.kind).toBe(33_358);
    expect(signedInstruction.event.pubkey).toBe(botPubkeyA);
  });

  test("allows the explicit common agent kinds and denies an unapproved kind by default", async () => {
    const defaultPolicy = buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example",
      autopilotUrl: "http://localhost:3600",
      ownerNpub: ownerA,
    });
    expect(defaultPolicy.nostr?.kinds).toEqual([...DEFAULT_AGENT_NOSTR_EVENT_KINDS]);

    const issued = issue("session-a", ownerA, defaultPolicy);
    for (const kind of [3_063, 24_242, 30_063, 32_267, 33_358]) {
      expect((await call("/api/mcp/capabilities/nostr-event", issued.token, {
        sessionId: "session-a",
        event: { kind, content: `default kind ${kind}`, tags: [] },
      })).status).toBe(200);
    }
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-a",
      event: { kind: 31_337, content: "unapproved", tags: [] },
    })).status).toBe(403);
  });

  test("keeps default NIP-44 operations separate and size/error constrained", async () => {
    const defaultPolicy = buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example",
      autopilotUrl: "http://localhost:3600",
    });
    expect(defaultPolicy.operations).toEqual(expect.arrayContaining(["nip44.encrypt", "nip44.decrypt"]));
    expect(defaultPolicy.nostr?.kinds.every(Number.isInteger)).toBe(true);
    expect(defaultPolicy.nip44).toMatchObject({
      encryptPeers: ["*"],
      decryptPeers: ["*"],
      maxPlaintextBytes: 1_048_576,
      maxCiphertextBytes: 1_500_000,
    });

    const issued = issue("session-a", ownerA, defaultPolicy);
    const encryptedResponse = await call("/api/mcp/capabilities/nip44/encrypt", issued.token, {
      sessionId: "session-a",
      plaintext: "default NIP-44",
      recipientPubkey: botPubkeyB,
    });
    expect(encryptedResponse.status).toBe(200);
    const encrypted = await encryptedResponse.json() as { ciphertext: string };
    expect((await call("/api/mcp/capabilities/nip44/decrypt", issued.token, {
      sessionId: "session-a",
      ciphertext: encrypted.ciphertext,
      senderPubkey: botPubkeyB,
    })).status).toBe(200);
    expect((await call("/api/mcp/capabilities/nip44/decrypt", issued.token, {
      sessionId: "session-a",
      ciphertext: "not-valid-ciphertext",
      senderPubkey: botPubkeyB,
    })).status).toBe(400);
    expect((await call("/api/mcp/capabilities/nip44/encrypt", issued.token, {
      sessionId: "session-a",
      plaintext: "x".repeat(1_048_577),
      recipientPubkey: botPubkeyB,
    })).status).toBe(400);
    expect((await call("/api/mcp/capabilities/nip44/decrypt", issued.token, {
      sessionId: "session-a",
      ciphertext: "x".repeat(1_500_001),
      senderPubkey: botPubkeyB,
    })).status).toBe(400);
    expect((await call("/api/mcp/capabilities/nip44/encrypt", issued.token, {
      sessionId: "session-a",
      plaintext: "invalid peer",
      recipientPubkey: "not-a-pubkey",
    })).status).toBe(400);
    expect((await call("/api/mcp/capabilities/nip44/encrypt", issued.token, {
      sessionId: "session-a",
      plaintext: "",
      recipientPubkey: botPubkeyB,
    })).status).toBe(400);
  });

  test("keeps default Blossom authorization scoped independently of generic kind 24242 signing", async () => {
    const defaultPolicy = buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example/path-is-normalized-to-origin",
      autopilotUrl: "http://localhost:3600",
    });
    expect(defaultPolicy.blossom).toEqual({
      servers: ["https://tower.example"],
      methods: ["upload", "delete", "list"],
      maxObjectBytes: 25 * 1_024 * 1_024,
    });

    const issued = issue("session-a", ownerA, defaultPolicy);
    const valid = {
      sessionId: "session-a",
      server: "https://tower.example/upload",
      method: "upload",
      objectHash: "ab".repeat(32),
      objectSize: 1_024,
    };
    expect((await call("/api/mcp/capabilities/blossom/authorize", issued.token, valid)).status).toBe(200);
    expect((await call("/api/mcp/capabilities/blossom/authorize", issued.token, {
      ...valid,
      server: "https://other.example",
    })).status).toBe(403);
    expect((await call("/api/mcp/capabilities/blossom/authorize", issued.token, {
      ...valid,
      objectSize: 25 * 1_024 * 1_024 + 1,
    })).status).toBe(403);
  });

  test("uses the configured public Autopilot origin for hosted session capabilities", async () => {
    const issued = issue("session-a", ownerA, buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example",
      autopilotUrl: "https://agent.example.invalid",
      ownerNpub: ownerA,
    }));

    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a",
      url: "https://agent.example.invalid/api/sessions/session-a",
      method: "GET",
    })).status).toBe(200);
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a",
      url: "http://localhost:3256/api/sessions/session-a",
      method: "GET",
    })).status).toBe(403);
  });

  test("allows known Flight Deck subscription Tower origins as well as the internal Tower", async () => {
    const issued = issue("session-a", ownerA, buildDefaultAgentCapabilityPolicy({
      towerUrl: "http://127.0.0.1:3100",
      towerUrls: ["https://tower-public.example", "http://127.0.0.1:3100/duplicate"],
      autopilotUrl: "http://localhost:3600",
      ownerNpub: ownerA,
    }));

    for (const url of [
      "http://127.0.0.1:3100/api/v4/flightdeck-pg/workspaces",
      "https://tower-public.example/api/v4/flightdeck-pg/workspaces",
    ]) {
      expect((await call("/api/mcp/capabilities/nip98", issued.token, {
        sessionId: "session-a",
        url,
        method: "GET",
      })).status).toBe(200);
    }
    expect((await call("/api/mcp/capabilities/nip98", issued.token, {
      sessionId: "session-a",
      url: "https://unrelated.example/api/v4/flightdeck-pg/workspaces",
      method: "GET",
    })).status).toBe(403);
  });

  test("denies expired and mismatched authority for exact brokered restart control", async () => {
    const defaultPolicy = buildDefaultAgentCapabilityPolicy({
      towerUrl: "https://tower.example",
      autopilotUrl: "http://localhost:3600",
      ownerNpub: ownerA,
    });
    const expired = issue("session-a", ownerA, defaultPolicy);
    now += 61_000;
    expect((await call("/api/mcp/capabilities/nip98", expired.token, {
      sessionId: "session-a", url: "http://localhost:3600/api/system/restart/status", method: "GET",
    })).status).toBe(403);

    now -= 61_000;
    const mismatched = issue("session-a", ownerA, defaultPolicy);
    expect((await call("/api/mcp/capabilities/nip98", mismatched.token, {
      sessionId: "session-b", url: "http://localhost:3600/api/system/restart/status", method: "GET",
    })).status).toBe(403);
  });

  test("enforces session and stable bot identity isolation", async () => {
    const issued = issue();
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, { sessionId: "session-b", event: { kind: 1, content: "x", tags: [] } })).status).toBe(403);
    sessions.get("session-a")!.npub = ownerB;
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, { sessionId: "session-a", event: { kind: 1, content: "x", tags: [] } })).status).toBe(403);
  });

  test("rejects missing, malformed, expired, revoked, replayed and stopped-session authority", async () => {
    expect((await call("/api/mcp/capabilities/nostr-event", null, { sessionId: "session-a" })).status).toBe(401);
    expect((await call("/api/mcp/capabilities/nostr-event", "bad", { sessionId: "session-a" })).status).toBe(403);
    const expired = issue();
    now += 61_000;
    expect((await call("/api/mcp/capabilities/nostr-event", expired.token, { sessionId: "session-a" })).status).toBe(403);
    now -= 61_000;
    const revoked = issue();
    broker.revokeSession("session-a");
    expect((await call("/api/mcp/capabilities/nostr-event", revoked.token, { sessionId: "session-a" })).status).toBe(403);
    const fresh = issue();
    const nonce = "replay_nonce_123456";
    const body = { sessionId: "session-a", event: { kind: 1, content: "x", tags: [] } };
    expect((await call("/api/mcp/capabilities/nostr-event", fresh.token, body, nonce)).status).toBe(200);
    expect((await call("/api/mcp/capabilities/nostr-event", fresh.token, body, nonce)).status).toBe(403);
    sessions.get("session-a")!.status = "stopped";
    expect((await call("/api/mcp/capabilities/nostr-event", fresh.token, body)).status).toBe(403);
  });

  test("renews the same session token so sibling processes keep their authority", async () => {
    const issued = issue();
    const response = await call("/api/mcp/capabilities/refresh", issued.token, { sessionId: "session-a" });
    expect(response.status).toBe(200);
    const refreshed = await response.json() as { token: string; botNpub: string };
    expect(refreshed.token).toBe(issued.token);
    expect(refreshed.botNpub).toBe(issued.botNpub);
    const eventBody = { sessionId: "session-a", event: { kind: 1, content: "refreshed", tags: [] } };
    now += 61_000;
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, eventBody)).status).toBe(200);
    expect((await call("/api/mcp/capabilities/nostr-event", refreshed.token, eventBody)).status).toBe(200);
    expect((await call("/api/mcp/capabilities/nip98", refreshed.token, {
      sessionId: "session-a", url: "https://evil.example/api/v4/flightdeck-pg/tasks", method: "POST", bodyHash: "ab".repeat(32),
    })).status).toBe(403);
  });

  test("enforces event kind, content and tag policy and produces NAK-verifiable output", async () => {
    const issued = issue();
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, { sessionId: "session-a", event: { kind: 2, content: "x", tags: [] } })).status).toBe(403);
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, { sessionId: "session-a", event: { kind: 1, content: "x".repeat(101), tags: [] } })).status).toBe(400);
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, { sessionId: "session-a", event: { kind: 1, content: "x", tags: [["x", "bad"]] } })).status).toBe(403);
    expect((await call("/api/mcp/capabilities/nostr-event", issued.token, { sessionId: "session-a", event: { kind: 1, content: "x", tags: [["p", "x".repeat(65_537)]] } })).status).toBe(400);
    const response = await call("/api/mcp/capabilities/nostr-event", issued.token, { sessionId: "session-a", event: { kind: 1, content: "nak compatible", tags: [] } });
    const { event } = await response.json() as { event: unknown };
    const verified = Bun.spawnSync(["nak", "verify"], { stdin: Buffer.from(JSON.stringify(event)), stdout: "pipe", stderr: "pipe" });
    expect(verified.exitCode).toBe(0);
  });

  test("encrypts and decrypts only for allowed NIP-44 peers", async () => {
    const issued = issue();
    const encryptedResponse = await call("/api/mcp/capabilities/nip44/encrypt", issued.token, { sessionId: "session-a", plaintext: "hello", recipientPubkey: botPubkeyB });
    const encrypted = await encryptedResponse.json() as { ciphertext: string };
    expect(nip44Decrypt(encrypted.ciphertext, botSecretB, botPubkeyA)).toBe("hello");
    const inbound = nip44Encrypt("reply", botSecretB, botPubkeyA);
    const decryptedResponse = await call("/api/mcp/capabilities/nip44/decrypt", issued.token, { sessionId: "session-a", ciphertext: inbound, senderPubkey: botPubkeyB });
    expect(await decryptedResponse.json()).toMatchObject({ plaintext: "reply", decryptedBy: botPubkeyA });
    const stranger = getPublicKey(generateSecretKey());
    expect((await call("/api/mcp/capabilities/nip44/encrypt", issued.token, { sessionId: "session-a", plaintext: "x", recipientPubkey: stranger })).status).toBe(403);
  });

  test("binds Blossom server, method, hash and object size", async () => {
    const issued = issue();
    const hash = "ab".repeat(32);
    const response = await call("/api/mcp/capabilities/blossom/authorize", issued.token, { sessionId: "session-a", server: "https://blossom.example/upload", method: "upload", objectHash: hash, objectSize: 100 });
    expect(response.status).toBe(200);
    const body = await response.json() as { event: { kind: number; pubkey: string } };
    expect(body.event).toMatchObject({ kind: 24_242, pubkey: botPubkeyA });
    expect((await call("/api/mcp/capabilities/blossom/authorize", issued.token, { sessionId: "session-a", server: "https://other.example", method: "upload", objectHash: hash, objectSize: 100 })).status).toBe(403);
    expect((await call("/api/mcp/capabilities/blossom/authorize", issued.token, { sessionId: "session-a", server: "https://blossom.example", method: "upload", objectHash: hash, objectSize: 2_000 })).status).toBe(403);
  });

  test("keeps wallet reads and bounded fake spending distinct", async () => {
    const issued = issue();
    expect((await call("/api/mcp/capabilities/wallet", issued.token, { sessionId: "session-a", method: "get_balance", params: {} })).status).toBe(200);
    expect((await call("/api/mcp/capabilities/wallet", issued.token, { sessionId: "session-a", method: "pay_invoice", amountMsats: 1_000, params: {} })).status).toBe(200);
    expect((await call("/api/mcp/capabilities/wallet", issued.token, { sessionId: "session-a", method: "pay_invoice", amountMsats: 600, params: {} })).status).toBe(403);
    expect(walletCalls).toHaveLength(1);
  });

  test("reserves cumulative wallet budget across concurrent spends", async () => {
    const issued = issue();
    const responses = await Promise.all([1_000, 1_000].map((amountMsats) => call("/api/mcp/capabilities/wallet", issued.token, {
      sessionId: "session-a", method: "pay_invoice", amountMsats, params: {},
    })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
  });

  test("audit records contain metadata but never tokens, plaintext, ciphertext or wallet params", async () => {
    const issued = issue();
    await call("/api/mcp/capabilities/nip44/encrypt", issued.token, { sessionId: "session-a", plaintext: "top-secret", recipientPubkey: botPubkeyB });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).toContain(issued.capabilityId);
  });

  test("applies per-capability rate limits under concurrency", async () => {
    const issued = issue("session-a", ownerA, { maxCallsPerMinute: 2 });
    const calls = await Promise.all([1, 2, 3].map((index) => call("/api/mcp/capabilities/nostr-event", issued.token, {
      sessionId: "session-a", event: { kind: 1, content: String(index), tags: [] },
    })));
    expect(calls.map((response) => response.status).sort()).toEqual([200, 200, 429]);
    const denied = calls.find((response) => response.status === 429)!;
    expect(denied.headers.get("retry-after")).toBe("60");
    expect(denied.headers.get("x-ratelimit-limit")).toBe("2");
    expect(await denied.json()).toMatchObject({
      code: "capability_rate_limited",
      capabilityId: issued.capabilityId,
      sessionId: "session-a",
      operation: "nostr.sign",
      rateLimit: { currentCount: 2, limit: 2, windowMs: 60_000, retryAfterMs: 60_000 },
    });
    expect(audit.find((entry) => entry.outcome === "denied" && entry.reason === "Capability rate limit exceeded")).toMatchObject({
      capabilityId: issued.capabilityId,
      sessionId: "session-a",
      operation: "nostr.sign",
      outcome: "denied",
      rateLimit: { currentCount: 2, limit: 2, retryAfterMs: 60_000 },
    });
  });
});
