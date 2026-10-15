import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { warmRestartState } from "./bootstrap/warm-restart";
import { handleSystemRoutes, type SystemRoutesContext } from "./system-routes";
import type { RequestAuthContext } from "../auth/request-context";
import { restartDrainGate } from "./controlled-restart";

const agentAuth: RequestAuthContext = {
  npub: "npub1wingman",
  actorNpub: "npub1wingman",
  session: null,
  delegatedByBot: false,
};

const restartRecoveryDeps = () => ({
  controlledRestartOperationPath: join(tmpdir(), `controlled-restart-${crypto.randomUUID()}.json`),
  messageStore: { listSessions: () => [] },
  promptQueueStore: { getQueueCount: () => 0, rebindSession: () => 0 },
  sessionDispatchStore: { hasRecoveryWork: () => false, rebindSession: () => undefined },
  directChatTurnStore: { hasRecoverableSessionTurn: () => false },
  queueDispatchInFlight: new Set<string>(),
  controlledRestartGracePeriodMs: 0,
});

afterEach(() => restartDrainGate.leave());

test("FIPS status requires system access even for a trusted restart agent", async () => {
  const url = new URL("http://node.fips:3601/api/system/fips");
  const endpoint = { enabled: true, nodeNpub: "npub1node", meshAddress: "fd00::1", port: 3601, url: null, status: "unavailable" as const };
  const ctx = {
    ensureApiAccess: async () => Response.json({ error: "auth-required" }, { status: 401 }),
    AccessActions: { SystemManage: "system:manage" },
    isTrustedRestartAuthority: () => true,
    getFipsEndpoint: () => endpoint,
  } as unknown as SystemRoutesContext;
  const denied = await handleSystemRoutes(new Request(url), url, "GET", agentAuth, ctx);
  expect(denied!.status).toBe(401);
  const allowed = await handleSystemRoutes(new Request(url), url, "GET", agentAuth, { ...ctx, ensureApiAccess: async () => null });
  expect(await allowed!.json()).toEqual({ fips: endpoint });
});

describe("handleSystemRoutes restart", () => {
  beforeEach(() => {
    warmRestartState.inProgress = false;
    warmRestartState.marker = null;
  });

  test("requires direct admin NIP-98 for controlled restart", async () => {
    const url = new URL("http://node.fips:3601/api/system/controlled-restart");
    const base = {
      ensureApiAccess: async () => null,
      AccessActions: { SystemManage: "system:manage" },
    } as unknown as SystemRoutesContext;
    const bot = await handleSystemRoutes(new Request(url, { method: "POST", body: JSON.stringify({ confirm: "controlled-restart" }) }), url, "POST", agentAuth, base);
    expect(bot!.status).toBe(403);
    expect(await bot!.json()).toEqual({ error: "direct-admin-nip98-required" });
  });

  test("accepts an explicitly confirmed direct admin request", async () => {
    const root = await mkdtemp(join(tmpdir(), "controlled-restart-"));
    const url = new URL("http://node.fips:3601/api/system/controlled-restart");
    let marker: unknown;
    const auth = { ...agentAuth, authMethod: "nip98", signerNpub: "npub1pete" } as RequestAuthContext;
    const ctx = {
      ensureApiAccess: async () => null, AccessActions: { SystemManage: "system:manage" },
      manager: { listSessions: () => [], stopSession: async () => undefined },
      restartMarkerPath: join(root, "restart.json"), isAgentType: () => true,
      controlledRestartOperationPath: join(root, "controlled-restart.json"),
      messageStore: { listSessions: () => [] },
      promptQueueStore: { getQueueCount: () => 0, rebindSession: () => 0 },
      sessionDispatchStore: { hasRecoveryWork: () => false, rebindSession: () => undefined },
      directChatTurnStore: { hasRecoverableSessionTurn: () => false },
      queueDispatchInFlight: new Set(), controlledRestartGracePeriodMs: 0,
      launchRestart: async (value: unknown) => { marker = value; return Response.json({ status: "scheduled" }, { status: 202 }); },
    } as unknown as SystemRoutesContext;
    const response = await handleSystemRoutes(new Request(url, { method: "POST", body: JSON.stringify({ confirm: "controlled-restart" }) }), url, "POST", auth, ctx);
    expect(response!.status).toBe(202);
    expect(marker).toMatchObject({ requestedBy: "npub1pete", reason: "flightdeck-controlled-restart" });
  });

  test("allows trusted restart status reads and preserves explicit access denials", async () => {
    const url = new URL("http://localhost/api/system/restart/status");
    const runtimeIdentity = {
      controller: {
        execution: "bun-source",
        entrypoint: "src/index.ts",
        gitCommit: "controller-commit",
        sourceState: "clean",
        startedAt: "2026-10-15T07:45:00.000Z",
      },
      agentApi: null,
    } as const;
    const baseContext = {
      ensureApiAccess: async () => Response.json({ error: "admin-only" }, { status: 403 }),
      AccessActions: { SystemManage: "system:manage" },
      runtimeIdentity,
    } as unknown as SystemRoutesContext;

    const allowed = await handleSystemRoutes(
      new Request(url.toString()),
      url,
      "GET",
      agentAuth,
      { ...baseContext, isTrustedRestartAuthority: () => true },
    );
    const denied = await handleSystemRoutes(
      new Request(url.toString()),
      url,
      "GET",
      agentAuth,
      { ...baseContext, isTrustedRestartAuthority: () => false },
    );

    expect(allowed!.status).toBe(200);
    expect(await allowed!.json()).toMatchObject({ runtime: runtimeIdentity });
    expect(denied!.status).toBe(403);
    expect(await denied!.json()).toEqual({ error: "admin-only" });
  });

  test("allows the trusted Wingman agent and queues fresh recovery when native metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-system-fresh-restart-"));
    let stopCalls = 0;
    let scheduledMarker: unknown = null;
    const ctx = {
      ...restartRecoveryDeps(),
      manager: {
        listSessions: () => [{
          id: "session-1",
          name: "Uncaptured session",
          agent: "codex",
          status: "running",
          npub: "npub1owner",
          workingDirectory: "/tmp/project",
          metadata: {},
        }],
        getSession: () => ({ status: "running" }),
        stopSession: async () => {
          stopCalls += 1;
        },
      },
      restartMarkerPath: join(root, "restart.json"),
      ensureApiAccess: async () => Response.json({ error: "admin-only" }, { status: 403 }),
      AccessActions: { SystemManage: "system:manage" },
      isAgentType: (agent: string) => agent === "codex",
      isTrustedRestartAuthority: () => true,
      launchRestart: async (marker: unknown) => {
        scheduledMarker = marker;
        return Response.json({ status: "scheduled" }, { status: 202 });
      },
    } as unknown as SystemRoutesContext;
    const url = new URL("http://localhost/api/system/restart-and-resume");

    const response = await handleSystemRoutes(
      new Request(url, { method: "POST" }),
      url,
      "POST",
      agentAuth,
      ctx,
    );
    expect(response!.status).toBe(202);
    expect(scheduledMarker).toMatchObject({
      mode: "resume-or-fresh",
      sessionIds: ["session-1"],
    });
    expect(stopCalls).toBe(1);
  });

  test("records and stops every eligible session before scheduling restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-system-restart-"));
    const stopped: string[] = [];
    let scheduledMarker: unknown = null;
    const session = {
      id: "session-1",
      name: "Release session",
      agent: "codex",
      status: "running",
      npub: "npub1owner",
      workingDirectory: "/tmp/project",
      metadata: {
        nativeAgentSession: {
          agent: "codex",
          sessionId: "native-123",
          workingDirectory: "/tmp/project",
        },
      },
    };
    const ctx = {
      ...restartRecoveryDeps(),
      restartMarkerPath: join(root, "restart.json"),
      manager: {
        listSessions: () => [session],
        getSession: () => session,
        stopSession: async (sessionId: string) => {
          stopped.push(sessionId);
          return { ...session, status: "stopped" };
        },
      },
      ensureApiAccess: async () => null,
      AccessActions: { SystemManage: "system:manage" },
      isAgentType: (agent: string) => agent === "codex",
      isTrustedRestartAuthority: () => false,
      launchRestart: async (marker: unknown) => {
        scheduledMarker = marker;
        return Response.json({ status: "scheduled" }, { status: 202 });
      },
    } as unknown as SystemRoutesContext;
    const url = new URL("http://localhost/api/system/restart-and-resume");

    const response = await handleSystemRoutes(
      new Request(url, { method: "POST" }),
      url,
      "POST",
      agentAuth,
      ctx,
    );
    const storedMarker = await Bun.file(ctx.restartMarkerPath).json();

    expect(response!.status).toBe(202);
    expect(stopped).toEqual(["session-1"]);
    expect(storedMarker).toMatchObject({
      mode: "resume-or-fresh",
      status: "checkpointed",
      sessionIds: ["session-1"],
    });
    expect(scheduledMarker).toMatchObject({ mode: "resume-or-fresh", sessionIds: ["session-1"] });
  });

  test("uses the same recovery policy on the canonical restart endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-system-canonical-restart-"));
    let scheduledMarker: unknown = null;
    const ctx = {
      ...restartRecoveryDeps(),
      restartMarkerPath: join(root, "restart.json"),
      manager: {
        listSessions: () => [],
        stopSession: async () => undefined,
      },
      ensureApiAccess: async () => null,
      AccessActions: { SystemManage: "system:manage" },
      isAgentType: (agent: string) => agent === "codex",
      isTrustedRestartAuthority: () => false,
      launchRestart: async (marker: unknown) => {
        scheduledMarker = marker;
        return Response.json({ status: "scheduled" }, { status: 202 });
      },
    } as unknown as SystemRoutesContext;
    const url = new URL("http://localhost/api/system/restart");

    const response = await handleSystemRoutes(
      new Request(url, { method: "POST" }),
      url,
      "POST",
      agentAuth,
      ctx,
    );

    expect(response!.status).toBe(202);
    expect(scheduledMarker).toMatchObject({ mode: "resume-or-fresh", sessionIds: [] });
  });

  test("restores stopped sessions when the restart manager cannot launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-system-restart-rollback-"));
    const markerPath = join(root, "restart.json");
    const origins: string[] = [];
    const session = {
      id: "session-1",
      name: "Rollback work",
      agent: "codex",
      status: "running",
      npub: "npub1owner",
      workingDirectory: "/tmp/project",
      metadata: {},
    };
    const ctx = {
      ...restartRecoveryDeps(),
      restartMarkerPath: markerPath,
      manager: {
        listSessions: () => [session],
        getSession: () => session,
        stopSession: async () => ({ ...session, status: "stopped" }),
        createSession: async (...args: unknown[]) => {
          origins.push((args[3] as { type: string }).type);
          return { id: "session-rollback" };
        },
      },
      ensureApiAccess: async () => null,
      AccessActions: { SystemManage: "system:manage" },
      isAgentType: (agent: string) => agent === "codex",
      isTrustedRestartAuthority: () => false,
      launchRestart: async () => Response.json({ error: "manager unavailable" }, { status: 500 }),
    } as unknown as SystemRoutesContext;
    const url = new URL("http://localhost/api/system/restart");

    const response = await handleSystemRoutes(
      new Request(url, { method: "POST" }),
      url,
      "POST",
      agentAuth,
      ctx,
    );

    expect(response!.status).toBe(500);
    expect(await response!.json()).toMatchObject({
      error: "Failed to launch restart: manager unavailable; rollback failures: none",
      operation: { status: "failed", failure: { phase: "restart-requested" } },
    });
    expect(origins).toEqual(["restart-fresh"]);
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });
});
