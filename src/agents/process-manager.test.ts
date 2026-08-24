import { describe, expect, test } from "bun:test";

import {
  ProcessManager,
  buildBunAgentLaunchCommand,
  normalizeAgentModelOverride,
  resolveGooseModelOverride,
  resolveNativeOpenCodeCommand,
  resolveNewSessionAcpPermissionPolicy,
  shouldCleanupMcpFiles,
  pm2StopShouldMarkStopped,
  transportRequiresEagerReadiness,
  transportUsesAcpPermissionPolicy,
  transportSkipsAgentApiSpawn,
} from "./process-manager";
import type { WingmanConfig } from "../config";

describe("pm2StopShouldMarkStopped", () => {
  test("returns true when PM2 process was successfully deleted", () => {
    expect(pm2StopShouldMarkStopped({ deletedFromPm2: true })).toBe(true);
  });

  test("returns false when PM2 delete failed and process is still present", () => {
    expect(pm2StopShouldMarkStopped({ deletedFromPm2: false })).toBe(false);
  });
});

describe("transportSkipsAgentApiSpawn", () => {
  test("uses AgentAPI for Pi by default and skips it for Pi ACP", () => {
    expect(transportSkipsAgentApiSpawn("agentapi")).toBe(false);
    expect(transportSkipsAgentApiSpawn("pi-acp")).toBe(true);
    expect(transportSkipsAgentApiSpawn("maple-acp")).toBe(true);
  });
});

describe("transportRequiresEagerReadiness", () => {
  test("waits at creation for every managed ACP transport and the OpenCode SDK", () => {
    expect(transportRequiresEagerReadiness("codex-acp")).toBe(true);
    expect(transportRequiresEagerReadiness("goose-acp")).toBe(true);
    expect(transportRequiresEagerReadiness("pi-acp")).toBe(true);
    expect(transportRequiresEagerReadiness("maple-acp")).toBe(true);
    expect(transportRequiresEagerReadiness("opencode-sdk")).toBe(true);
    expect(transportRequiresEagerReadiness("agentapi")).toBe(false);
  });

  test("keeps ACP permission policy separate from SDK readiness", () => {
    expect(transportUsesAcpPermissionPolicy("goose-acp")).toBe(true);
    expect(transportUsesAcpPermissionPolicy("maple-acp")).toBe(true);
    expect(transportUsesAcpPermissionPolicy("opencode-sdk")).toBe(false);
  });
});

describe("resolveNewSessionAcpPermissionPolicy", () => {
  test("uses the Autopilot default, accepts an override, and ignores non-ACP transports", () => {
    expect(resolveNewSessionAcpPermissionPolicy("goose-acp", undefined, undefined)).toBe("auto_approve");
    expect(resolveNewSessionAcpPermissionPolicy("codex-acp", "ask", "auto_approve")).toBe("ask");
    expect(resolveNewSessionAcpPermissionPolicy("pi-acp", undefined, "ask")).toBe("ask");
    expect(resolveNewSessionAcpPermissionPolicy("maple-acp", undefined, undefined)).toBe("auto_approve");
    expect(resolveNewSessionAcpPermissionPolicy("maple-acp", undefined, "auto_approve")).toBe("auto_approve");
    expect(resolveNewSessionAcpPermissionPolicy("maple-acp", "ask", "auto_approve")).toBe("ask");
    expect(resolveNewSessionAcpPermissionPolicy("opencode-sdk", "auto_approve", "ask")).toBeUndefined();
    expect(resolveNewSessionAcpPermissionPolicy("agentapi", "auto_approve", "ask")).toBeUndefined();
    expect(() => resolveNewSessionAcpPermissionPolicy("goose-acp", "unsafe", "ask"))
      .toThrow("ACP permission policy must be auto_approve or ask");
  });
});

describe("buildBunAgentLaunchCommand", () => {
  test("matches the PM2 shell boundary and closes stdin", () => {
    expect(buildBunAgentLaunchCommand([
      "/app/out/agentapi",
      "server",
      "--type=codex",
      "--",
      "/usr/local/bin/codex",
    ])).toEqual([
      "bash",
      "-lc",
      "exec '/app/out/agentapi' 'server' '--type=codex' '--' '/usr/local/bin/codex' < /dev/null",
    ]);
  });

  test("preserves shell-sensitive command arguments verbatim", () => {
    expect(buildBunAgentLaunchCommand([
      "agentapi",
      "value with spaces",
      "it's literal",
      "$HOME",
    ])).toEqual([
      "bash",
      "-lc",
      "exec 'agentapi' 'value with spaces' 'it'\"'\"'s literal' '$HOME' < /dev/null",
    ]);
  });
});

describe("shouldCleanupMcpFiles", () => {
  test("skips cleanup while another active session shares the same file", () => {
    const sessions = [
      {
        id: "stopping-session",
        status: "running" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
      {
        id: "other-active-session",
        status: "running" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
    ];

    expect(
      shouldCleanupMcpFiles(sessions, "stopping-session", ["/tmp/shared/.mcp.json"]),
    ).toBe(false);
  });

  test("allows cleanup once only stopped sessions still reference the file", () => {
    const sessions = [
      {
        id: "stopping-session",
        status: "running" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
      {
        id: "already-stopped-session",
        status: "stopped" as const,
        mcpCleanupFiles: ["/tmp/shared/.mcp.json"],
      },
    ];

    expect(
      shouldCleanupMcpFiles(sessions, "stopping-session", ["/tmp/shared/.mcp.json"]),
    ).toBe(true);
  });
});

describe("normalizeAgentModelOverride", () => {
  test("treats default as no model override", () => {
    expect(normalizeAgentModelOverride(undefined)).toBe("");
    expect(normalizeAgentModelOverride("")).toBe("");
    expect(normalizeAgentModelOverride(" default ")).toBe("");
    expect(normalizeAgentModelOverride("Default")).toBe("");
  });

  test("keeps explicit model overrides", () => {
    expect(normalizeAgentModelOverride("gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("resolveGooseModelOverride", () => {
  test("leaves Goose model selection unset when launcher and operator use defaults", () => {
    expect(resolveGooseModelOverride("default", null)).toBeUndefined();
    expect(resolveGooseModelOverride(undefined, "")).toBeUndefined();
  });

  test("preserves explicit launcher model IDs over an operator override", () => {
    expect(resolveGooseModelOverride(
      "openrouter/anthropic/claude-opus-5-fast",
      "moonshotai/kimi-k3",
    )).toBe("openrouter/anthropic/claude-opus-5-fast");
  });

  test("preserves a deliberate non-empty operator override", () => {
    expect(resolveGooseModelOverride("default", "custom/provider-model"))
      .toBe("custom/provider-model");
  });
});

describe("resolveNativeOpenCodeCommand", () => {
  test("starts OpenCode's native server and removes process-level model flags", () => {
    expect(resolveNativeOpenCodeCommand([
      "/repo/out/agentapi",
      "server",
      "--type=opencode",
      "--",
      "opencode",
      "--model",
      "openrouter/kimi",
    ], 3704)).toEqual([
      "opencode",
      "serve",
      "--port",
      "3704",
      "--hostname",
      "127.0.0.1",
    ]);
  });
});

describe("ProcessManager pinned files", () => {
  test("keeps a session-scoped pinned file history", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    manager.rehydrateSession({
      id: "session-1",
      agent: "codex",
      port: 3700,
      name: "Session 1",
      startedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      pinnedFile: "/tmp/old.md",
      metadata: { AGENT: true, pinnedFiles: ["/tmp/old.md"] },
    });

    manager.setPinnedFile("session-1", "/tmp/new.md");
    manager.setPinnedFile("session-1", " /tmp/old.md ");
    const snapshot = manager.removePinnedFile("session-1", "/tmp/old.md");

    expect(snapshot?.pinnedFile).toBe("/tmp/new.md");
    expect(snapshot?.metadata?.pinnedFiles).toEqual(["/tmp/new.md"]);
  });

  test("replaces pinned file history with the client ordered list", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    manager.rehydrateSession({
      id: "session-1",
      agent: "codex",
      port: 3700,
      name: "Session 1",
      startedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      pinnedFile: "/tmp/two.md",
      metadata: { AGENT: true, pinnedFiles: ["/tmp/one.md", "/tmp/two.md", "/tmp/three.md"] },
    });

    const snapshot = manager.setPinnedFiles(
      "session-1",
      ["/tmp/one.md", "/tmp/three.md", "/tmp/one.md"],
      "/tmp/three.md",
    );

    expect(snapshot?.pinnedFile).toBe("/tmp/three.md");
    expect(snapshot?.metadata?.pinnedFiles).toEqual(["/tmp/one.md", "/tmp/three.md"]);
  });

  test("emits an artifact open intent when a file is pinned", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    manager.rehydrateSession({
      id: "session-1",
      agent: "codex",
      port: 3700,
      name: "Session 1",
      startedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      pinnedFile: "/tmp/old.md",
      metadata: { AGENT: true, pinnedFiles: ["/tmp/old.md"] },
    });

    const events: unknown[] = [];
    manager.on((event) => {
      events.push(event);
    });

    manager.setPinnedFile("session-1", "/tmp/new.md");

    expect(events.at(-1)).toMatchObject({
      type: "session-updated",
      artifactIntent: {
        action: "open",
        filePath: "/tmp/new.md",
        pinnedFiles: ["/tmp/old.md", "/tmp/new.md"],
      },
    });
  });
});

describe("ProcessManager transport rehydration", () => {
  test("rehydrates Maple ACP with its persisted native session id", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        maple: {
          label: "Maple Desktop",
          command: () => ["agentapi", "--", "/Applications/Maple.app/Contents/MacOS/maple"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "maple-session", agent: "maple", port: 3700, name: "Maple",
      startedAt: new Date("2026-08-13T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp", metadata: {
        agentTransport: "maple-acp",
        nativeAgentSession: {
          agent: "maple", sessionId: "maple-session-123", workingDirectory: "/tmp",
          capturedAt: new Date("2026-08-13T00:00:00.000Z").toISOString(), source: "adapter",
        },
      },
    });
    expect(snapshot?.metadata.nativeAgentSession?.sessionId).toBe("maple-session-123");
    expect(snapshot?.metadata.acpPermissionPolicy).toBe("auto_approve");
    expect(manager.getAdapter("maple-session")?.constructor.name).toBe("MapleAcpAdapter");
  });

  test("keeps Maple's explicitly pinned ACP permission policy after restart", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        maple: {
          label: "Maple Desktop",
          command: () => ["agentapi", "--", "/Applications/Maple.app/Contents/MacOS/maple"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "maple-auto-approve", agent: "maple", port: 3705, name: "Maple",
      startedAt: new Date("2026-08-13T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      metadata: { agentTransport: "maple-acp", acpPermissionPolicy: "auto_approve" },
    });

    expect(snapshot?.metadata.acpPermissionPolicy).toBe("auto_approve");
  });

  test("keeps Maple's explicit ask policy after restart", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        maple: {
          label: "Maple Desktop",
          command: () => ["agentapi", "--", "/Applications/Maple.app/Contents/MacOS/maple"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "maple-ask", agent: "maple", port: 3706, name: "Maple",
      startedAt: new Date("2026-08-13T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      metadata: { agentTransport: "maple-acp", acpPermissionPolicy: "ask" },
    });

    expect(snapshot?.metadata.acpPermissionPolicy).toBe("ask");
  });

  test("keeps a persisted Codex AgentAPI transport independent of current flags", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "agentapi-session",
      agent: "codex",
      port: 3701,
      name: "AgentAPI Codex",
      startedAt: new Date("2026-07-29T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      metadata: { agentTransport: "agentapi" },
    });

    expect(snapshot?.metadata?.agentTransport).toBe("agentapi");
    expect(manager.getAdapter("agentapi-session")?.constructor.name).toBe("AgentApiAdapter");
  });

  test("rehydrates a persisted Codex ACP adapter and native session id", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "acp-session",
      agent: "codex",
      port: 3702,
      name: "ACP Codex",
      startedAt: new Date("2026-07-29T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      metadata: {
        agentTransport: "codex-acp",
        nativeAgentSession: {
          agent: "codex",
          sessionId: "thread-123",
          workingDirectory: "/tmp",
          capturedAt: new Date("2026-07-29T00:00:00.000Z").toISOString(),
          source: "adapter",
        },
      },
    });

    expect(snapshot?.metadata?.agentTransport).toBe("codex-acp");
    expect(snapshot?.metadata?.acpPermissionPolicy).toBe("ask");
    expect(snapshot?.metadata?.nativeAgentSession?.sessionId).toBe("thread-123");
    expect(manager.getAdapter("acp-session")?.constructor.name).toBe("CodexAcpAdapter");
  });

  test("rehydrates ACP sessions with their snapshotted permission policy", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "acp-policy-session",
      agent: "codex",
      port: 3799,
      name: "ACP policy",
      startedAt: new Date("2026-08-04T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      metadata: { agentTransport: "codex-acp", acpPermissionPolicy: "auto_approve" },
    });

    expect(snapshot?.metadata?.acpPermissionPolicy).toBe("auto_approve");
  });

  test("rehydrates Pi with its persisted AgentAPI transport", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        pi: {
          label: "Pi",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "pi"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "pi-agentapi-session",
      agent: "pi",
      port: 3703,
      name: "AgentAPI Pi",
      startedAt: new Date("2026-07-29T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      metadata: { agentTransport: "agentapi" },
    });

    expect(snapshot?.metadata?.agentTransport).toBe("agentapi");
    expect(manager.getAdapter("pi-agentapi-session")?.constructor.name).toBe("AgentApiAdapter");
  });

  test("rehydrates Pi ACP with its persisted native session id", () => {
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        pi: {
          label: "Pi",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "pi"],
        },
      },
    } as WingmanConfig);

    const snapshot = manager.rehydrateSession({
      id: "pi-acp-session",
      agent: "pi",
      port: 3704,
      name: "ACP Pi",
      startedAt: new Date("2026-07-29T00:00:00.000Z").toISOString(),
      workingDirectory: "/tmp",
      metadata: {
        agentTransport: "pi-acp",
        nativeAgentSession: {
          agent: "pi",
          sessionId: "pi-session-123",
          workingDirectory: "/tmp",
          capturedAt: new Date("2026-07-29T00:00:00.000Z").toISOString(),
          source: "adapter",
        },
      },
    });

    expect(snapshot?.metadata?.agentTransport).toBe("pi-acp");
    expect(snapshot?.metadata?.nativeAgentSession?.sessionId).toBe("pi-session-123");
    expect(manager.getAdapter("pi-acp-session")?.constructor.name).toBe("PiAcpAdapter");
  });
});

describe("ProcessManager capability lifecycle", () => {
  test("fails an owner-authenticated manual session closed when capability issuance fails", async () => {
    const revoked: string[] = [];
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agentPortStart: 47966,
      agentPortMax: 47967,
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig, {
      issueSessionCapability: () => {
        throw new Error("Session agent identity binding does not match requested capability identity");
      },
      revokeSessionCapabilities: (sessionId) => revoked.push(sessionId),
    });

    await expect(manager.createSession(
      "codex",
      "/tmp",
      "Manual",
      null,
      undefined,
      "npub1owner",
      { AGENT: false },
    )).rejects.toThrow("Session agent identity binding does not match requested capability identity");

    expect(manager.listSessions()).toEqual([]);
    expect((manager as unknown as { allocatedPorts: Set<number> }).allocatedPorts.size).toBe(0);
    expect(revoked).toHaveLength(1);
  });

  test("fails a scheduled Codex session closed when capability issuance fails", async () => {
    const revoked: string[] = [];
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agentPortStart: 47968,
      agentPortMax: 47969,
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig, {
      issueSessionCapability: () => {
        throw new Error("Session owner has no active bot identity");
      },
      revokeSessionCapabilities: (sessionId) => revoked.push(sessionId),
    });

    await expect(manager.createSession(
      "codex",
      "/tmp",
      "Scheduled",
      { type: "scheduler", id: "heartbeat" },
      undefined,
      "npub1owner",
      { AGENT: true, agentChatBotNpub: "npub1retired" },
    )).rejects.toThrow("Session owner has no active bot identity");

    expect(manager.listSessions()).toEqual([]);
    expect((manager as unknown as { allocatedPorts: Set<number> }).allocatedPorts.size).toBe(0);
    expect(revoked).toHaveLength(1);
  });

  test("fully cleans a pre-spawn session when broker provisioning is required", async () => {
    const revoked: string[] = [];
    const events: Array<{ type: string }> = [];
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agentPortStart: 47970,
      agentPortMax: 47971,
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig, {
      issueSessionCapability: () => {
        const error = new Error("broker_key_not_provisioned: complete the authenticated browser unlock once") as Error & { code: string };
        error.code = "broker_key_not_provisioned";
        throw error;
      },
      revokeSessionCapabilities: (sessionId) => revoked.push(sessionId),
    });
    manager.on((event) => events.push(event));

    await expect(manager.createSession("codex", "/tmp", "Provisioning", null, undefined, "npub1owner"))
      .rejects.toThrow("broker_key_not_provisioned");

    expect(manager.listSessions()).toEqual([]);
    expect((manager as unknown as { allocatedPorts: Set<number> }).allocatedPorts.size).toBe(0);
    expect(revoked).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["session-started", "session-stopped"]);
  });

  test("revokes session capabilities when a session stops and is deleted", async () => {
    const revoked: string[] = [];
    const manager = new ProcessManager({
      allowedHosts: "localhost,127.0.0.1",
      agents: {
        codex: {
          label: "Codex",
          command: ({ port }) => ["agentapi", "--port", String(port), "--", "codex"],
        },
      },
    } as WingmanConfig, {
      revokeSessionCapabilities: (sessionId) => revoked.push(sessionId),
    });
    manager.rehydrateSession({
      id: "capability-session",
      agent: "codex",
      port: 3799,
      name: "Capability",
      startedAt: new Date().toISOString(),
      workingDirectory: "/tmp",
      metadata: { agentTransport: "agentapi" },
    });

    await manager.stopSession("capability-session");
    expect(revoked).toEqual(["capability-session"]);
    expect(manager.deleteSession("capability-session")).toBe(true);
    expect(revoked).toEqual(["capability-session", "capability-session"]);
  });
});
