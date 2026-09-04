import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";

import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy } from "./capability-broker";

const ownerNpub = "npub1owner";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);
const botNpub = nip19.npubEncode(pubkey);
const botRecord: BotKeyRecord = {
  id: "bot-a",
  userNpub: ownerNpub,
  botNpub,
  botPubkeyHex: pubkey,
  displayName: "Agent",
  encryptedToUser: "unused",
  encryptedEscrow: "unused",
  escrowUuid: "unused",
  isActive: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function buildFixture(options: { workspaceBinding?: boolean; exchangeError?: Error } = {}) {
  const session: SessionSnapshot = {
    id: "session-a",
    agent: "codex",
    port: 3700,
    name: "Agent",
    status: "running",
    startedAt: new Date().toISOString(),
    npub: ownerNpub,
    command: [],
    workingDirectory: "/tmp",
    logs: [],
    metadata: { AGENT: true, billingMode: "subscription", agentChatBotNpub: botNpub },
  };
  const audit: unknown[] = [];
  let signedEvent: Record<string, unknown> | null = null;
  const broker = new CapabilityBroker({
    botKeyStore: { getActiveKeyForUser: () => botRecord, getActiveKeyForBotNpub: () => botRecord },
    keyVault: { withKey: async (_record, operation) => operation(new Uint8Array(secretKey)) },
    getSession: (sessionId) => sessionId === session.id ? session : null,
    audit: (entry) => audit.push(entry),
    gitCredential: {
      discover: async () => ({ gatewayOrigins: ["https://git.example.test"] }),
      exchange: async ({ signNip98 }) => {
        if (options.exchangeError) throw options.exchangeError;
        const token = await signNip98({
          url: "https://tower.example.test/api/v4/git/credential-exchanges",
          method: "POST",
          bodyHash: "ab".repeat(32),
        });
        signedEvent = JSON.parse(Buffer.from(token.slice("Nostr ".length), "base64").toString("utf8"));
        return { username: "nostr", password: "ephemeral-secret", expiresAt: "2030-01-01T00:00:00.000Z" };
      },
    },
  });
  const policy = buildDefaultAgentCapabilityPolicy({
    towerUrl: "https://tower.example.test",
    autopilotUrl: "https://autopilot.example.test",
  });
  const issued = broker.issueSessionCapability({
    sessionId: session.id,
    ownerNpub,
    botNpub,
    workspaceId: options.workspaceBinding === false ? null : workspaceId,
    policy,
  });
  const call = (body: Record<string, unknown>) => {
    const url = new URL("http://127.0.0.1/api/mcp/capabilities/git-credential");
    return broker.handle(new Request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
        "x-wingman-capability-nonce": crypto.randomUUID(),
      },
      body: JSON.stringify({ sessionId: session.id, ...body }),
    }), url, "POST") as Promise<Response>;
  };
  return { audit, call, getSignedEvent: () => signedEvent };
}

describe("Tower Git session capability boundary", () => {
  test("binds the request to the workspace session and signs an exact payload-hashed NIP-98 exchange", async () => {
    const fixture = buildFixture();
    const response = await fixture.call({
      protocol: "https",
      host: "git.example.test",
      path: "/studio/project.git",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      username: "nostr",
      password: "ephemeral-secret",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const event = fixture.getSignedEvent()! as { kind: number; tags: string[][] };
    expect(verifyEvent(event as never)).toBe(true);
    expect(event.tags).toEqual([
      ["u", "https://tower.example.test/api/v4/git/credential-exchanges"],
      ["method", "POST"],
      ["payload", "ab".repeat(32)],
    ]);
    expect(JSON.stringify(fixture.audit)).not.toContain("ephemeral-secret");
  });

  test("rejects a session without a Tower workspace binding", async () => {
    const response = await buildFixture({ workspaceBinding: false }).call({
      protocol: "https",
      host: "git.example.test",
      path: "/studio/project.git",
    });
    expect(response.status).toBe(403);
  });

  test("redacts adapter failures from the helper response and audit", async () => {
    const fixture = buildFixture({ exchangeError: new Error("provider returned ephemeral-secret") });
    const response = await fixture.call({
      protocol: "https",
      host: "git.example.test",
      path: "/studio/project.git",
    });
    expect(response.status).toBe(502);
    const serialized = JSON.stringify({ body: await response.json(), audit: fixture.audit });
    expect(serialized).not.toContain("ephemeral-secret");
  });
});
