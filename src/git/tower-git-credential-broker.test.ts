import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import type { SessionSnapshot } from "../agents/process-manager";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";
import { TowerGitCredentialBroker } from "./tower-git-credential-broker";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const repositoryId = "22222222-2222-4222-8222-222222222222";
const botNpub = "npub1agent";
const session: SessionSnapshot = {
  id: "session-a",
  agent: "codex",
  port: 3700,
  name: "Agent",
  status: "running",
  startedAt: new Date().toISOString(),
  command: [],
  workingDirectory: "/tmp",
  logs: [],
  metadata: { AGENT: true, billingMode: "subscription", flightdeckWorkspaceId: workspaceId },
};

function subscription(overrides: Partial<WorkspaceSubscriptionRecord> = {}): WorkspaceSubscriptionRecord {
  return {
    subscriptionId: "subscription-a",
    workspaceOwnerNpub: "npub1owner",
    backendBaseUrl: "https://tower.example.test",
    towerServiceNpub: "npub1tower",
    workspaceId,
    workspaceServiceNpub: "npub1workspace",
    botNpub,
    sourceAppNpub: "npub1app",
    onboardingSource: "manual",
    lifecycleStatus: "active",
    lifecycleChangedAt: new Date().toISOString(),
    wsKeyNpub: null,
    wsKeyStatus: "active",
    groupKeyStatus: "active",
    sseStatus: "connected",
    healthStatus: "healthy",
    triggerConfigRecordId: null,
    lastSseEventId: null,
    lastAuthOkAt: null,
    lastGroupRefreshAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedByNpub: "npub1manager",
    wsKeyBlobJson: null,
    wrappedGroupKeysJson: null,
    lastAuthResult: null,
    lastGroupRefreshResult: null,
    lastRecordPullResult: null,
    lastDecryptResult: null,
    lastRoutingResult: null,
    lastSseEvent: null,
    recentSseEvents: [],
    recentDispatches: [],
    lastSuccessfulStartupReloadAt: null,
    ...overrides,
  };
}

function serviceMetadata() {
  return {
    identity: { tower_service_npub: null },
    service: { base_url: "https://tower.example.test", service_npub: "npub1tower" },
    git: { gateway_origins: ["https://git.example.test"], audience: "wingman-git" },
  };
}

describe("TowerGitCredentialBroker", () => {
  test("discovers only the active workspace and bot binding", async () => {
    const requests: Request[] = [];
    const broker = new TowerGitCredentialBroker({
      listSubscriptions: () => [
        subscription(),
        subscription({ subscriptionId: "foreign", workspaceId: "33333333-3333-4333-8333-333333333333" }),
      ],
      fetch: mock(async (request: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(request, init));
        return Response.json(serviceMetadata());
      }) as typeof fetch,
    });
    const signNip98 = mock(async () => "Nostr proof");
    expect(await broker.discover({ session, botNpub, workspaceId, signNip98 })).toEqual({
      gatewayOrigins: ["https://git.example.test"],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://tower.example.test/api/v4/flightdeck-pg/service");
    expect(requests[0]!.headers.get("x-flightdeck-pg-app-npub")).toBe("npub1app");
  });

  test("resolves the canonical path and exchanges an exact body-hashed request", async () => {
    const signed: Array<{ url: string; method: string; bodyHash?: string }> = [];
    let exchangeBody = "";
    const broker = new TowerGitCredentialBroker({
      listSubscriptions: () => [subscription()],
      getAutopilotInstanceNpub: () => "npub1autopilot",
      fetch: mock(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(request));
        if (url.pathname.endsWith("/service")) return Response.json(serviceMetadata());
        if (url.pathname.endsWith("/resolve")) {
          expect(url.searchParams.get("path")).toBe("/studio/project.git");
          return Response.json({ canonical_path: "/studio/project.git", repository: { repository_id: repositoryId, workspace_id: workspaceId } });
        }
        exchangeBody = String(init?.body);
        return Response.json({
          username: "nostr",
          capability: "opaque-capability-material",
          expires_at: "2030-01-01T00:00:00.000Z",
          repository_id: repositoryId,
          audience: "wingman-git",
        }, { status: 201 });
      }) as typeof fetch,
    });
    const credential = await broker.exchange({
      session,
      botNpub,
      workspaceId,
      request: {
        protocol: "https",
        host: "git.example.test",
        gatewayOrigin: "https://git.example.test",
        path: "/studio/project.git",
        organization: "studio",
        repository: "project",
      },
      signNip98: async (input) => {
        signed.push(input);
        return "Nostr proof";
      },
    });
    expect(credential).toEqual({
      username: "nostr",
      password: "opaque-capability-material",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(exchangeBody)).toEqual({
      repository_id: repositoryId,
      audience: "wingman-git",
      session_id: "session-a",
      autopilot_instance_npub: "npub1autopilot",
    });
    expect(signed.at(-1)).toEqual({
      url: "https://tower.example.test/api/v4/git/credential-exchanges",
      method: "POST",
      bodyHash: createHash("sha256").update(exchangeBody).digest("hex"),
    });
  });

  test("rejects unadvertised gateways before repository resolution", async () => {
    const fetchImpl = mock(async () => Response.json(serviceMetadata()));
    const broker = new TowerGitCredentialBroker({
      listSubscriptions: () => [subscription()],
      fetch: fetchImpl as typeof fetch,
    });
    await expect(broker.exchange({
      session,
      botNpub,
      workspaceId,
      request: {
        protocol: "https",
        host: "foreign.example.test",
        gatewayOrigin: "https://foreign.example.test",
        path: "/studio/project.git",
        organization: "studio",
        repository: "project",
      },
      signNip98: async () => "Nostr proof",
    })).rejects.toThrow("not advertised");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rejects service metadata for a different Tower identity", async () => {
    const broker = new TowerGitCredentialBroker({
      listSubscriptions: () => [subscription()],
      fetch: mock(async () => Response.json({
        ...serviceMetadata(),
        identity: { tower_service_npub: "npub1differenttower" },
      })) as typeof fetch,
    });
    await expect(broker.discover({
      session,
      botNpub,
      workspaceId,
      signNip98: async () => "Nostr proof",
    })).rejects.toThrow("does not match the active connection");
  });

  test("rejects an expired capability and renews on the next exchange", async () => {
    let exchangeCount = 0;
    const broker = new TowerGitCredentialBroker({
      listSubscriptions: () => [subscription()],
      fetch: mock(async (request: RequestInfo | URL) => {
        const url = new URL(String(request));
        if (url.pathname.endsWith("/service")) return Response.json(serviceMetadata());
        if (url.pathname.endsWith("/resolve")) {
          return Response.json({
            canonical_path: "/studio/project.git",
            repository: { repository_id: repositoryId, workspace_id: workspaceId },
          });
        }
        exchangeCount += 1;
        return Response.json({
          username: "nostr",
          capability: exchangeCount === 1 ? "expired-capability-material" : "renewed-capability-material",
          expires_at: exchangeCount === 1 ? "2020-01-01T00:00:00.000Z" : "2030-01-01T00:00:00.000Z",
          repository_id: repositoryId,
          audience: "wingman-git",
        }, { status: 201 });
      }) as typeof fetch,
    });
    const input = {
      session,
      botNpub,
      workspaceId,
      request: {
        protocol: "https" as const,
        host: "git.example.test",
        gatewayOrigin: "https://git.example.test",
        path: "/studio/project.git",
        organization: "studio",
        repository: "project",
      },
      signNip98: async () => "Nostr proof",
    };

    await expect(broker.exchange(input)).rejects.toThrow("malformed Git credential exchange");
    expect(await broker.exchange(input)).toMatchObject({ password: "renewed-capability-material" });
    expect(exchangeCount).toBe(2);
  });
});
