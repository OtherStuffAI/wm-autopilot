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

function context(options: {
  fips?: "listening" | "unavailable" | "mismatch";
  delegation?: WorkspaceDelegationRecord | null;
  bindingMode?: "implicit_all" | "explicit";
  defaultMode?: "implicit_library" | "explicit";
} = {}): ControlPlaneRoutesContext {
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
    pipelineBindingStore: {
      getAvailabilityMode: () => options.bindingMode ?? "explicit",
      getDefaultMode: () => options.defaultMode ?? "explicit",
      listAvailableIds: () => options.bindingMode === "implicit_all" ? [] : ["shared:pipeline-a"],
      listDefaultIds: () => options.defaultMode === "implicit_library" ? [] : ["shared:pipeline-a"],
      listOverrides: () => [{ agentId: "agent-visible", kind: "channel", contextId: "channel-1", pipelineDefinitionId: "shared:pipeline-a", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
    },
    listPipelineDefinitions: async () => [{
      id: "shared:pipeline-a", slug: "pipeline-a.v1", name: "Pipeline A", scope: "shared", ownerAlias: null,
      path: "/library/pipeline-a.v1.json", spec: { name: "Pipeline A", description: "Reusable pipeline", version: 1, default: true, tags: ["example"], steps: [] },
    }],
    schedulerStore: {
      bindLegacyJobsToAgent: () => 0,
      listJobsForAgent: () => [{
        id: "trigger-1", name: "Daily review", userNpub: owner, agentId: "agent-visible", botNpub,
        wrappedKeyCiphertext: "hidden", wrappedKeyNonce: "hidden", agent: "codex", model: null,
        workingDirectory: "/private", initialPrompt: "private", nightwatchmanEnabled: false,
        triggerType: "cron", persistedTriggerType: "cron", unsupportedReason: null,
        cronExpression: "0 9 * * *", timezone: "UTC", watchDirectory: null, filePattern: "*",
        activeStartTime: null, activeEndTime: null, actionType: "pipeline", pipelineDefinitionId: "shared:pipeline-a",
        pipelineInputJson: "{}", pipelineAgent: null, wappActivityInstallationId: null, enabled: true,
        lastRunAt: null, nextRunAt: "2026-09-25T09:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }, {
        id: "watcher-1", name: "Inbox watcher", userNpub: owner, agentId: "agent-visible", botNpub,
        wrappedKeyCiphertext: "hidden", wrappedKeyNonce: "hidden", agent: "codex", model: null,
        workingDirectory: "/private", initialPrompt: "private", nightwatchmanEnabled: false,
        triggerType: "file_watcher", persistedTriggerType: "file_watcher", unsupportedReason: null,
        cronExpression: "", timezone: "UTC", watchDirectory: "/private", filePattern: "*.json",
        activeStartTime: null, activeEndTime: null, actionType: "session", pipelineDefinitionId: null,
        pipelineInputJson: null, pipelineAgent: null, wappActivityInstallationId: null, enabled: true,
        lastRunAt: "2026-09-24T01:00:00Z", nextRunAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }],
    },
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
      paths: {
        overview: `/api/owners/${owner}/control-plane/v1/agents/agent-visible/overview`,
        pipelines: `/api/owners/${owner}/control-plane/v1/agents/agent-visible/pipelines`,
        schedules: `/api/owners/${owner}/control-plane/v1/agents/agent-visible/schedules`,
        triggers: `/api/owners/${owner}/control-plane/v1/agents/agent-visible/triggers`,
      },
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

  test("requires NIP-98 owner authority before generating a connect package", async () => {
    const url = new URL(`https://autopilot.example/api/control-plane/v2/connect-package?owner_npub=${owner}`);
    const sessionResponse = await handleControlPlaneApi(
      new Request(url),
      url,
      "GET",
      { ...auth(owner), authMethod: "session", session: { npub: owner, exp: Date.now() + 60_000 } },
      context(),
    );
    expect(sessionResponse?.status).toBe(401);
    expect(await sessionResponse!.json()).toEqual({ error: "nip98-authentication-required" });

    const wrongOwnerResponse = await handleControlPlaneApi(new Request(url), url, "GET", auth(wrongDelegate), context());
    expect(wrongOwnerResponse?.status).toBe(403);
    expect(await wrongOwnerResponse!.json()).toMatchObject({
      error: "control-plane-read-authority-required",
      requiredScope: DelegationScopes.ControlPlaneRead,
    });
  });

  test("filters delegated discovery by scope, resource, and instructor grant", async () => {
    const response = await request(`/api/owners/${owner}/control-plane/v1/agents`, delegate);
    expect((await response!.json()).agents.map((item: { agent_id: string }) => item.agent_id)).toEqual(["agent-visible"]);
    const hidden = await request(`/api/owners/${owner}/control-plane/v1/agents/agent-hidden`, delegate);
    expect(hidden?.status).toBe(404);
    const hiddenBindings = await request(`/api/owners/${owner}/control-plane/v1/agents/agent-hidden/pipelines`, delegate);
    expect(hiddenBindings?.status).toBe(404);
    const hiddenSchedules = await request(`/api/owners/${owner}/control-plane/v1/agents/agent-hidden/schedules`, delegate);
    expect(hiddenSchedules?.status).toBe(404);
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

  test("returns distinct reusable definitions, assignments, defaults and overrides", async () => {
    const response = await request(`/api/owners/${owner}/control-plane/v1/agents/agent-visible/pipelines`, owner);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      installation_id: expect.stringMatching(/^autopilot_/),
      agent_id: "agent-visible",
      bot_npub: botNpub,
      availability_mode: "explicit",
      default_mode: "explicit",
      available_definitions: [{
        pipeline_definition_id: "shared:pipeline-a", name: "Pipeline A", description: "Reusable pipeline",
        scope: "shared", version: 1, tags: ["example"],
      }],
      assignments: [{ pipeline_definition_id: "shared:pipeline-a" }],
      defaults: [{ pipeline_definition_id: "shared:pipeline-a" }],
      overrides: [{ kind: "channel", context_id: "channel-1", pipeline_definition_id: "shared:pipeline-a" }],
      missing_definition_ids: [],
    });
  });

  test("keeps missing bindings backward compatible with explicit implicit modes", async () => {
    const response = await request(
      `/api/owners/${owner}/control-plane/v1/agents/agent-visible/pipelines`,
      owner,
      context({ bindingMode: "implicit_all", defaultMode: "implicit_library" }),
    );
    const body = await response!.json();
    expect(body).toMatchObject({
      availability_mode: "implicit_all",
      default_mode: "implicit_library",
      assignments: [{ pipeline_definition_id: "shared:pipeline-a" }],
      defaults: [{ pipeline_definition_id: "shared:pipeline-a" }],
    });
  });

  test("returns public schedule fields with stable agent identity and retained bot identity", async () => {
    const response = await request(`/api/owners/${owner}/control-plane/v1/agents/agent-visible/schedules`, delegate);
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body).toMatchObject({ agent_id: "agent-visible", bot_npub: botNpub });
    expect(body.schedules).toEqual([{
      schedule_id: "trigger-1", agent_id: "agent-visible", bot_npub: botNpub, name: "Daily review", enabled: true,
      cron_expression: "0 9 * * *", timezone: "UTC", active_start_time: null, active_end_time: null,
      action_type: "pipeline", pipeline_definition_id: "shared:pipeline-a", last_run_at: null,
      next_run_at: "2026-09-25T09:00:00Z",
    }]);
    expect(JSON.stringify(body)).not.toContain("initialPrompt");
    expect(JSON.stringify(body)).not.toContain("workingDirectory");
    expect(JSON.stringify(body)).not.toContain("wrappedKey");
  });

  test("returns public trigger fields filtered by stable agent identity", async () => {
    const response = await request(`/api/owners/${owner}/control-plane/v1/agents/agent-visible/triggers`, owner);
    expect(await response!.json()).toMatchObject({
      agent_id: "agent-visible",
      bot_npub: botNpub,
      triggers: [{
        trigger_id: "watcher-1", agent_id: "agent-visible", bot_npub: botNpub, name: "Inbox watcher",
        enabled: true, trigger_type: "file_watcher", file_pattern: "*.json", action_type: "session",
        pipeline_definition_id: null, last_run_at: "2026-09-24T01:00:00Z",
      }],
    });
  });

  test("fails explicitly when FIPS is unavailable and never substitutes HTTPS", async () => {
    const ctx = context({ fips: "unavailable" });
    const packageUrl = new URL(`https://autopilot.example/api/control-plane/v1/connect-package?owner_npub=${owner}`);
    const packageResponse = await handleControlPlaneApi(new Request(packageUrl), packageUrl, "GET", auth(owner), ctx);
    expect(packageResponse?.status).toBe(503);
    expect(await packageResponse!.json()).toMatchObject({ error: "fips-transport-unavailable", detail: "mesh offline" });
    const unavailableV2Url = new URL(`https://autopilot.example/api/control-plane/v2/connect-package?owner_npub=${owner}`);
    const unavailableV2 = await handleControlPlaneApi(new Request(unavailableV2Url), unavailableV2Url, "GET", auth(owner), ctx);
    expect(unavailableV2?.status).toBe(503);
    expect(await unavailableV2!.json()).toMatchObject({ error: "fips-transport-unavailable", detail: "mesh offline" });
    const manifest = await request(`/api/owners/${owner}/control-plane/v1/manifest`, owner, ctx);
    expect(manifest?.status).toBe(503);

    const mismatch = context({ fips: "mismatch" });
    const mismatchResponse = await handleControlPlaneApi(new Request(packageUrl), packageUrl, "GET", auth(owner), mismatch);
    expect(mismatchResponse?.status).toBe(503);
    expect(await mismatchResponse!.json()).toMatchObject({ error: "fips-identity-mismatch" });

    const v2Url = new URL(`https://autopilot.example/api/control-plane/v2/connect-package?owner_npub=${owner}`);
    const v2Response = await handleControlPlaneApi(new Request(v2Url), v2Url, "GET", auth(owner), mismatch);
    expect(v2Response?.status).toBe(200);
    const v2 = await v2Response!.json();
    expect(v2.manifest).toMatchObject({
      version: 2,
      installation: { npub: mismatch.identity!.npub },
      transport: { fips: { npub: delegate } },
      endpoints: { fips: `http://${delegate}.fips:3601` },
      api: { version: 1 },
    });

    const health = await request(`/api/owners/${owner}/control-plane/v1/health`, owner, mismatch);
    expect(health?.status).toBe(200);
    expect(await health!.json()).toMatchObject({ installation_npub: mismatch.identity!.npub });
  });
});
