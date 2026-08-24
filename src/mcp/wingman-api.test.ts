import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { createWingmanMcpApiHandler, type WingmanMcpApiDependencies } from "./wingman-api";
import type { SessionSnapshot } from "../agents/process-manager";
import type { AgentType } from "../config";
import { PipelineStore } from "../pipelines/pipeline-store";

function buildSession(input: Partial<SessionSnapshot> & { id: string }): SessionSnapshot {
  return {
    id: input.id,
    agent: (input.agent ?? "codex") as AgentType,
    port: input.port ?? 3700,
    name: input.name ?? input.id,
    status: input.status ?? "running",
    startedAt: input.startedAt ?? new Date().toISOString(),
    command: input.command ?? [],
    workingDirectory: input.workingDirectory ?? "/tmp",
    logs: input.logs ?? [],
    npub: input.npub,
    metadata: input.metadata ?? {},
  };
}

function makeDeps(
  sessions: Map<string, SessionSnapshot>,
  overrides: Partial<WingmanMcpApiDependencies> = {},
): WingmanMcpApiDependencies {
  return {
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    listSessions: () => Array.from(sessions.values()),
    createSession: async (agent, _dir, name, explicitNpub) => {
      const created = buildSession({
        id: "worker-1",
        agent,
        name: name ?? "worker-1",
        npub: explicitNpub,
        metadata: { AGENT: true },
      });
      sessions.set(created.id, created);
      return created;
    },
    enableNightWatch: () => undefined,
    stopSession: async (sessionId) => {
      const existing = sessions.get(sessionId) ?? null;
      if (!existing) return null;
      sessions.delete(sessionId);
      return existing;
    },
    scheduleArchive: () => {},
    getSessionLogs: async () => [],
    listApps: async () => [],
    getAppStatus: async () => ({ running: false, pid: null, uptime: null }),
    runAppAction: async () => ({ running: false, pid: null, uptime: null }),
    tailAppLogs: async () => [],
    caproverStore: { listApps: () => [], getApp: () => null, createDeployment: () => ({ id: "d1" }) } as any,
    getCaproverClient: () => null,
    userSkillsRoot: "/tmp",
    defaultSkillsRoot: "/tmp",
    userSettingsStore: { get: () => null } as any,
    artifactsStore: {} as any,
    openRouterApiKey: null,
    findProjectByDirectory: () => null,
    memoryStore: {} as any,
    getWingmanNpub: () => null,
    setPinnedFile: (sessionId, filePath) => {
      const existing = sessions.get(sessionId);
      if (!existing) return null;
      const pinnedFile = typeof filePath === "string" && filePath.trim().length > 0
        ? filePath.trim()
        : null;
      const existingPinnedFiles = Array.isArray(existing.metadata?.pinnedFiles)
        ? existing.metadata.pinnedFiles.filter((value) => typeof value === "string" && value.trim().length > 0)
        : [];
      const pinnedFiles = pinnedFile
        ? [...existingPinnedFiles.filter((value) => value !== pinnedFile), pinnedFile]
        : [];
      const updated = {
        ...existing,
        pinnedFile: pinnedFile ?? undefined,
        metadata: { ...(existing.metadata ?? {}), pinnedFiles },
      };
      sessions.set(sessionId, updated);
      return updated;
    },
    removePinnedFile: (sessionId, filePath) => {
      const existing = sessions.get(sessionId);
      if (!existing) return null;
      const pinnedFiles = Array.isArray(existing.metadata?.pinnedFiles)
        ? existing.metadata.pinnedFiles.filter((value) => value !== filePath)
        : [];
      const pinnedFile = pinnedFiles.includes(existing.pinnedFile ?? "")
        ? existing.pinnedFile
        : pinnedFiles[pinnedFiles.length - 1];
      const updated = {
        ...existing,
        pinnedFile: pinnedFile ?? undefined,
        metadata: { ...(existing.metadata ?? {}), pinnedFiles },
      };
      sessions.set(sessionId, updated);
      return updated;
    },
    setPinnedFiles: (sessionId, filePaths, activeFilePath) => {
      const existing = sessions.get(sessionId);
      if (!existing) return null;
      const pinnedFiles = filePaths.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
      const pinnedFile = activeFilePath && pinnedFiles.includes(activeFilePath)
        ? activeFilePath
        : pinnedFiles[pinnedFiles.length - 1];
      const updated = {
        ...existing,
        pinnedFile: pinnedFile ?? undefined,
        metadata: { ...(existing.metadata ?? {}), pinnedFiles },
      };
      sessions.set(sessionId, updated);
      return updated;
    },
    ...overrides,
  };
}

describe("wingman-api session ownership", () => {
  test("create_session inherits caller npub so stop_session succeeds in same operator flow", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("caller-1", buildSession({ id: "caller-1", npub: "npub-user-1" }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const createResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "caller-1", agent: "codex", name: "worker" }),
      }),
      new URL("http://localhost/api/mcp/wingman/sessions"),
      "POST",
    );
    expect(createResponse?.status).toBe(200);
    const createdPayload = await createResponse!.json() as Record<string, unknown>;
    expect(createdPayload.id).toBe("worker-1");
    expect(sessions.get("worker-1")?.npub).toBe("npub-user-1");

    const stopResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "caller-1", targetSessionId: "worker-1" }),
      }),
      new URL("http://localhost/api/mcp/wingman/sessions/stop"),
      "POST",
    );
    expect(stopResponse?.status).toBe(200);
  });

  test("stop_session rejects cross-user targets", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("caller-1", buildSession({ id: "caller-1", npub: "npub-user-1" }));
    sessions.set("worker-2", buildSession({ id: "worker-2", npub: "npub-user-2" }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const stopResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "caller-1", targetSessionId: "worker-2" }),
      }),
      new URL("http://localhost/api/mcp/wingman/sessions/stop"),
      "POST",
    );

    expect(stopResponse?.status).toBe(403);
    const payload = await stopResponse!.json() as Record<string, unknown>;
    expect(payload.error).toBe("Cannot stop sessions belonging to another user");
  });

  test("stop_session accepts metadata.ownerNpub as the effective owner", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("caller-1", buildSession({ id: "caller-1", npub: "npub-user-1" }));
    sessions.set(
      "worker-2",
      buildSession({
        id: "worker-2",
        npub: null,
        metadata: { AGENT: true, ownerNpub: "npub-user-1" } as any,
      }),
    );
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const stopResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "caller-1", targetSessionId: "worker-2" }),
      }),
      new URL("http://localhost/api/mcp/wingman/sessions/stop"),
      "POST",
    );

    expect(stopResponse?.status).toBe(200);
  });

  test("removes one pinned doc without clearing the rest", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("session-1", buildSession({
      id: "session-1",
      pinnedFile: "/tmp/three.md",
      metadata: { AGENT: true, pinnedFiles: ["/tmp/one.md", "/tmp/two.md", "/tmp/three.md"] } as any,
    }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const removeResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/artifact/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1", removeFilePath: "/tmp/three.md" }),
      }),
      new URL("http://localhost/api/mcp/wingman/artifact/pin"),
      "POST",
    );

    expect(removeResponse?.status).toBe(200);
    expect(await removeResponse!.json()).toMatchObject({
      pinnedFile: "/tmp/two.md",
      pinnedFiles: ["/tmp/one.md", "/tmp/two.md"],
    });
  });

  test("accepts the client ordered pinned list when unpinning the visible page", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("session-1", buildSession({
      id: "session-1",
      pinnedFile: "/tmp/three.md",
      metadata: { AGENT: true } as any,
    }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const removeResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/artifact/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          removeFilePath: "/tmp/two.md",
          pinnedFiles: ["/tmp/one.md", "/tmp/three.md"],
          activeFilePath: "/tmp/three.md",
        }),
      }),
      new URL("http://localhost/api/mcp/wingman/artifact/pin"),
      "POST",
    );

    expect(removeResponse?.status).toBe(200);
    expect(await removeResponse!.json()).toMatchObject({
      pinnedFile: "/tmp/three.md",
      pinnedFiles: ["/tmp/one.md", "/tmp/three.md"],
    });
  });
});

describe("wingman-api pinned artifacts", () => {
  test("returns the session pinned file list after pinning multiple docs", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("session-1", buildSession({ id: "session-1", metadata: { AGENT: true } as any }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    for (const filePath of ["/tmp/one.md", "/tmp/two.md", "/tmp/one.md", "/tmp/three.md"]) {
      const pinResponse = await handler(
        new Request("http://localhost/api/mcp/wingman/artifact/pin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "session-1", filePath }),
        }),
        new URL("http://localhost/api/mcp/wingman/artifact/pin"),
        "POST",
      );
      expect(pinResponse?.status).toBe(200);
    }

    const getResponse = await handler(
      new Request("http://localhost/api/mcp/wingman/artifact/pin?sessionId=session-1"),
      new URL("http://localhost/api/mcp/wingman/artifact/pin?sessionId=session-1"),
      "GET",
    );

    expect(getResponse?.status).toBe(200);
    expect(await getResponse!.json()).toMatchObject({
      pinnedFile: "/tmp/three.md",
      pinnedFiles: ["/tmp/two.md", "/tmp/one.md", "/tmp/three.md"],
    });
  });
});

describe("wingman-api Flight Deck helpers", () => {
  test("resolves Agent Direct session metadata without pipeline context", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    const botSecret = generateSecretKey();
    const botNpub = nip19.npubEncode(getPublicKey(botSecret));
    sessions.set("direct-1", buildSession({
      id: "direct-1",
      metadata: {
        AGENT: true,
        sessionClass: "flightdeck_chat",
        flightdeckTowerServiceNpub: "npub-tower",
        flightdeckWorkspaceId: "workspace-1",
        flightdeckChannelId: "channel-1",
        flightdeckThreadId: "thread-1",
        flightdeckAgentNpub: botNpub,
        flightdeckRoutingKey: "agent-direct:route-1",
        agentChatAgentId: "exampleAgent",
      } as any,
    }));
    const botIdentity = { botNpub, botPubkeyHex: getPublicKey(botSecret), botSecret };
    const handler = createWingmanMcpApiHandler(makeDeps(sessions, {
      resolveFlightDeckDirectContext: (input) => input.towerServiceNpub === "npub-tower"
        && input.workspaceId === "workspace-1" && input.agentNpub === botNpub
        ? { subscriptionId: "sub-1", backendBaseUrl: "http://tower.test", appNpub: "npub-app", botIdentity }
        : null,
    }));

    const response = await handler(
      new Request("http://localhost/api/mcp/wingman/flightdeck", {
        method: "POST",
        body: JSON.stringify({ sessionId: "direct-1", action: "context" }),
      }),
      new URL("http://localhost/api/mcp/wingman/flightdeck"),
      "POST",
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      mode: "direct_chat",
      hasRunContext: false,
      workspace: { workspaceId: "workspace-1", subscriptionId: "sub-1" },
      chat: { channelId: "channel-1", threadId: "thread-1" },
      routing: { routingKey: "agent-direct:route-1" },
      bot: { npub: botNpub, available: true },
    });

    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return request.method === "POST"
        ? Response.json({ message: { id: "reply-1" } })
        : Response.json({ messages: [{ id: "message-1", body: "Hello" }], next_cursor: null });
    }) as typeof fetch;
    try {
      for (const [action, extra] of [["thread_read", {}], ["chat_reply", { body: "Reply" }]] as const) {
        const helperResponse = await handler(
          new Request("http://localhost/api/mcp/wingman/flightdeck", {
            method: "POST",
            body: JSON.stringify({ sessionId: "direct-1", action, ...extra }),
          }),
          new URL("http://localhost/api/mcp/wingman/flightdeck"),
          "POST",
        );
        expect(helperResponse?.status).toBe(200);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain("/channels/channel-1/messages?thread_id=thread-1");
    expect(requests[1]!.method).toBe("POST");
    expect(await requests[1]!.clone().json()).toMatchObject({ thread_id: "thread-1", body: "Reply" });
  });

  test("flightdeck_context resolves pipeline workspace and thread context", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    const store = new PipelineStore(join(tmpdir(), `wingman-mcp-fd-${randomUUID()}.sqlite`));
    const run = store.createRun({
      definitionId: "document-discussion",
      name: "document-discussion",
      scope: "shared",
      input: {
        workspace: {
          workspaceId: "workspace-1",
          backendBaseUrl: "http://tower.test",
          sourceAppNpub: "npub-app",
          workspaceOwnerNpub: "npub-owner",
          subscriptionId: "sub-1",
        },
        chat: {
          channelId: "channel-1",
          threadId: "thread-1",
          messageText: "Draft the doc",
        },
        routing: {
          channelId: "channel-1",
          threadId: "thread-1",
        },
        record: {
          recordId: "message-1",
          recordFamily: "chat_message",
        },
        runtime: {
          mode: "flightdeck_pg",
        },
        agent: {
          botNpub: "npub-bot",
        },
      },
    });
    sessions.set("caller-1", buildSession({
      id: "caller-1",
      metadata: {
        AGENT: true,
        bindingType: "flow_run",
        bindingId: run.id,
        flowRunId: run.id,
      },
    }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions, { pipelineStore: store }));

    const response = await handler(
      new Request("http://localhost/api/mcp/wingman/flightdeck", {
        method: "POST",
        body: JSON.stringify({ sessionId: "caller-1", action: "context" }),
      }),
      new URL("http://localhost/api/mcp/wingman/flightdeck"),
      "POST",
    );

    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.workspace.workspaceId).toBe("workspace-1");
    expect(body.chat.channelId).toBe("channel-1");
    expect(body.chat.threadId).toBe("thread-1");
    expect(body.bot.npub).toBe("npub-bot");
  });

  test("document helpers require Flight Deck PG pipeline context", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set("caller-1", buildSession({ id: "caller-1", metadata: { AGENT: true } }));
    const handler = createWingmanMcpApiHandler(makeDeps(sessions));

    const response = await handler(
      new Request("http://localhost/api/mcp/wingman/flightdeck", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "caller-1",
          action: "doc_update",
          documentId: "doc-1",
          body: "Updated body",
        }),
      }),
      new URL("http://localhost/api/mcp/wingman/flightdeck"),
      "POST",
    );

    expect(response?.status).toBe(400);
    const body = await response!.json();
    expect(body.error).toContain("No pipeline run, document binding, or Agent Direct context");
  });

  test("daily scope helper routes owner/date upserts through Flight Deck PG", async () => {
    const sessions = new Map<string, SessionSnapshot>();
    const store = new PipelineStore(join(tmpdir(), `wingman-mcp-daily-scope-${randomUUID()}.sqlite`));
    const run = store.createRun({
      definitionId: "daily-scope",
      name: "daily-scope",
      scope: "shared",
      input: {
        workspace: {
          workspaceId: "workspace-1",
          backendBaseUrl: "http://tower.test",
          sourceAppNpub: "npub-app",
          humanWorkspaceOwnerNpub: "npub-human",
          subscriptionId: "sub-1",
        },
        record: {
          recordId: "message-1",
        },
      },
    });
    sessions.set("caller-1", buildSession({
      id: "caller-1",
      metadata: {
        AGENT: true,
        bindingType: "flow_run",
        bindingId: run.id,
        flowRunId: run.id,
      },
    }));
    const botSecret = generateSecretKey();
    const botPubkeyHex = getPublicKey(botSecret);
    const botNpub = nip19.npubEncode(botPubkeyHex);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, init });
      return new Response(JSON.stringify({
        daily_note: {
          id: "daily-1",
          owner_actor_id: "owner-1",
          note_date: "2026-06-17",
          items: JSON.parse(String(init?.body)).items,
          body: JSON.parse(String(init?.body)).body,
          row_version: 3,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const handler = createWingmanMcpApiHandler(makeDeps(sessions, {
      pipelineStore: store,
      getBotIdentityForSubscription: () => ({ botNpub, botPubkeyHex, botSecret }),
    } as Partial<WingmanMcpApiDependencies>));

    try {
      const response = await handler(
        new Request("http://localhost/api/mcp/wingman/flightdeck", {
          method: "POST",
          body: JSON.stringify({
            sessionId: "caller-1",
            action: "daily_scope_upsert",
            ownerActorId: "owner-1",
            noteDate: "2026-06-17",
            body: "Morning note",
            items: [
              { text: "One" },
              { text: "Two" },
              { text: "Three" },
              { text: "Four" },
              { text: "Five" },
              { text: "Six" },
            ],
          }),
        }),
        new URL("http://localhost/api/mcp/wingman/flightdeck"),
        "POST",
      );

      expect(response?.status).toBe(200);
      const payload = await response!.json();
      expect(payload.result.daily_note.id).toBe("daily-1");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const writeRequest = requests[0];
    expect(writeRequest.url).toBe("http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes");
    const body = JSON.parse(String(writeRequest.init?.body));
    expect(body).toMatchObject({
      owner_actor_id: "owner-1",
      owner_npub: "npub-human",
      note_date: "2026-06-17",
      body: "Morning note",
      metadata: {
        source_session_id: "caller-1",
        source_pipeline_run_id: run.id,
        source_record_id: "message-1",
      },
    });
    expect(body.items).toHaveLength(5);
  });
});
