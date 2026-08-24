import { describe, expect, test } from "bun:test";

import { createApiRouteHandler } from "./api-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { WorkspaceSubscriptionManager } from "../agent-chat/subscription-runtime";
import type { CloudflareTunnelClient } from "../cloudflare/tunnel-hostnames";
import type { AgentChatApiContext } from "./agent-chat-routes";
import type { CloudflareTunnelRoutesContext } from "./cloudflare-tunnel-routes";

const anonymousAuth: RequestAuthContext = {
  npub: null,
  actorNpub: null,
  session: null,
  delegatedByBot: false,
};

function createHandler(options: {
  authContext?: RequestAuthContext;
  settings?: Record<string, string>;
  onSet?: (npub: string, key: string, value: string) => void;
  config?: Record<string, unknown>;
  agentChatApiContext?: AgentChatApiContext;
  cloudflareTunnelRoutesContext?: CloudflareTunnelRoutesContext;
  resolveNip98AuthContext?: (request: Request, url: URL, auth: RequestAuthContext) => Promise<RequestAuthContext>;
  terminalConfigured?: boolean;
  adminNpubs?: string[];
  npubProjectApiHandler?: (...args: any[]) => Promise<Response | null>;
  wingmanMcpApiHandler?: (...args: any[]) => Promise<Response | null>;
  capabilityBrokerApiHandler?: (...args: any[]) => Promise<Response | null>;
  requestIp?: string;
} = {}) {
  const authContext = options.authContext ?? anonymousAuth;
  const settings = options.settings ?? {};

  return createApiRouteHandler({
    config: {
      port: 3000,
      baseUrl: "http://localhost:3000",
      agentPortStart: 4000,
      agentPortMax: 4999,
      hostUrlBase: null,
      appRoutingMode: "path",
      subdomainBaseDomain: null,
      subdomainProxyEnabled: false,
      connectRelays: [],
      agents: {
        claude: { label: "Claude" },
        codex: { label: "Codex", modelOptions: ["default", "gpt-5.5"] },
        goose: { label: "Goose", modelOptions: ["default", "openrouter/moonshotai/kimi-k3"] },
        opencode: {
          label: "OpenCode",
          modelOptions: [
            "default",
            "opencode/big-pickle",
            "openrouter/moonshotai/kimi-k3",
            "maple/kimi-k2-thinking",
            "maple/qwen3-coder-480b",
            "maple/gpt-oss-120b",
            "maple/llama-3.3-70b",
            "ollama/gemma4:e4b",
          ],
        },
        gemini: { label: "Gemini" },
        pi: { label: "Pi" },
      },
      defaultAgent: "claude",
      giteaUrl: null,
      ...options.config,
    },
    adminNpub: options.adminNpubs?.[0] ?? null,
    adminNpubs: options.adminNpubs,
    todoApiHandler: async () => null,
    projectApiHandler: async () => null,
    npubProjectApiHandler: options.npubProjectApiHandler ?? (async () => null),
    browserLogHandler: async () => null,
    caproverApiHandler: async () => null,
    nightWatchApiHandler: async () => null,
    nip98ApiHandler: async () => null,
    botCryptoApiHandler: async () => null,
    botKeyApiHandler: async () => null,
    giteaApiHandler: async () => null,
    gitWorkflowApiHandler: async () => null,
    ngitApiHandler: async () => null,
    wingmanMcpApiHandler: options.wingmanMcpApiHandler ?? (async () => null),
    capabilityBrokerApiHandler: options.capabilityBrokerApiHandler,
    getRequestIP: options.requestIp ? () => ({ address: options.requestIp! }) : undefined,
    schedulerApiHandler: async () => null,
    schedulerStore: {} as any,
    auditExecution: () => {},
    sessionApiContext: {} as any,
    docsApiContext: {} as any,
    providerProxyApiContext: {} as any,
    billingApiContext: {} as any,
    systemRoutesContext: {} as any,
    authApiContext: {} as any,
    adminUsersApiContext: {} as any,
    uploadApiContext: {} as any,
    voiceNoteUploadApiContext: {} as any,
    agentChatApiContext: options.agentChatApiContext,
    delegationRoutesContext: {} as any,
    terminalRoutesContext: {
      pinService: { isConfigured: () => options.terminalConfigured === true },
    } as any,
    userSettingsRoutesContext: {
      agents: {
        claude: { label: "Claude" },
        codex: { label: "Codex" },
        goose: { label: "Goose" },
        opencode: { label: "OpenCode" },
        gemini: { label: "Gemini" },
        pi: { label: "Pi" },
      },
      userSettingsStore: {
        getAll: (npub: string) => (npub === authContext.npub ? settings : {}),
        set: (npub: string, key: string, value: string) => {
          options.onSet?.(npub, key, value);
        },
        delete: () => true,
      },
      ensureApiAccess: async (_action, _request, _url, currentAuth) =>
        currentAuth.npub ? null : Response.json({ error: "Authentication required" }, { status: 401 }),
      AccessActions: {
        SessionsManage: "sessions:manage" as any,
      },
    },
    instanceSettingsRoutesContext: {
      service: {
        get: (key: string) => options.settings?.[key] ?? null,
      } as any,
      ensureApiAccess: async (_action, _request, _url, currentAuth) =>
        currentAuth.npub ? null : Response.json({ error: "Authentication required" }, { status: 401 }),
      AccessActions: {
        SystemManage: "system:manage" as any,
      },
    },
    remoteInstructRoutesContext: {
      promptPath: "/tmp/remote-instruct.md",
      config: {
        baseUrl: "http://localhost:3000",
        agents: {
          claude: { label: "Claude" },
          codex: { label: "Codex" },
        },
      },
      getDefaultWorkdir: () => "/tmp/project",
      projectReference: "autopilot",
      resolveNip98AuthContext: async () => authContext,
      ensureApiAccess: async (_action, _request, _url, currentAuth) =>
        currentAuth.npub ? null : Response.json({ error: "Authentication required" }, { status: 401 }),
      ensureTemplateManageAccess: async (_request, _url, currentAuth) =>
        currentAuth.npub ? null : Response.json({ error: "admin-only" }, { status: 403 }),
      AccessActions: {
        SessionsManage: "sessions:manage" as any,
      },
    },
    cloudflareTunnelRoutesContext: options.cloudflareTunnelRoutesContext,
    workspaceDelegationStore: {} as any,
    featureFlagStore: {
      getFlag: () => null,
    },
    userSettingsStore: {
      getAll: (npub: string) => (npub === authContext.npub ? settings : {}),
      set: (npub: string, key: string, value: string) => {
        options.onSet?.(npub, key, value);
      },
      delete: () => true,
    },
    artifactsStore: {
      get: () => null,
    },
    PROJECTS_FLAG_KEY: "projects",
    resolveWorkspace: () => ({
      isAdmin: false,
      defaultDirectory: "/tmp/project",
      allowedDirectories: ["/tmp/project"],
    } as any),
    verifyNip98AuthHeader: async () => authContext.npub ? { signerNpub: authContext.npub } : null,
    resolveNip98AuthContext: options.resolveNip98AuthContext ?? (async () => authContext),
    resolveFeatureFlagStateForViewer: () => ({ effectiveState: "on" }),
    ensureApiAccess: async (_action, _request, _url, currentAuth) =>
      currentAuth.npub ? null : Response.json({ error: "Authentication required" }, { status: 401 }),
    serialiseFeatureFlagsForViewer: () => [],
    listDirectories: async () => [],
    createDirectoryEntry: async () => ({}),
    AccessActions: {
      ProjectsManage: "projects:manage" as any,
      TodosManage: "todos:manage" as any,
      SessionsManage: "sessions:manage" as any,
      DeploymentsManage: "deployments:manage" as any,
      SystemManage: "system:manage" as any,
      FilesRead: "files:read" as any,
      FilesWrite: "files:write" as any,
    },
    buildStarterProjectsContext: () => ({} as any),
    buildAppsContext: () => ({} as any),
    buildFeatureFlagsContext: () => ({} as any),
    buildChatContext: () => ({} as any),
  });
}

describe("createApiRouteHandler config defaults", () => {
  test("exposes only terminal configured state", async () => {
    const handler = createHandler({ terminalConfigured: true });
    const url = new URL("http://localhost/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.terminalConfigured).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("pin_verifier");
    expect(JSON.stringify(payload)).not.toContain("ciphertext");
  });

  test("returns 404 for every removed SuperBased endpoint", async () => {
    const handler = createHandler();
    const endpoints = [
      ["GET", "/api/superbased/health"],
      ["GET", "/api/superbased/records?owner_pubkey=owner"],
      ["POST", "/api/superbased/sync"],
      ["GET", "/api/superbased/history?record_id=record"],
      ["GET", "/api/superbased/storage/object-1/download-url"],
    ] as const;

    for (const [method, path] of endpoints) {
      const url = new URL(path, "http://localhost:3000");
      const request = new Request(url.toString(), {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ base_url: "http://127.0.0.1" }) }
          : {}),
      });
      const response = await handler(request, url, method, anonymousAuth);
      expect(response.status).toBe(404);
    }
  });

  test("resolves NIP-98 auth before routing Cloudflare tunnel writes", async () => {
    const nip98Auth: RequestAuthContext = {
      npub: "npub1operator",
      actorNpub: "npub1operator",
      signerNpub: "npub1operator",
      session: null,
      authMethod: "nip98",
    };
    let resolved = false;
    const handler = createHandler({
      cloudflareTunnelRoutesContext: {
        AccessActions: { AppsManage: "apps:manage" },
        ensureApiAccess: async (_action: unknown, _request: Request, _url: URL, auth: RequestAuthContext) =>
          auth.npub ? null : Response.json({ error: "auth-required" }, { status: 401 }),
        getClient: () => ({
          upsertPublicHostname: async () => ({
            hostname: "other-buzz.agent.example.invalid",
            serviceUrl: "http://localhost:3035",
            tunnelId: "tunnel-1",
            cnameTarget: "tunnel-1.cfargotunnel.com",
            dnsRecordId: "dns-1",
          }),
        }) as unknown as CloudflareTunnelClient,
      },
      resolveNip98AuthContext: async () => {
        resolved = true;
        return nip98Auth;
      },
    });
    const url = new URL("http://localhost:3000/api/cloudflare/tunnel-hostnames");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { authorization: "Nostr test", "content-type": "application/json" },
      body: JSON.stringify({
        hostname: "other-buzz.agent.example.invalid",
        serviceUrl: "http://localhost:3035",
      }),
    });

    const response = await handler(request, url, "POST", anonymousAuth);

    expect(resolved).toBe(true);
    expect(response.status).toBe(201);
  });

  test("routes Flight Deck dispatch outcomes through the outer API handler", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1manager",
      actorNpub: "npub1manager",
      session: null,
      delegatedByBot: false,
    };
    const manager = {
      listDispatchOutcomesForManager: (npub: string, page: { limit: number; offset: number }) => ({
        rows: [{ actionId: "session-1" }],
        total: 1,
        ...page,
        managerNpub: npub,
      }),
    } as unknown as WorkspaceSubscriptionManager;
    const handler = createHandler({ authContext, agentChatApiContext: { manager } });
    const url = new URL("http://localhost:3000/api/agent-chat/dispatch-outcomes?limit=25&offset=0");
    const response = await handler(new Request(url.toString()), url, "GET", authContext);
    const body = await response.json() as {
      rows: Array<{ actionId: string }>;
      total: number;
      limit: number;
      offset: number;
      includeIgnoredAndSuppressed: boolean;
      managerNpub: string;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      rows: [{ actionId: "session-1" }],
      total: 1,
      limit: 25,
      offset: 0,
      includeIgnoredAndSuppressed: false,
      managerNpub: "npub1manager",
    });
  });

  test("routes authenticated Agent Profile creation through the outer API handler", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1manager",
      actorNpub: "npub1manager",
      session: null,
      delegatedByBot: false,
    };
    const handler = createHandler({
      authContext,
      agentChatApiContext: {
        manager: {} as WorkspaceSubscriptionManager,
        publishAgentProfile: async () => ({ eventId: "event-1", published: 1 }),
      },
    });
    const url = new URL("http://localhost:3000/api/agent-chat/profiles");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await handler(request, url, "POST", authContext);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("profileId, label, workingDirectory, and harness are required");
  });

  test("requires authentication for Agent Profile creation at the outer API boundary", async () => {
    const handler = createHandler({
      agentChatApiContext: { manager: {} as WorkspaceSubscriptionManager },
    });
    const url = new URL("http://localhost:3000/api/agent-chat/profiles");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await handler(request, url, "POST", anonymousAuth);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Authentication required");
  });

  test("returns instance branding with configured values", async () => {
    const handler = createHandler({
      settings: {
        "branding.name": "Example Agent",
        "branding.highlight_color": "#a855f7",
      },
    });
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as { branding: { name: string; highlightColor: string } };

    expect(body.branding).toEqual({ name: "Example Agent", highlightColor: "#a855f7" });
  });

  test("returns a per-user default agent override from user settings", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const handler = createHandler({
      authContext,
      settings: { default_agent: "pi" },
    });

    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", authContext);
    const body = await response.json() as { defaultAgent: string; systemDefaultAgent: string };

    expect(response.status).toBe(200);
    expect(body.defaultAgent).toBe("pi");
    expect(body.systemDefaultAgent).toBe("claude");
  });

  test("returns hosted app routing config", async () => {
    const handler = createHandler();
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as {
      baseUrl: string;
      appRoutingMode: string;
      subdomainBaseDomain: string | null;
      subdomainProxyEnabled: boolean;
    };

    expect(body).toMatchObject({
      baseUrl: "http://localhost:3000",
      appRoutingMode: "path",
      subdomainBaseDomain: null,
      subdomainProxyEnabled: false,
    });
  });

  test("returns agent model options", async () => {
    const handler = createHandler();
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as {
      agents: Array<{ id: string; label: string; modelOptions: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.agents).toContainEqual({
      id: "codex",
      label: "Codex",
      modelOptions: ["default", "gpt-5.5"],
    });
    expect(body.agents).toContainEqual({
      id: "claude",
      label: "Claude",
      modelOptions: ["default"],
    });
    expect(body.agents).toContainEqual({
      id: "opencode",
      label: "OpenCode",
      modelOptions: [
        "default",
        "opencode/big-pickle",
        "openrouter/moonshotai/kimi-k3",
        "maple/kimi-k2-thinking",
        "maple/qwen3-coder-480b",
        "maple/gpt-oss-120b",
        "maple/llama-3.3-70b",
        "ollama/gemma4:e4b",
      ],
    });
  });

  test("returns the saved OpenRouter list for supported launchers without replacing native vocabularies", async () => {
    const handler = createHandler({
      settings: {
        "models.providers": JSON.stringify({
          providers: {
            openrouter: {
              models: ["qwen/qwen3.7-flash", "anthropic/claude-opus-5-fast"],
            },
          },
        }),
      },
    });
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as {
      agents: Array<{ id: string; modelOptions: string[] }>;
    };
    const byId = new Map(body.agents.map((agent) => [agent.id, agent.modelOptions]));
    const configured = ["default", "qwen/qwen3.7-flash", "anthropic/claude-opus-5-fast"];

    expect(byId.get("goose")).toEqual(configured);
    expect(byId.get("opencode")).toEqual(configured);
    expect(byId.get("pi")).toEqual(configured);
    expect(byId.get("codex")).toEqual(["default", "gpt-5.5"]);
    expect(byId.get("claude")).toEqual(["default"]);
  });

  test("uses the resolved provider model catalogue for agent profile creation", async () => {
    const ownerNpub = "npub1owner";
    const authContext: RequestAuthContext = {
      npub: ownerNpub,
      actorNpub: ownerNpub,
      session: null,
      delegatedByBot: false,
    };
    let createdModel: string | null | undefined;
    let storedAgent: Record<string, unknown> | null = null;
    const now = new Date().toISOString();
    const manager = {
      createAgentProfileForManager: async (input: Record<string, unknown>) => {
        createdModel = input.model as string | null;
        storedAgent = {
          agentId: "Builder",
          label: "Builder",
          botNpub: "npub1Builder",
          workspaceOwnerNpub: ownerNpub,
          managedByNpub: ownerNpub,
          groupNpubs: [],
          workingDirectory: "/tmp/project",
          harness: "goose",
          model: createdModel,
          publicProfile: { name: "Builder", picture: null, about: null, nip05: null },
          capabilities: ["chat_intercept"],
          directChat: {
            enabled: true,
            sessionAgent: "goose",
            directory: "/tmp/project",
            model: createdModel,
            idleRetentionMinutes: 60,
          },
          enabled: true,
          archived: false,
          createdAt: now,
          updatedAt: now,
        };
        return {
          agent: storedAgent,
          signedProfileEvent: {
            id: "event-id",
            pubkey: "00".repeat(32),
            created_at: 1,
            kind: 0,
            tags: [],
            content: "{}",
            sig: "11".repeat(64),
          },
        };
      },
      getAgentForManager: () => storedAgent,
      validateAgentWorkingDirectory: async () => undefined,
      saveAgentForManager: async (input: Record<string, unknown>) => {
        storedAgent = input;
        return input;
      },
    } as unknown as WorkspaceSubscriptionManager;
    const handler = createHandler({
      authContext,
      settings: {
        "models.providers": JSON.stringify({
          providers: { openrouter: { models: ["deepseek/deepseek-v4-flash-0731"] } },
        }),
      },
      agentChatApiContext: {
        manager,
        publishAgentProfile: async () => ({ published: 1 }),
      },
    });
    const create = async (harness: string) => {
      const url = new URL("http://localhost:3000/api/agent-chat/profiles");
      return handler(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: "Builder",
          label: "Builder",
          workingDirectory: "/tmp/project",
          harness,
          model: "deepseek/deepseek-v4-flash-0731",
        }),
      }), url, "POST", authContext);
    };

    const accepted = await create("goose");
    expect(accepted?.status).toBe(201);
    expect(createdModel).toBe("deepseek/deepseek-v4-flash-0731");

    const patchUrl = new URL("http://localhost:3000/api/agent-chat/profiles/Builder");
    const patched = await handler(new Request(patchUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workingDirectory: "/tmp/project",
        harness: "goose",
        model: "deepseek/deepseek-v4-flash-0731",
      }),
    }), patchUrl, "PATCH", authContext);
    const patchedBody = await patched?.json() as { agent: { model: string } };
    expect(patched?.status).toBe(200);
    expect(patchedBody.agent.model).toBe("deepseek/deepseek-v4-flash-0731");

    const rejected = await create("codex");
    expect(rejected?.status).toBe(400);
    expect(await rejected?.json()).toEqual({
      error: "Model deepseek/deepseek-v4-flash-0731 is not available for codex.",
    });
  });

  test("returns an empty agent list when agent config is unavailable", async () => {
    const handler = createHandler({ config: { agents: undefined } });
    const url = new URL("http://localhost:3000/api/config");
    const response = await handler(new Request(url.toString()), url, "GET", anonymousAuth);
    const body = await response!.json() as { agents: unknown[]; defaultAgent: string };

    expect(response.status).toBe(200);
    expect(body.agents).toEqual([]);
    expect(body.defaultAgent).toBe("claude");
  });

  test("normalizes and saves a valid default_agent setting", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const handler = createHandler({
      authContext,
      onSet: (npub, key, value) => {
        saved.push({ npub, key, value });
      },
    });

    const url = new URL("http://localhost:3000/api/user/settings/default_agent");
    const request = new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: " Pi " }),
    });
    const response = await handler(request, url, "PUT", authContext);
    const body = await response.json() as { value: string };

    expect(response.status).toBe(200);
    expect(body.value).toBe("pi");
    expect(saved).toEqual([{ npub: "npub1viewer", key: "default_agent", value: "pi" }]);
  });

  test("rejects an unsupported default_agent setting", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const handler = createHandler({
      authContext,
      onSet: (npub, key, value) => {
        saved.push({ npub, key, value });
      },
    });

    const url = new URL("http://localhost:3000/api/user/settings/default_agent");
    const request = new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "unknown-agent" }),
    });
    const response = await handler(request, url, "PUT", authContext);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("claude");
    expect(body.error).toContain("pi");
    expect(saved).toEqual([]);
  });

  test("saves and masks speech API settings", async () => {
    const authContext: RequestAuthContext = {
      npub: "npub1viewer",
      actorNpub: "npub1viewer",
      session: null,
      delegatedByBot: false,
    };
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const handler = createHandler({
      authContext,
      settings: {
        speech_provider: "local",
        speech_api_key: "test-speech-key",
        speech_model: "tts-1",
        speech_format: "mp3",
        speech_summary_model: "openai/gpt-4o-mini",
      },
      onSet: (npub, key, value) => {
        saved.push({ npub, key, value });
      },
    });

    const putUrl = new URL("http://localhost:3000/api/user/settings/speech_model");
    const putRequest = new Request(putUrl.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: " gpt-4o-mini-tts " }),
    });
    const putResponse = await handler(putRequest, putUrl, "PUT", authContext);
    expect(putResponse.status).toBe(200);
    expect(saved).toEqual([{ npub: "npub1viewer", key: "speech_model", value: "gpt-4o-mini-tts" }]);

    const getUrl = new URL("http://localhost:3000/api/user/settings");
    const getResponse = await handler(new Request(getUrl.toString()), getUrl, "GET", authContext);
    const body = await getResponse.json() as { settings: Record<string, string> };
    expect(body.settings.speech_api_key).toBe("test..-key");
    expect(body.settings.speech_provider).toBe("local");
    expect(body.settings.speech_model).toBe("tts-1");
    expect(body.settings.speech_format).toBe("mp3");
    expect(body.settings.speech_summary_model).toBe("openai/gpt-4o-mini");
  });

  test.each([
    ["GET", "/api/npub-projects?npub=npub1target"],
    ["POST", "/api/npub-projects"],
    ["GET", "/api/npub-projects/project-1"],
    ["PATCH", "/api/npub-projects/project-1"],
    ["DELETE", "/api/npub-projects/project-1"],
  ] as const)("does not promote a valid non-admin NIP-98 signer for %s %s", async (method, path) => {
    const signer = "npub1nonadmin";
    let receivedAdmin: boolean | null = null;
    const handler = createHandler({
      resolveNip98AuthContext: async (_request, _url, auth) => ({ ...auth, npub: signer, signerNpub: signer, authMethod: "nip98" }),
      npubProjectApiHandler: async (_request, _url, _method, _auth, isAdmin) => {
        receivedAdmin = isAdmin;
        return Response.json({ ok: true });
      },
    });
    const url = new URL(`http://localhost:3000${path}`);
    const response = await handler(new Request(url, { method }), url, method, anonymousAuth);
    expect(response.status).toBe(200);
    expect(receivedAdmin).toBe(false);
  });

  test("preserves configured-admin NIP-98 project access", async () => {
    const signer = "npub1configuredadmin";
    let receivedAdmin = false;
    const handler = createHandler({
      adminNpubs: [signer],
      resolveNip98AuthContext: async (_request, _url, auth) => ({ ...auth, npub: signer, signerNpub: signer, authMethod: "nip98" }),
      npubProjectApiHandler: async (_request, _url, _method, _auth, isAdmin) => {
        receivedAdmin = isAdmin;
        return Response.json({ ok: true });
      },
    });
    const url = new URL("http://localhost:3000/api/npub-projects?npub=npub1target");
    const response = await handler(new Request(url), url, "GET", anonymousAuth);
    expect(response.status).toBe(200);
    expect(receivedAdmin).toBe(true);
  });

  test("rejects non-local access to the MCP Wingman surface", async () => {
    const handler = createHandler({ requestIp: "203.0.113.10" });
    const url = new URL("http://localhost:3000/api/mcp/wingman/flightdeck");
    const response = await handler(new Request(url, {
      method: "POST",
      body: JSON.stringify({ sessionId: "session-a", action: "context" }),
    }), url, "POST", anonymousAuth);

    expect(response.status).toBe(403);
  });

  test("binds the Flight Deck MCP helper to the caller's session capability", async () => {
    let helperCalls = 0;
    const handler = createHandler({
      requestIp: "127.0.0.1",
      capabilityBrokerApiHandler: async (request: Request, url: URL) => {
        expect(url.pathname).toBe("/api/mcp/capabilities/identity");
        expect(url.searchParams.get("sessionId")).toBe("session-a");
        expect(request.headers.get("authorization")).toBe("Bearer session-a-capability");
        expect(request.headers.get("x-wingman-capability-nonce")).toBe("nonce-for-session-a");
        return Response.json({ botNpub: "npub1bot" });
      },
      wingmanMcpApiHandler: async () => {
        helperCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const url = new URL("http://localhost:3000/api/mcp/wingman/flightdeck");
    const response = await handler(new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer session-a-capability",
        "x-wingman-capability-nonce": "nonce-for-session-a",
      },
      body: JSON.stringify({ sessionId: "session-a", action: "context" }),
    }), url, "POST", anonymousAuth);

    expect(response.status).toBe(200);
    expect(helperCalls).toBe(1);
  });

  test("does not call the Flight Deck helper when capability validation denies a cross-session token", async () => {
    let helperCalls = 0;
    const handler = createHandler({
      requestIp: "127.0.0.1",
      capabilityBrokerApiHandler: async () => Response.json(
        { error: "Capability is bound to a different session" },
        { status: 403 },
      ),
      wingmanMcpApiHandler: async () => {
        helperCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const url = new URL("http://localhost:3000/api/mcp/wingman/flightdeck");
    const response = await handler(new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer session-b-capability",
        "x-wingman-capability-nonce": "nonce-for-session-b",
      },
      body: JSON.stringify({ sessionId: "session-a", action: "context" }),
    }), url, "POST", anonymousAuth);

    expect(response.status).toBe(403);
    expect(helperCalls).toBe(0);
  });
});
