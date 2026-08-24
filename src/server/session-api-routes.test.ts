// Must be set BEFORE any imports that trigger getSessionSecretBytes()
process.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleSessionApi, type SessionApiContext } from "./session-api-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { SessionSnapshot } from "../agents/process-manager";
import type { StoredSessionRecord } from "../storage/message-store";
import { sessionBelongsToViewer as sessionOwnerMatchesViewer } from "../sessions/session-ownership";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: "npub1owner",
  actorNpub: "npub1bot",
  signerNpub: "npub1bot",
  subjectNpub: "npub1bot",
  delegatedOwnerNpub: "npub1owner",
  session: null,
  authMethod: "nip98",
  delegatedByBot: true,
  ...overrides,
});

const baseSession: SessionSnapshot = {
  id: "session-1",
  agent: "codex",
  status: "running",
  npub: "npub1owner",
  port: 3700,
  pid: 1234,
  name: "test session",
  startedAt: new Date().toISOString(),
  command: ["codex"],
  workingDirectory: "/tmp/project",
  logs: [],
  agentRuntimeStatus: "running",
  origin: undefined,
  pm2Name: undefined,
  targetFile: undefined,
  metadata: { AGENT: false, billingMode: "subscription" },
};

const buildCtx = (overrides?: Partial<SessionApiContext>): SessionApiContext => ({
  manager: {
    createSession: async (
      agent: string,
      workingDirectory: string,
      name?: string,
      origin?: unknown,
      targetFile?: string,
      npub?: string,
      metadata?: unknown,
    ) => ({
      ...baseSession,
      id: "session-1",
      agent,
      workingDirectory,
      name: name ?? baseSession.name,
      origin: origin ?? null,
      targetFile,
      npub: npub ?? null,
      metadata: metadata ?? baseSession.metadata,
    }),
    getSession: (id: string) => (id === "session-1" ? baseSession : undefined),
    listSessions: () => [baseSession],
    stopSession: async (id: string) => (id === "session-1" ? baseSession : null),
    getAdapter: () => null,
  } as any,
  adminNpub: null,
  agentHost: "127.0.0.1",
  messageStore: {
    recordSession: () => {},
    getSession: () => null,
    listSessions: () => [],
    listSessionMessages: () => [],
    replaceMessages: () => {},
  } as any,
  sessionArchiveStore: {
    getArchivedSession: () => null,
    listArchivedSessions: () => [],
    getArchiveCount: () => 0,
  } as any,
  identityUserStore: {
    ensurePortsFor: () => [],
    getByNormalized: () => null,
  } as any,
  promptQueueStore: {} as any,
  artifactsStore: {} as any,
  userIdentityRoot: "/tmp",
  attachmentRoot: "/tmp",
  imageRoot: "/tmp",
  ensureApiAccess: async () => null,
  serializeSession: (session) => ({ id: session.id, npub: session.npub, metadata: session.metadata, origin: session.origin }),
  sessionBelongsToViewer: (sessionNpub, sessionMetadata, viewerNormalizedNpub, viewerIsAdmin) =>
    sessionOwnerMatchesViewer(sessionNpub, sessionMetadata as any, viewerNormalizedNpub, viewerIsAdmin),
  getViewerNormalizedNpub: () => "npub1owner",
  buildIdentitySummaries: () => [],
  createSessionSubscribeResponse: () => new Response(null, { status: 200 }),
  handleSessionEvents: () => new Response(null, { status: 200 }),
  syncSessionMessages: async () => [],
  waitForMessageUpdate: async () => [],
  scheduleSessionArchive: () => {},
  cancelPendingArchive: () => {},
  isAgentType: (value): value is "codex" => value === "codex",
  normaliseSessionNameInput: (value) => (typeof value === "string" ? value : null),
  parseSessionWorkspaceRequest: () => null,
  resolveSessionWorkingDirectory: async () => "/tmp/project",
  resolveWorkspace: (() => ({
    root: "/tmp",
    docsRoot: "/tmp",
    defaultDirectory: "/tmp/project",
    allowedDirectories: ["/tmp/project"],
  })) as any,
  parseSessionOriginInput: () => null,
  parseNightWatchStartOptions: () => null,
  buildAgentUrl: () => "http://localhost:3700",
  enableNightWatch: () => undefined,
  queueDispatchInFlight: new Set<string>(),
  maybeAutoDispatchQueuedPrompt: () => {},
  dispatchNextQueuedPromptForSession: async () => ({}),
  validateForkInput: (() => ({})) as any,
  getRecentMessages: (() => []) as any,
  formatMessagesAsContext: (() => "") as any,
  createGitWorktree: (async () => ({ path: "/tmp/project/.worktrees/test" })) as any,
  forkCodexSession: (async () => ({
    sourceSessionId: "native-source",
    forkedSessionId: "native-fork",
    sourceFilePath: "/tmp/source.jsonl",
    forkedFilePath: "/tmp/fork.jsonl",
  })) as any,
  workspaceDelegationStore: {
    findActiveDelegation: () => null,
  } as any,
  AccessActions: { SessionsManage: "sessions:manage" as any, SessionsRead: "sessions:read" as any },
  ...overrides,
});

describe("handleSessionApi", () => {
  const originalFetch = globalThis.fetch;
  const tempPaths: string[] = [];

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  test("GET document binding sessions returns only authorised bindings with open references", async () => {
    const ctx = buildCtx({
      documentDirectStore: {
        listBindings: () => [{
          routingKey: "document-direct:v1:tower:workspace-1:exampleAgent:doc-1",
          subscriptionId: "sub-1", workspaceId: "workspace-1", agentId: "exampleAgent", agentNpub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg",
          documentId: "doc-1", sessionId: "session-1", generation: 2, trigger: "document_comment_mention_added",
          lastActivityAt: "2026-08-05T00:00:00.000Z", queuedCount: 1, callbackOutcome: "incomplete",
          callbackAttempts: 1, openSessionRef: "/live?session=session-1",
        }],
      } as any,
      canViewDocumentSubscription: (subscriptionId, viewerNpub) => subscriptionId === "sub-1" && viewerNpub === "npub1owner",
      resolveDocumentSessionStatus: () => "running",
    });
    const url = new URL("http://localhost:3021/api/document-bindings/workspace-1/doc-1/sessions");
    const response = await handleSessionApi(new Request(url), url, "GET", makeAuth(), ctx);
    expect(response?.status).toBe(200);
    const payload = await response!.json() as any;
    expect(payload.sessions[0]).toMatchObject({ status: "running", generation: 2, queuedCount: 1,
      callbackOutcome: "incomplete", openSessionRef: "/live?session=session-1" });
  });

  test("approved non-Admin executable session launch returns 403", async () => {
    const ctx = buildCtx({
      ensureApiAccess: async (action) => action === "sessions:manage"
        ? Response.json({ error: "admin-or-execution-delegation-required" }, { status: 403 })
        : null,
    });
    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", directory: "/tmp/project" }),
    });
    const response = await handleSessionApi(request, url, "POST", makeAuth({ npub: "npub1approved" }), ctx);
    expect(response?.status).toBe(403);
  });

  test("POST /api/sessions passes the effective npub into session creation", async () => {
    let explicitNpub: string | undefined;
    const ctx = buildCtx({
      manager: {
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
        ) => {
          explicitNpub = npub;
          return {
            ...baseSession,
            agent,
            workingDirectory,
            name: name ?? baseSession.name,
            origin: origin ?? null,
            targetFile,
            npub: npub ?? null,
          };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "codex",
        name: "test session",
      }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitNpub).toBe("npub1owner");
  });

  test("session creation endpoints reject absolute and escaping target files", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "wingman-session-target-"));
    tempPaths.push(workingDirectory);
    const createdTargets: Array<string | undefined> = [];
    const ctx = buildCtx({
      resolveSessionWorkingDirectory: async () => workingDirectory,
      manager: {
        createSession: async (
          agent: string,
          directory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
        ) => {
          createdTargets.push(targetFile);
          return { ...baseSession, agent, workingDirectory: directory, name: name ?? "test", origin: origin as any, targetFile };
        },
      } as any,
    });

    for (const pathname of ["/api/sessions", "/api/delegate-sessions"]) {
      for (const targetFile of [join(tmpdir(), "absolute.md"), "../escape.md"]) {
        const url = new URL(`http://localhost:3021${pathname}`);
        const response = await handleSessionApi(new Request(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "codex", targetFile }),
        }), url, "POST", makeAuth(), ctx);
        expect(response?.status).toBe(400);
      }
    }
    for (const targetFile of [join(tmpdir(), "absolute.md"), "../escape.md"]) {
      const url = new URL("http://localhost:3021/api/owners/npub1owner/sessions");
      const response = await handleSessionApi(new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", targetFile }),
      }), url, "POST", makeAuth({
        actorNpub: "npub1owner",
        signerNpub: "npub1owner",
        subjectNpub: "npub1owner",
        delegatedByBot: false,
      }), ctx);
      expect(response?.status).toBe(400);
    }
    expect(createdTargets).toEqual([]);
  });

  test("session creation endpoints resolve safe relative target files beneath the working directory", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "wingman-session-target-"));
    tempPaths.push(workingDirectory);
    const createdTargets: string[] = [];
    const ctx = buildCtx({
      resolveSessionWorkingDirectory: async () => workingDirectory,
      manager: {
        createSession: async (
          agent: string,
          directory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          if (targetFile) createdTargets.push(targetFile);
          return { ...baseSession, agent, workingDirectory: directory, name: name ?? "test", origin: origin as any, targetFile, npub, metadata: metadata as any };
        },
      } as any,
    });

    for (const pathname of ["/api/sessions", "/api/delegate-sessions"]) {
      const url = new URL(`http://localhost:3021${pathname}`);
      const response = await handleSessionApi(new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", targetFile: "資料/計画.md" }),
      }), url, "POST", makeAuth(), ctx);
      expect(response?.status).toBe(201);
    }
    const ownerUrl = new URL("http://localhost:3021/api/owners/npub1owner/sessions");
    const ownerResponse = await handleSessionApi(new Request(ownerUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", targetFile: "資料/計画.md" }),
    }), ownerUrl, "POST", makeAuth({
      actorNpub: "npub1owner",
      signerNpub: "npub1owner",
      subjectNpub: "npub1owner",
      delegatedByBot: false,
    }), ctx);
    expect(ownerResponse?.status).toBe(201);
    expect(createdTargets).toEqual([
      join(workingDirectory, "資料", "計画.md"),
      join(workingDirectory, "資料", "計画.md"),
      join(workingDirectory, "資料", "計画.md"),
    ]);
  });

  test("GET /api/sessions/:id resolves a unique owned prefix", async () => {
    const resolvedSession = {
      ...baseSession,
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
      name: "tower-sync-progress",
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === resolvedSession.id ? resolvedSession : undefined),
        listSessions: () => [resolvedSession],
      } as any,
      serializeSession: (session) => ({ id: session.id, name: session.name }),
    });

    const url = new URL("http://localhost:3021/api/sessions/26866c4d");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
      name: "tower-sync-progress",
    });
  });

  test("GET /api/sessions/:id/messages resolves a unique owned prefix for subresources", async () => {
    const resolvedSession = {
      ...baseSession,
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
    };
    let requestedSessionId: string | null = null;
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === resolvedSession.id ? resolvedSession : undefined),
        listSessions: () => [resolvedSession],
      } as any,
      messageStore: {
        recordSession: () => {},
        listSessionMessages: (sessionId: string) => {
          requestedSessionId = sessionId;
          return [{ role: "agent", content: "READY" }];
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/26866c4d/messages");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(requestedSessionId as string | null).toBe("26866c4d-835b-4ab8-b477-128fe2e29095");
    await expect(response!.json()).resolves.toEqual({
      id: "26866c4d-835b-4ab8-b477-128fe2e29095",
      messages: [{ role: "agent", content: "READY" }],
    });
  });

  test("POST /api/sessions/:id/branch-conversation creates an independent session with branch metadata", async () => {
    let createdMetadata: Record<string, unknown> | null = null;
    let createdDirectory: string | null = null;
    let createdName: string | null = null;
    let forkInput: Record<string, unknown> | null = null;
    const sourceSession = {
      ...baseSession,
      metadata: {
        ...baseSession.metadata,
        nativeAgentSession: {
          agent: "codex",
          sessionId: "native-source",
          workingDirectory: "/tmp/project",
          capturedAt: "2026-06-26T01:00:00.000Z",
          source: "adapter",
        },
      },
    };
    const branchedSession = {
      ...baseSession,
      id: "branch-session-1",
      name: "test session (branch)",
      metadata: { AGENT: false, billingMode: "subscription" as const },
      origin: { type: "conversation-branch", id: "session-1" },
    };
    const ctx = buildCtx({
      manager: {
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          createdDirectory = workingDirectory;
          createdName = name ?? null;
          createdMetadata = metadata as Record<string, unknown>;
          return {
            ...branchedSession,
            agent,
            workingDirectory,
            name: name ?? branchedSession.name,
            origin: origin as any,
            targetFile,
            npub: npub ?? null,
            metadata: metadata as any,
          };
        },
        getSession: (id: string) => (id === sourceSession.id ? sourceSession : undefined),
        listSessions: () => [sourceSession],
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: () => null,
        listSessions: () => [],
        listSessionMessages: () => [
          {
            id: "message-1",
            sessionId: "session-1",
            role: "user",
            content: "Please implement the feature",
            createdAt: "2026-06-26T01:00:00.000Z",
          },
        ],
        replaceMessages: () => {},
      } as any,
      forkCodexSession: async (input) => {
        forkInput = input as unknown as Record<string, unknown>;
        return {
          sourceSessionId: "native-source",
          forkedSessionId: "native-fork",
          sourceFilePath: "/tmp/source.jsonl",
          forkedFilePath: "/tmp/fork.jsonl",
        };
      },
      serializeSession: (session) => ({
        id: session.id,
        name: session.name,
        workingDirectory: session.workingDirectory,
        metadata: session.metadata,
        origin: session.origin,
      }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/branch-conversation");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Questions branch", mode: "full" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(createdDirectory).toBe("/tmp/project");
    expect(createdName).toBe("Questions branch");
    expect(forkInput).toMatchObject({
      sourceSessionId: "native-source",
      workingDirectory: "/tmp/project",
    });
    expect(createdMetadata?.branchedFromWingmanSessionId).toBe("session-1");
    expect(createdMetadata?.nativeAgentSession).toMatchObject({
      agent: "codex",
      sessionId: "native-fork",
      workingDirectory: "/tmp/project",
    });
    expect(createdMetadata?.resumedFromWingmanSessionId).toBeUndefined();
    const body = await response!.json();
    expect(body.session.id).toBe("branch-session-1");
    expect(body.forkedCodexSession).toMatchObject({
      sourceSessionId: "native-source",
      forkedSessionId: "native-fork",
    });
  });

  test("GET /api/sessions/:id/messages/:messageId/speech returns an existing attachment", async () => {
    const speech = {
      publicPath: "/uploads/files/owner/codex/speech/response.mp3",
      relativePath: "owner/codex/speech/response.mp3",
      mimeType: "audio/mpeg",
      voice: "alloy",
      model: "tts-1",
      summary: "READY",
      createdAt: "2026-06-13T02:01:00.000Z",
    };
    const ctx = buildCtx({
      messageStore: {
        recordSession: () => {},
        getSession: () => null,
        listSessions: () => [],
        listSessionMessages: () => [{
          id: "message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "READY",
          createdAt: "2026-06-13T02:00:00.000Z",
        }],
        getMessageSpeechAttachment: () => speech,
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages/message-1/speech");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({ sessionId: "session-1", messageId: "message-1", speech });
  });

  test("POST /api/sessions/:id/messages/:messageId/speech uses OpenRouter speech defaults", async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), "wingman-speech-test-"));
    tempPaths.push(attachmentRoot);
    let providerUrl = "";
    let providerBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      providerUrl = String(input);
      providerBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch;
    const ctx = buildCtx({
      attachmentRoot,
      manager: {
        getSession: () => ({ ...baseSession, agentRuntimeStatus: "stable" }),
        listSessions: () => [{ ...baseSession, agentRuntimeStatus: "stable" }],
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: () => ({ id: "session-1", agent: "codex", npub: "npub1owner", metadata: null }),
        listSessions: () => [],
        listSessionMessages: () => [{
          id: "message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "READY",
          createdAt: "2026-06-13T02:00:00.000Z",
        }],
        getMessageSpeechAttachment: () => null,
        saveMessageSpeechAttachment: (attachment: unknown) => attachment,
      } as any,
      userSettingsStore: {
        getAll: () => ({ speech_api_key: "sk-or-test" }),
      },
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages/message-1/speech");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ delegatedByBot: false }), ctx);
    const body = await response!.json() as { speech: Record<string, unknown> };

    expect(response!.status).toBe(201);
    expect(providerUrl).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(providerBody).toMatchObject({
      model: "hexgrad/kokoro-82m",
      input: "READY",
      voice: "af_heart",
      response_format: "mp3",
    });
    expect(body.speech).toMatchObject({
      mimeType: "audio/mpeg",
      voice: "af_heart",
      model: "hexgrad/kokoro-82m",
      summary: "READY",
    });
  });

  test("POST /api/sessions/:id/messages/:messageId/speech summarizes before TTS in summary mode", async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), "wingman-speech-summary-test-"));
    tempPaths.push(attachmentRoot);
    const providerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const settingsLookups: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      providerCalls.push({ url, body });
      if (url.endsWith("/chat/completions")) {
        return Response.json({
          choices: [{ message: { content: "I explained how to test and use speech summaries." } }],
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const ctx = buildCtx({
      attachmentRoot,
      manager: {
        getSession: () => ({ ...baseSession, agentRuntimeStatus: "stable" }),
        listSessions: () => [{ ...baseSession, agentRuntimeStatus: "stable" }],
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: () => ({ id: "session-1", agent: "codex", npub: "npub1owner", metadata: null }),
        listSessions: () => [],
        listSessionMessages: () => [
          {
            id: "message-user",
            sessionId: "session-1",
            role: "user",
            content: "How do we test this?",
            createdAt: "2026-06-13T02:00:00.000Z",
          },
          {
            id: "message-agent",
            sessionId: "session-1",
            role: "assistant",
            content: "Open Settings, save the key, then click Play on the assistant message.",
            createdAt: "2026-06-13T02:01:00.000Z",
          },
        ],
        getMessageSpeechAttachment: () => null,
        saveMessageSpeechAttachment: (attachment: unknown) => attachment,
      } as any,
      userSettingsStore: {
        getAll: (npub: string) => {
          settingsLookups.push(npub);
          return npub === "npub1owner"
            ? {
                speech_api_key: "sk-or-test",
                speech_summary_model: "openai/gpt-4o-mini",
              }
            : {};
        },
      },
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages/message-agent/speech");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: true }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ npub: "npub1bot", delegatedByBot: false }), ctx);
    const body = await response!.json() as { speech: Record<string, unknown> };

    expect(response!.status).toBe(201);
    expect(settingsLookups).toEqual(["npub1owner", "npub1owner"]);
    expect(providerCalls.map((call) => call.url)).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/audio/speech",
    ]);
    expect(providerCalls[0].body).toMatchObject({
      model: "openai/gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 700,
    });
    expect(JSON.stringify(providerCalls[0].body)).toContain("How do we test this?");
    expect(providerCalls[1].body).toMatchObject({
      model: "hexgrad/kokoro-82m",
      input: "I explained how to test and use speech summaries.",
      voice: "af_heart",
      response_format: "mp3",
    });
    expect(body.speech).toMatchObject({
      summary: "I explained how to test and use speech summaries.",
      model: "hexgrad/kokoro-82m",
      voice: "af_heart",
    });
  });

  test("POST /api/sessions/:id/resume-native creates a new session from native metadata", async () => {
    const sourceSession: SessionSnapshot = {
      ...baseSession,
      status: "stopped",
      metadata: {
        AGENT: false,
        billingMode: "subscription",
        nativeAgentSession: {
          agent: "codex",
          sessionId: "codex-native-1",
          workingDirectory: "/tmp/project",
          capturedAt: "2026-05-31T00:00:00.000Z",
          source: "manual",
        },
      },
    };
    let createInput: Record<string, unknown> | null = null;
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === sourceSession.id ? sourceSession : undefined),
        listSessions: () => [sourceSession],
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          createInput = { agent, workingDirectory, name, origin, targetFile, npub, metadata };
          return {
            ...baseSession,
            id: "new-session",
            agent,
            workingDirectory,
            name: name ?? "new session",
            origin: origin as any,
            targetFile,
            npub: npub ?? null,
            metadata: metadata as any,
          };
        },
      } as any,
      serializeSession: (session) => ({ id: session.id, metadata: session.metadata, origin: session.origin }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/resume-native");
    const request = new Request(url.toString(), { method: "POST" });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ delegatedByBot: false }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(createInput).toMatchObject({
      agent: "codex",
      workingDirectory: "/tmp/project",
      npub: "npub1owner",
    });
    const capturedCreateInput = createInput as unknown as Record<string, any>;
    expect(capturedCreateInput.metadata.resumedFromWingmanSessionId).toBe("session-1");
    expect(capturedCreateInput.metadata.nativeAgentSession.sessionId).toBe("codex-native-1");
    await expect(response!.json()).resolves.toMatchObject({
      session: {
        id: "new-session",
        metadata: {
          resumedFromWingmanSessionId: "session-1",
          nativeAgentSession: { sessionId: "codex-native-1" },
        },
      },
    });
  });

  test("POST /api/sessions/:id/resume-native creates a new session from archived native metadata", async () => {
    const archivedSession = {
      id: "archived-session-1",
      agent: "codex",
      name: "restartme",
      npub: "npub1owner",
      workingDirectory: "/tmp/project",
      startedAt: "2026-05-31T00:00:00.000Z",
      archivedAt: "2026-05-31T00:05:00.000Z",
      messageCount: 2,
      origin: null,
      metadata: {
        AGENT: false,
        billingMode: "subscription",
        nativeAgentSession: {
          agent: "codex",
          sessionId: "codex-archived-native-1",
          workingDirectory: "/tmp/project",
          capturedAt: "2026-05-31T00:00:00.000Z",
          source: "agentapi",
        },
      },
    };
    let createInput: Record<string, unknown> | null = null;
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          createInput = { agent, workingDirectory, name, origin, targetFile, npub, metadata };
          return {
            ...baseSession,
            id: "new-archived-resume-session",
            agent,
            workingDirectory,
            name: name ?? "new session",
            origin: origin as any,
            targetFile,
            npub: npub ?? null,
            metadata: metadata as any,
          };
        },
      } as any,
      sessionArchiveStore: {
        getArchivedSession: (id: string) => (id === archivedSession.id ? archivedSession : null),
        listArchivedSessions: () => [archivedSession],
        getArchiveCount: () => 1,
      } as any,
      serializeSession: (session) => ({ id: session.id, metadata: session.metadata, origin: session.origin }),
    });

    const url = new URL("http://localhost:3021/api/sessions/archived-session-1/resume-native");
    const request = new Request(url.toString(), { method: "POST" });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ delegatedByBot: false }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(createInput).toMatchObject({
      agent: "codex",
      workingDirectory: "/tmp/project",
      name: "restartme (resumed)",
      npub: "npub1owner",
    });
    const capturedCreateInput = createInput as unknown as Record<string, any>;
    expect(capturedCreateInput.metadata.resumedFromWingmanSessionId).toBe("archived-session-1");
    expect(capturedCreateInput.metadata.nativeAgentSession.sessionId).toBe("codex-archived-native-1");
    await expect(response!.json()).resolves.toMatchObject({
      session: {
        id: "new-archived-resume-session",
        metadata: {
          resumedFromWingmanSessionId: "archived-session-1",
          nativeAgentSession: { sessionId: "codex-archived-native-1" },
        },
      },
    });
  });

  test("GET /api/archive applies category filters and returns group counts", async () => {
    const archivedSession = {
      id: "auto-session",
      agent: "codex",
      name: "Auto session",
      npub: "npub1owner",
      workingDirectory: "/tmp/project",
      startedAt: new Date().toISOString(),
      archivedAt: new Date().toISOString(),
      messageCount: 0,
      origin: { type: "agent-work", id: "task-1" },
      metadata: { AGENT: true, billingMode: "subscription" as const, role: "agent-work" },
    };
    const listCalls: unknown[] = [];
    const countCalls: unknown[] = [];
    const ctx = buildCtx({
      sessionArchiveStore: {
        getArchivedSession: () => null,
        listArchivedSessions: (options: unknown) => {
          listCalls.push(options);
          return [archivedSession];
        },
        getArchiveCount: (options: unknown) => {
          countCalls.push(options);
          return options && typeof options === "object" && (options as { category?: string }).category === "my" ? 0 : 1;
        },
      } as any,
    });
    const url = new URL("http://localhost:3021/api/archive?category=auto&limit=25&offset=5");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth({ delegatedByBot: false }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      sessions: [{ id: "auto-session" }],
      total: 1,
      groupCounts: { my: 0, auto: 1 },
      limit: 25,
      offset: 5,
    });
    expect(listCalls[0]).toMatchObject({ category: "auto", limit: 25, offset: 5 });
    expect(countCalls).toContainEqual({ filter: "", since: "", category: "auto" });
    expect(countCalls).toContainEqual({ filter: "", since: "", category: "my" });
  });

  test("GET /api/sessions/:id returns stored session details when live session is missing", async () => {
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored session",
      npub: "npub1owner",
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      tabOrder: null,
      lastUpdatedAt: "2026-07-24T01:01:00.000Z",
      metadata: {
        AGENT: true,
        billingMode: "subscription",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        rehydrateSession: () => null,
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      agent: "codex",
      status: "running",
      name: "stored session",
      npub: "npub1owner",
      ownerNpub: "npub1owner",
      identityAlias: expect.any(String),
      port: 3700,
      pid: 1234,
      startedAt: baseSession.startedAt,
      lastUpdatedAt: "2026-07-24T01:01:00.000Z",
      command: ["codex"],
      workingDirectory: "/tmp/project",
      origin: null,
      model: null,
      targetFile: null,
      tabOrder: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
      },
    });
  });

  test("GET /api/sessions/:id returns stored sessions owned via metadata.ownerNpub", async () => {
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored delegated session",
      npub: null,
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      tabOrder: null,
      lastUpdatedAt: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
        ownerNpub: "npub1owner",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        rehydrateSession: () => null,
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      npub: null,
      ownerNpub: "npub1owner",
      metadata: {
        ownerNpub: "npub1owner",
      },
    });
  });

  test("GET /api/sessions/:id/messages returns stored messages when live session is missing", async () => {
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored session",
      npub: "npub1owner",
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      tabOrder: null,
      lastUpdatedAt: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        rehydrateSession: () => null,
      } as any,
      messageStore: {
        recordSession: () => {},
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [{
          id: "sqlite-row-1", sessionId: "session-1", role: "agent-working", content: "stored output",
          createdAt: "2026-08-04T02:47:58.000Z", messageId: "acp-turn-2-working", turnId: "acp-turn-2", order: 1001,
        }],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      messages: [{
        id: "sqlite-row-1", sessionId: "session-1", role: "agent-working", content: "stored output",
        createdAt: "2026-08-04T02:47:58.000Z", messageId: "acp-turn-2-working", turnId: "acp-turn-2", order: 1001,
      }],
    });
  });

  test("PATCH /api/sessions/:id/metadata updates autonomous hook metadata", async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const updatedSession = {
      ...baseSession,
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Ship the release",
        nextAction: "reflect" as const,
        nextActionTemplate: "Goal: {{goal}}",
        lastManagedByNpub: "npub1owner",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? baseSession : undefined),
        listSessions: () => [baseSession],
        updateSessionMetadata: (id: string, metadata: Record<string, unknown>) => {
          if (id !== "session-1") return null;
          updatePayload = metadata;
          return updatedSession;
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/metadata");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Ship the release",
        nextAction: "reflect",
        nextActionTemplate: "Goal: {{goal}}",
      }),
    });

    const response = await handleSessionApi(request, url, "PATCH", makeAuth({ actorNpub: "npub1owner", delegatedByBot: false }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(updatePayload as Record<string, unknown>).toEqual({
      goal: "Ship the release",
      nextAction: "reflect",
      nextActionTemplate: "Goal: {{goal}}",
      lastManagedByNpub: "npub1bot",
    });
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: updatedSession.metadata,
    });
  });

  test("PATCH /api/sessions/:id/metadata falls back to stored session metadata for delegated bot auth", async () => {
    let persistedRecord: Record<string, unknown> | null = null;
    const storedSession: StoredSessionRecord = {
      id: "session-1",
      agent: "codex",
      startedAt: baseSession.startedAt,
      name: "stored session",
      npub: "npub1owner",
      port: 3700,
      pid: 1234,
      pm2Name: null,
      logsDir: null,
      workingDirectory: "/tmp/project",
      command: JSON.stringify(["codex"]),
      runtimeStatus: "running",
      origin: null,
      model: null,
      targetFile: null,
      tabOrder: null,
      lastUpdatedAt: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription",
        goal: "Ship the release",
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => [],
        updateSessionMetadata: () => null,
      } as any,
      messageStore: {
        recordSession: (session: Record<string, unknown>) => {
          persistedRecord = session;
        },
        getSession: (id: string) => (id === "session-1" ? storedSession : null),
        listSessions: () => [storedSession],
        listSessionMessages: () => [],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/metadata");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nextAction: "stop" }),
    });

    const response = await handleSessionApi(
      request,
      url,
      "PATCH",
      makeAuth({
        npub: "npub1bot",
        actorNpub: "npub1bot",
        signerNpub: "npub1bot",
        subjectNpub: "npub1bot",
        delegatedOwnerNpub: "npub1owner",
        delegatedByBot: true,
      }),
      ctx,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(persistedRecord).toMatchObject({
      id: "session-1",
      npub: "npub1owner",
      metadata: {
        AGENT: true,
        billingMode: "subscription",
        goal: "Ship the release",
        nextAction: "stop",
        lastManagedByNpub: "npub1bot",
        speechGenerateAudio: false,
        speechAlwaysRead: false,
      },
    });
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: {
        AGENT: true,
        autoStop: false,
        billingMode: "subscription",
        goal: "Ship the release",
        nextAction: "stop",
        lastManagedByNpub: "npub1bot",
        speechGenerateAudio: false,
        speechAlwaysRead: false,
      },
    });
  });

  test("GET /api/sessions/:id/metadata returns live session metadata", async () => {
    const session = {
      ...baseSession,
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Ship the release",
        nextAction: "reflect" as const,
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? session : undefined),
        listSessions: () => [session],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/metadata");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(
      request,
      url,
      "GET",
      makeAuth({ actorNpub: "npub1owner", delegatedByBot: false }),
      ctx,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: session.metadata,
    });
  });

  test("GET /api/sessions returns owner sessions for delegated bot auth in self space", async () => {
    const ctx = buildCtx({
      manager: {
        listSessions: () => [{ ...baseSession, npub: "npub1owner" }],
      } as any,
      buildIdentitySummaries: () => [],
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(
      request,
      url,
      "GET",
      makeAuth({
        npub: "npub1bot",
        actorNpub: "npub1bot",
        signerNpub: "npub1bot",
        subjectNpub: "npub1bot",
        delegatedOwnerNpub: "npub1owner",
        delegatedByBot: true,
      }),
      ctx,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      sessions: [{ id: "session-1", npub: "npub1owner" }],
    });
  });

  test("POST /api/sessions/bulk-close-stale-auto closes eligible stable sessions", async () => {
    const autoSession = {
      ...baseSession,
      origin: { type: "agent-work", id: "task-1" },
      metadata: { AGENT: true, billingMode: "subscription" as const },
    };
    const stopped: string[] = [];
    const archived: string[] = [];
    const ctx = buildCtx({
      manager: {
        listSessions: () => [autoSession],
        getSession: (id: string) => id === autoSession.id ? autoSession : undefined,
        stopSession: async (id: string) => {
          stopped.push(id);
          return id === autoSession.id ? autoSession : undefined;
        },
      } as any,
      messageStore: {
        getSession: () => ({ lastUpdatedAt: new Date(Date.now() - 22 * 60_000).toISOString() }),
      } as any,
      getPromptReadinessForSession: async () => ({
        state: "ready",
        reason: "test-ready",
        retryAfterMs: 1,
        observedAt: Date.now(),
      }),
      scheduleSessionArchive: (id) => archived.push(id),
    });
    const url = new URL("http://localhost:3021/api/sessions/bulk-close-stale-auto");
    const response = await handleSessionApi(
      new Request(url.toString(), { method: "POST" }),
      url,
      "POST",
      makeAuth(),
      ctx,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ eligible: 1, closed: [autoSession.id], failed: [] });
    expect(stopped).toEqual([autoSession.id]);
    expect(archived).toEqual([autoSession.id]);
  });

  test("GET /api/sessions includes sessions owned via metadata.ownerNpub", async () => {
    const delegatedSession = {
      ...baseSession,
      id: "session-meta-owner",
      npub: null,
      metadata: {
        AGENT: true,
        billingMode: "subscription" as const,
        ownerNpub: "npub1owner",
      },
    };
    const ctx = buildCtx({
      manager: {
        listSessions: () => [delegatedSession],
      } as any,
      serializeSession: (session) => ({
        id: session.id,
        npub: session.npub,
        ownerNpub: session.metadata?.ownerNpub ?? null,
        metadata: session.metadata,
      }),
      buildIdentitySummaries: () => [],
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      sessions: [{ id: "session-meta-owner", ownerNpub: "npub1owner" }],
    });
  });

  test("PATCH /api/sessions/:id moves a session to the requested tab position", async () => {
    const sessions = new Map<string, SessionSnapshot>([
      ["session-1", { ...baseSession, id: "session-1", name: "Autopilot-1", tabOrder: 1 }],
      ["session-2", { ...baseSession, id: "session-2", name: "Example Agent-1", tabOrder: 2 }],
      ["session-3", { ...baseSession, id: "session-3", name: "Fable", tabOrder: 3 }],
    ]);
    const recordedOrders: Record<string, number | null | undefined> = {};
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => sessions.get(id),
        listSessions: () => Array.from(sessions.values()),
        renameSession: (id: string, name: string) => {
          const session = sessions.get(id);
          if (!session) return null;
          const next = { ...session, name };
          sessions.set(id, next);
          return next;
        },
        updateSessionTabOrder: (id: string, tabOrder: number | null) => {
          const session = sessions.get(id);
          if (!session) return null;
          const next = { ...session, tabOrder };
          sessions.set(id, next);
          return next;
        },
      } as any,
      messageStore: {
        recordSession: (session: { id: string; tabOrder?: number | null }) => {
          recordedOrders[session.id] = session.tabOrder;
        },
        getSession: () => null,
        listSessions: () => [],
        listSessionMessages: () => [],
      } as any,
      serializeSession: (session) => ({
        id: session.id,
        name: session.name,
        tabOrder: session.tabOrder ?? null,
        npub: session.npub,
        metadata: session.metadata,
        origin: session.origin,
      }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-2");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Example Agent-1", position: 1 }),
    });

    const response = await handleSessionApi(request, url, "PATCH", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-2",
      tabOrder: 1,
    });
    expect(sessions.get("session-2")?.tabOrder).toBe(1);
    expect(sessions.get("session-1")?.tabOrder).toBe(2);
    expect(sessions.get("session-3")?.tabOrder).toBe(3);
    expect(recordedOrders).toMatchObject({
      "session-1": 2,
      "session-2": 1,
      "session-3": 3,
    });
  });

  test("PATCH /api/owners/:owner/sessions/:id/metadata updates owner-space metadata", async () => {
    let updatePayload: Record<string, unknown> | undefined;
    const updatedSession = {
      ...baseSession,
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Review task state",
        nextAction: "stop" as const,
        lastManagedByNpub: "npub1owner",
      },
    };
    const ownerSession = { ...baseSession, npub: "npub1owner" };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? ownerSession : undefined),
        listSessions: () => [ownerSession],
        updateSessionMetadata: (id: string, metadata: Record<string, unknown>) => {
          if (id !== "session-1") return null;
          updatePayload = metadata;
          return updatedSession;
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/owners/npub1owner/sessions/session-1/metadata");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { goal: "Review task state", nextAction: "stop" } }),
    });

    const ownerAuth = makeAuth({
      npub: "npub1owner",
      actorNpub: "npub1owner",
      signerNpub: "npub1owner",
      subjectNpub: "npub1owner",
      delegatedByBot: false,
      delegatedOwnerNpub: "npub1owner",
    });
    const response = await handleSessionApi(request, url, "PATCH", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(updatePayload as Record<string, unknown>).toEqual({
      goal: "Review task state",
      nextAction: "stop",
      lastManagedByNpub: "npub1owner",
    });
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      ownerNpub: "npub1owner",
      metadata: updatedSession.metadata,
    });
  });

  test("GET /api/owners/:owner/sessions/:id/metadata returns owner-space metadata", async () => {
    const ownerSession = {
      ...baseSession,
      npub: "npub1owner",
      metadata: {
        AGENT: false,
        billingMode: "subscription" as const,
        goal: "Review task state",
        nextAction: "stop" as const,
      },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? ownerSession : undefined),
        listSessions: () => [ownerSession],
      } as any,
    });

    const url = new URL("http://localhost:3021/api/owners/npub1owner/sessions/session-1/metadata");
    const request = new Request(url.toString(), { method: "GET" });

    const ownerAuth = makeAuth({
      npub: "npub1owner",
      actorNpub: "npub1owner",
      signerNpub: "npub1owner",
      subjectNpub: "npub1owner",
      delegatedByBot: false,
      delegatedOwnerNpub: "npub1owner",
    });
    const response = await handleSessionApi(request, url, "GET", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      ownerNpub: "npub1owner",
      metadata: ownerSession.metadata,
    });
  });

  test("GET /api/sessions/:id returns 409 for ambiguous owned prefixes", async () => {
    const sessions = [
      { ...baseSession, id: "26866c4d-835b-4ab8-b477-128fe2e29095", name: "tower-sync-progress" },
      { ...baseSession, id: "26866c4d-1111-4ab8-b477-128fe2e29095", name: "tower-sync-other" },
    ];
    const ctx = buildCtx({
      manager: {
        getSession: () => undefined,
        listSessions: () => sessions,
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/26866c4d");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(409);
    await expect(response!.json()).resolves.toEqual({
      error: "Ambiguous session id",
      matches: [
        { id: "26866c4d-835b-4ab8-b477-128fe2e29095", name: "tower-sync-progress" },
        { id: "26866c4d-1111-4ab8-b477-128fe2e29095", name: "tower-sync-other" },
      ],
    });
  });

  test("POST /api/delegate-sessions creates an AGENT-managed session for the owner linked to the bot", async () => {
    let explicitNpub: string | undefined;
    let explicitMetadata: unknown;
    let explicitOrigin: unknown;

    const ctx = buildCtx({
      manager: {
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          explicitNpub = npub;
          explicitMetadata = metadata;
          explicitOrigin = origin;
          return {
            ...baseSession,
            agent,
            workingDirectory,
            name: name ?? baseSession.name,
            origin: origin ?? null,
            targetFile,
            npub: npub ?? null,
            metadata: metadata ?? null,
          };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", name: "worker" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitNpub).toBe("npub1owner");
    expect(explicitMetadata).toMatchObject({
      AGENT: true,
      ownerNpub: "npub1owner",
      createdByNpub: "npub1bot",
      lastManagedByNpub: "npub1bot",
      chargeToNpub: "npub1owner",
    });
    expect(explicitOrigin).toEqual({
      type: "delegate-bot",
      id: "npub1bot",
      label: "npub1bot",
    });
  });

  test("POST /api/delegate-sessions accepts owner NIP-98 (non-bot) with cli origin", async () => {
    let explicitOrigin: unknown;

    const ctx = buildCtx({
      manager: {
        createSession: async (
          agent: string,
          workingDirectory: string,
          name?: string,
          origin?: unknown,
          targetFile?: string,
          npub?: string,
          metadata?: unknown,
        ) => {
          explicitOrigin = origin;
          return {
            ...baseSession,
            agent,
            workingDirectory,
            name: name ?? baseSession.name,
            origin: origin ?? null,
            targetFile,
            npub: npub ?? null,
            metadata: metadata ?? null,
          };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", name: "owner-cli" }),
    });

    const ownerAuth = makeAuth({ actorNpub: "npub1owner", delegatedByBot: false });
    const response = await handleSessionApi(request, url, "POST", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitOrigin).toEqual({
      type: "cli",
      id: "npub1owner",
      label: "npub1owner",
    });
  });

  test("DELETE /api/sessions/:id allows owner NIP-98 to stop non-AGENT sessions", async () => {
    const nonAgentSession = {
      ...baseSession,
      metadata: { AGENT: false, billingMode: "subscription" as const },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? nonAgentSession : undefined),
        listSessions: () => [nonAgentSession],
        stopSession: async (id: string) => (id === "session-1" ? nonAgentSession : null),
      } as any,
      serializeSession: (session) => ({ id: session.id, metadata: session.metadata }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1");
    const request = new Request(url.toString(), { method: "DELETE" });

    const ownerAuth = makeAuth({ actorNpub: "npub1owner", delegatedByBot: false });
    const response = await handleSessionApi(request, url, "DELETE", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
  });

  test("POST /api/sessions allows caller to set metadata.AGENT via body", async () => {
    let explicitMetadata: unknown;
    const ctx = buildCtx({
      manager: {
        createSession: async (
          _agent: string,
          _workingDirectory: string,
          _name?: string,
          _origin?: unknown,
          _targetFile?: string,
          _npub?: string,
          metadata?: unknown,
        ) => {
          explicitMetadata = metadata;
          return { ...baseSession, metadata: metadata ?? baseSession.metadata };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", metadata: { AGENT: true } }),
    });

    const ownerAuth = makeAuth({ actorNpub: "npub1owner", delegatedByBot: false });
    const response = await handleSessionApi(request, url, "POST", ownerAuth, ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(explicitMetadata).toMatchObject({
      AGENT: true,
      ownerNpub: "npub1owner",
      createdByNpub: "npub1bot",
      lastManagedByNpub: "npub1bot",
      chargeToNpub: "npub1owner",
    });
  });

  test("POST /api/sessions marks non-browser API launches as agent-managed", async () => {
    const metadataByAuth: unknown[] = [];
    const ctx = buildCtx({
      manager: {
        createSession: async (
          _agent: string,
          _workingDirectory: string,
          _name?: string,
          _origin?: unknown,
          _targetFile?: string,
          _npub?: string,
          metadata?: unknown,
        ) => {
          metadataByAuth.push(metadata);
          return { ...baseSession, id: `session-${metadataByAuth.length}`, metadata: metadata ?? baseSession.metadata };
        },
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions");
    const makeRequest = () => new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex" }),
    });

    const browserResponse = await handleSessionApi(
      makeRequest(),
      url,
      "POST",
      makeAuth({ authMethod: "session", session: { id: "viewer", npub: "npub1owner" } as any, delegatedByBot: false }),
      ctx,
    );
    const apiResponse = await handleSessionApi(
      makeRequest(),
      url,
      "POST",
      makeAuth({ authMethod: "nip98", delegatedByBot: false }),
      ctx,
    );

    expect(browserResponse?.status).toBe(201);
    expect(apiResponse?.status).toBe(201);
    expect(metadataByAuth[0]).toMatchObject({ AGENT: false });
    expect(metadataByAuth[1]).toMatchObject({ AGENT: true });
  });

  test("GET /api/delegate-sessions/:id/messages refreshes live messages", async () => {
    const messages = [{ role: "agent", content: "READY" }];
    const ctx = buildCtx({
      syncSessionMessages: async () => messages,
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions/session-1/messages?refresh=true");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handleSessionApi(request, url, "GET", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({ id: "session-1", messages });
  });

  test("POST /api/delegate-sessions/:id/messages queues and dispatches for a stable same-owner session", async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const messages = [
      { role: "user", content: "ping" },
      { role: "agent", content: "pong" },
    ];
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? { ...baseSession, agentRuntimeStatus: "stable" } : undefined),
        listSessions: () => [{ ...baseSession, agentRuntimeStatus: "stable" }],
      } as any,
      promptQueueStore: {
        addPrompt: (_id: string, prompt: { content: string }) => {
          prompts.push(prompt);
          return { id: "prompt-1", ...prompt };
        },
      } as any,
      dispatchNextQueuedPromptForSession: async () => ({ id: "session-1", messages, sentPrompt: { content: "ping" } }),
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions/session-1/messages");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "ping" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(prompts).toEqual([{ content: "ping" }]);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      queued: false,
      messages,
    });
  });

  test("POST /api/sessions/:id/messages sends via the pi adapter for pi sessions", async () => {
    let sentContent: string | null = null;
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? { ...baseSession, agent: "pi" } : undefined),
        listSessions: () => [{ ...baseSession, agent: "pi" }],
        getAdapter: () => ({
          deliversPromptsDirectly: () => true,
          waitForReady: async () => undefined,
          sendMessage: async (content: string) => {
            sentContent = content;
          },
        }),
      } as any,
      waitForMessageUpdate: async () => [
        { role: "user", content: "ping" },
        { role: "assistant", content: "pong" },
      ],
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "ping" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(sentContent).toBe("ping");
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      messages: [
        { role: "user", content: "ping" },
        { role: "assistant", content: "pong" },
      ],
    });
  });

  test("POST /api/sessions/:id/messages retains a busy ACP follow-up without a 502", async () => {
    const sent: string[] = [];
    const queued: Array<{ content: string }> = [];
    const maybeAutoDispatchQueuedPrompt = mock(() => undefined);
    const busySession = { ...baseSession, agent: "goose" as const, agentRuntimeStatus: "running" as const };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? busySession : undefined),
        listSessions: () => [busySession],
        getAdapter: () => ({
          deliversPromptsDirectly: () => true,
          sendMessage: async (content: string) => { sent.push(content); },
        }),
      } as any,
      getPromptReadinessForSession: async () => ({
        state: "busy",
        reason: "goose-waiting-permission",
        retryAfterMs: 1000,
        observedAt: Date.now(),
      }),
      promptQueueStore: {
        addPrompt: (_id: string, prompt: { content: string }) => {
          queued.push(prompt);
          return { id: "prompt-1", sessionId: "session-1", timestamp: new Date().toISOString(), order: 1, ...prompt };
        },
      } as any,
      maybeAutoDispatchQueuedPrompt,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages");
    const response = await handleSessionApi(new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "why did you pause?" }),
    }), url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);

    expect(response?.status).toBe(202);
    expect(sent).toEqual([]);
    expect(queued).toEqual([{ content: "why did you pause?" }]);
    expect(maybeAutoDispatchQueuedPrompt).toHaveBeenCalledWith(busySession);
    await expect(response?.json()).resolves.toMatchObject({
      id: "session-1",
      queued: true,
      prompt: { id: "prompt-1", content: "why did you pause?" },
      readiness: { state: "busy", reason: "goose-waiting-permission" },
    });
  });

  test("permission response errors remain actionable and leave the request pending", async () => {
    let stillPending = true;
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? baseSession : undefined),
        listSessions: () => [baseSession],
        getAdapter: () => ({
          getPendingPermissions: () => stillPending ? [{ id: "permission-1" }] : [],
          respondToPermission: async () => {
            const error = Object.assign(new Error("Goose ACP permission does not offer Always allow"), { status: 422 });
            throw error;
          },
        }),
      } as any,
    });
    const url = new URL("http://localhost:3021/api/sessions/session-1/permissions/permission-1");
    const response = await handleSessionApi(new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "always" }),
    }), url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);

    expect(response?.status).toBe(422);
    expect(stillPending).toBe(true);
    await expect(response?.json()).resolves.toEqual({
      error: "Failed to respond to permission: Goose ACP permission does not offer Always allow",
    });
  });

  test("POST /api/sessions/:id/interrupt cancels an active Pi ACP turn", async () => {
    let interrupted = false;
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? { ...baseSession, agent: "pi" } : undefined),
        listSessions: () => [{ ...baseSession, agent: "pi" }],
        getAdapter: () => ({
          interruptCurrentTurn: async () => {
            interrupted = true;
            return true;
          },
        }),
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/interrupt");
    const response = await handleSessionApi(
      new Request(url.toString(), { method: "POST" }),
      url,
      "POST",
      makeAuth({ session: { id: "viewer" } as any }),
      ctx,
    );

    expect(response?.status).toBe(200);
    expect(interrupted).toBe(true);
    await expect(response?.json()).resolves.toEqual({ id: "session-1", interrupted: true });
  });

  test("POST /api/sessions/:id/messages maps a generic busy 5xx into a queueable busy response", async () => {
    globalThis.fetch = async () => Response.json({ error: "Internal Server Error" }, { status: 500 });

    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? { ...baseSession, agentRuntimeStatus: "stable" } : undefined),
        listSessions: () => [{ ...baseSession, agentRuntimeStatus: "stable" }],
        getAdapter: () => ({
          fetchStatus: async () => "running",
        }),
      } as any,
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/messages");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "ping" }),
    });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(409);
    await expect(response!.json()).resolves.toMatchObject({
      error: "Agent working",
    });
  });

  test("POST /api/sessions/:id/queue/next dispatches the queued prompt", async () => {
    const ctx = buildCtx({
      dispatchNextQueuedPromptForSession: async () => ({ id: "session-1", sentPrompt: { content: "queued" }, messages: [] }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/queue/next");
    const request = new Request(url.toString(), { method: "POST" });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      sentPrompt: { content: "queued" },
    });
  });

  test("POST /api/sessions/:id/queue/dispatch aliases to the queued prompt dispatcher", async () => {
    const ctx = buildCtx({
      dispatchNextQueuedPromptForSession: async () => ({ id: "session-1", sentPrompt: { content: "queued" }, messages: [] }),
    });

    const url = new URL("http://localhost:3021/api/sessions/session-1/queue/dispatch");
    const request = new Request(url.toString(), { method: "POST" });

    const response = await handleSessionApi(request, url, "POST", makeAuth({ session: { id: "viewer" } as any }), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: "session-1",
      sentPrompt: { content: "queued" },
    });
  });

  test("DELETE /api/delegate-sessions/:id allows a delegated bot to stop a same-owner session", async () => {
    const stoppedSession = {
      ...baseSession,
      metadata: { AGENT: false, billingMode: "subscription" },
    };
    const ctx = buildCtx({
      manager: {
        getSession: (id: string) => (id === "session-1" ? stoppedSession : undefined),
        listSessions: () => [stoppedSession],
        stopSession: async (id: string) => (id === "session-1" ? stoppedSession : null),
      } as any,
      serializeSession: (session) => ({ id: session.id, metadata: session.metadata }),
    });

    const url = new URL("http://localhost:3021/api/delegate-sessions/session-1");
    const request = new Request(url.toString(), { method: "DELETE" });

    const response = await handleSessionApi(request, url, "DELETE", makeAuth(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      id: "session-1",
      metadata: { AGENT: false, billingMode: "subscription" },
    });
  });
});
