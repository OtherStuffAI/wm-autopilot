import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { warmRestartState } from "./bootstrap/warm-restart";
import { handleSystemRoutes, type SystemRoutesContext } from "./system-routes";
import type { RequestAuthContext } from "../auth/request-context";

const agentAuth: RequestAuthContext = {
  npub: "npub1wingman",
  actorNpub: "npub1wingman",
  session: null,
  delegatedByBot: false,
};

describe("handleSystemRoutes restart", () => {
  beforeEach(() => {
    warmRestartState.inProgress = false;
    warmRestartState.marker = null;
  });

  test("allows trusted restart status reads and preserves explicit access denials", async () => {
    const url = new URL("http://localhost/api/system/restart/status");
    const baseContext = {
      ensureApiAccess: async () => Response.json({ error: "admin-only" }, { status: 403 }),
      AccessActions: { SystemManage: "system:manage" },
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
    expect(denied!.status).toBe(403);
    expect(await denied!.json()).toEqual({ error: "admin-only" });
  });

  test("allows the trusted Wingman agent and queues fresh recovery when native metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-system-fresh-restart-"));
    let stopCalls = 0;
    let scheduledMarker: unknown = null;
    const ctx = {
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
      restartMarkerPath: join(root, "restart.json"),
      manager: {
        listSessions: () => [session],
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
      status: "sessions-stopped",
      sessionIds: ["session-1"],
    });
    expect(scheduledMarker).toMatchObject({ mode: "resume-or-fresh", sessionIds: ["session-1"] });
  });

  test("uses the same recovery policy on the canonical restart endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-system-canonical-restart-"));
    let scheduledMarker: unknown = null;
    const ctx = {
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
      restartMarkerPath: markerPath,
      manager: {
        listSessions: () => [session],
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
    expect(await response!.json()).toMatchObject({ error: "manager unavailable", rollbackFailed: [] });
    expect(origins).toEqual(["restart-fresh"]);
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });
});
