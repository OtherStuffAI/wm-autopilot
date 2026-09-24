import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import type { AgentDefinitionRecord } from "../agent-chat/types";
import { DelegationScopes } from "../auth/delegation-access";
import type { RequestAuthContext } from "../auth/request-context";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import type { WorkspaceDelegationRecord, WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import { handleControlPlaneApi, type ControlPlaneRoutesContext } from "./control-plane-routes";

const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
const delegate = nip19.npubEncode(getPublicKey(generateSecretKey()));
const wrongDelegate = nip19.npubEncode(getPublicKey(generateSecretKey()));
const botNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));

function identity(): WingmanInstanceIdentity {
  const secretKey = generateSecretKey();
  const pubkeyHex = getPublicKey(secretKey);
  return { secretKey, pubkeyHex, npub: nip19.npubEncode(pubkeyHex), nsec: nip19.nsecEncode(secretKey),
    nsecHex: Buffer.from(secretKey).toString("hex"), displayName: "Generic Autopilot", source: "generated" };
}

function agent(agentId: string, instructors: string[]): AgentDefinitionRecord {
  return {
    agentId, label: agentId, botNpub, workspaceOwnerNpub: owner,
    managedByNpub: owner, instructorNpubs: instructors, groupNpubs: [], workingDirectory: "/srv/agent",
    capabilities: ["chat_intercept"], enabled: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function auth(npub: string): RequestAuthContext {
  return { npub, actorNpub: npub, signerNpub: npub, subjectNpub: npub, targetOwnerNpub: npub,
    delegatedOwnerNpub: null, advisoryOwnerNpub: null, delegateRelationshipId: null, delegateScopes: null,
    delegateExecutionScope: null, authMethod: "nip98", session: null, capabilitySessionId: null, delegatedByBot: false };
}

function grant(overrides: Partial<WorkspaceDelegationRecord> = {}): WorkspaceDelegationRecord {
  return { id: "delegation-1", ownerNpub: owner, delegateNpub: delegate, scopes: [DelegationScopes.ControlPlaneRead],
    resourceFilters: { agentIds: ["agent-visible"] }, billingMode: "delegate", spendLimitSats: null,
    createdAt: 1, expiresAt: null, revokedAt: null, signedPayload: "{}", signature: "signature", eventId: null,
    createdBy: owner, ...overrides };
}

function context(options: { fips?: "listening" | "unavailable" | "mismatch"; delegation?: WorkspaceDelegationRecord | null } = {}): ControlPlaneRoutesContext {
  const records = [agent("agent-visible", [owner, delegate]), agent("agent-hidden", [owner])];
  const delegation = options.delegation === undefined ? grant() : options.delegation;
  const installationIdentity = identity();
  return {
    identity: installationIdentity, baseUrl: "https://autopilot.example/", baseUrlConfigured: true,
    getFipsEndpoint: () => options.fips === "unavailable"
      ? { enabled: true, nodeNpub: null, meshAddress: null, port: 3601, url: null, status: "unavailable", error: "mesh offline" }
      : options.fips === "mismatch"
        ? { enabled: true, nodeNpub: delegate, meshAddress: "fd00::1", port: 3601,
          url: `http://${delegate}.fips:3601/`, status: "listening" }
        : { enabled: true, nodeNpub: installationIdentity.npub, meshAddress: "fd00::1", port: 3601,
          url: `http://${installationIdentity.npub}.fips:3601/`, status: "listening" },
    workspaceDelegationStore: { findActiveDelegation: (candidateOwner: string, candidateDelegate: string, scope?: string) =>
      delegation && delegation.ownerNpub === candidateOwner && delegation.delegateNpub === candidateDelegate
        && (!scope || delegation.scopes.includes(scope)) ? delegation : null } as WorkspaceDelegationStore,
    agentStore: { listForManagerNpub: (npub) => npub === owner ? records : [], getByAgentId: (id) => records.find((item) => item.agentId === id) ?? null,
      canInstruct: (id, npub) => records.find((item) => item.agentId === id)?.instructorNpubs?.includes(npub ?? "") ?? false },
    now: () => new Date("2026-09-24T02:00:00Z"),
  };
}

async function request(path: string, signer: string, ctx = context()) {
  const url = new URL(`https://autopilot.example${path}`);
  return handleControlPlaneApi(new Request(url), url, "GET", auth(signer), ctx);
}

describe("control-plane routes", () => {
  test("returns stable installation and agent IDs to the owner", async () => {
    const response = await request(`/api/owners/${owner}/control-plane/v1/agents`, owner);
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.installation_id).toMatch(/^autopilot_[0-9a-f]{32}$/);
    expect(body.agents.map((item: { agent_id: string }) => item.agent_id)).toEqual(["agent-visible", "agent-hidden"]);
    expect(body.agents[0]).toEqual({
      agent_id: "agent-visible",
      bot_npub: botNpub,
      name: "agent-visible",
      description: "",
      can_instruct: true,
    });
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  test("advertises directly callable owner paths and Flight Deck-compatible health", async () => {
    const ctx = context();
    const packageUrl = new URL(`https://autopilot.example/api/control-plane/v1/connect-package?owner_npub=${owner}`);
    const packageResponse = await handleControlPlaneApi(new Request(packageUrl), packageUrl, "GET", auth(owner), ctx);
    expect(packageResponse?.status).toBe(200);
    const envelope = await packageResponse!.json();
    expect(envelope.manifest.api).toMatchObject({
      version: 1,
      health_path: `/api/owners/${owner}/control-plane/v1/health`,
      agents_path: `/api/owners/${owner}/control-plane/v1/agents`,
    });
    const health = await request(envelope.manifest.api.health_path, owner, ctx);
    expect(await health!.json()).toEqual({
      ok: true,
      installation_id: envelope.manifest.installation.id,
      installation_npub: envelope.manifest.installation.npub,
      api_version: 1,
    });
    const missingOwnerUrl = new URL("https://autopilot.example/api/control-plane/v1/connect-package");
    const missingOwner = await handleControlPlaneApi(new Request(missingOwnerUrl), missingOwnerUrl, "GET", auth(owner), ctx);
    expect(missingOwner?.status).toBe(400);
  });

  test("filters delegated discovery by scope, resource, and instructor grant", async () => {
    const response = await request(`/api/owners/${owner}/control-plane/v1/agents`, delegate);
    expect((await response!.json()).agents.map((item: { agent_id: string }) => item.agent_id)).toEqual(["agent-visible"]);
    const hidden = await request(`/api/owners/${owner}/control-plane/v1/agents/agent-hidden`, delegate);
    expect(hidden?.status).toBe(404);
    const wrong = await request(`/api/owners/${owner}/control-plane/v1/agents`, wrongDelegate);
    expect(wrong?.status).toBe(403);
    const wrongScope = await request(`/api/owners/${owner}/control-plane/v1/agents`, delegate, context({ delegation: grant({ scopes: ["sessions:read"] }) }));
    expect(wrongScope?.status).toBe(403);
    const wrongOwner = await request(`/api/owners/${wrongDelegate}/control-plane/v1/agents`, delegate);
    expect(wrongOwner?.status).toBe(403);
  });

  test("rejects requests that did not arrive through exact NIP-98 authentication", async () => {
    const url = new URL(`https://autopilot.example/api/owners/${owner}/control-plane/v1/agents`);
    const sessionAuth = { ...auth(owner), authMethod: "session" as const };
    const response = await handleControlPlaneApi(new Request(url), url, "GET", sessionAuth, context());
    expect(response?.status).toBe(401);
  });

  test("fails explicitly when FIPS is unavailable and never substitutes HTTPS", async () => {
    const ctx = context({ fips: "unavailable" });
    const packageUrl = new URL(`https://autopilot.example/api/control-plane/v1/connect-package?owner_npub=${owner}`);
    const packageResponse = await handleControlPlaneApi(new Request(packageUrl), packageUrl, "GET", auth(owner), ctx);
    expect(packageResponse?.status).toBe(503);
    expect(await packageResponse!.json()).toMatchObject({ error: "fips-transport-unavailable", detail: "mesh offline" });
    const manifest = await request(`/api/owners/${owner}/control-plane/v1/manifest`, owner, ctx);
    expect(manifest?.status).toBe(503);

    const mismatch = context({ fips: "mismatch" });
    const mismatchResponse = await handleControlPlaneApi(new Request(packageUrl), packageUrl, "GET", auth(owner), mismatch);
    expect(mismatchResponse?.status).toBe(503);
    expect(await mismatchResponse!.json()).toMatchObject({ error: "fips-identity-mismatch" });
  });
});
