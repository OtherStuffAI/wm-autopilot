import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { WingmanConfig } from "../config";
import { ProcessManager } from "./process-manager";

const gooseConfigPath = join(homedir(), ".config", "goose", "config.yaml");
let originalGooseConfig: string | null = null;

beforeEach(() => {
  originalGooseConfig = existsSync(gooseConfigPath) ? readFileSync(gooseConfigPath, "utf8") : null;
});

afterEach(() => {
  if (originalGooseConfig === null) {
    rmSync(gooseConfigPath, { force: true });
    return;
  }
  mkdirSync(dirname(gooseConfigPath), { recursive: true });
  writeFileSync(gooseConfigPath, originalGooseConfig);
});

function readRpcLog(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function gooseConfig(cliPath: string, env: Record<string, string>, portStart: number): WingmanConfig {
  return {
    allowedHosts: "localhost,127.0.0.1",
    agentPortStart: portStart,
    agentPortMax: portStart,
    agents: {
      goose: {
        label: "Goose",
        command: ({ port }) => ["agentapi", "--port", String(port), "--", cliPath],
        env,
        modelOptions: ["default"],
      },
    },
  } as WingmanConfig;
}

describe("ProcessManager Goose ACP creation boundary", () => {
  test("returns a new session only after initialize and session/new reach ready", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "wingman-manager-goose-ready-"));
    const fakeCli = join(testDir, "goose");
    const rpcLog = join(testDir, "rpc.jsonl");
    writeFileSync(fakeCli, FAKE_GOOSE_ACP_SERVER);
    chmodSync(fakeCli, 0o755);
    const manager = new ProcessManager(gooseConfig(fakeCli, { TEST_ACP_LOG: rpcLog }, 47980));
    let sessionId: string | null = null;

    try {
      const snapshot = await manager.createSession(
        "goose",
        testDir,
        "Goose ready",
        null,
        undefined,
        undefined,
        { agentTransport: "goose-acp" },
        "default",
      );
      sessionId = snapshot.id;

      expect(snapshot.status).toBe("running");
      expect(snapshot.metadata?.acpPermissionPolicy).toBe("auto_approve");
      expect(snapshot.metadata?.nativeAgentSession?.sessionId).toBe("goose-manager-session");
      expect(readRpcLog(rpcLog).map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
      expect(snapshot.logs.some((entry) => entry.includes("Goose ACP initialization and session negotiation completed"))).toBe(true);
    } finally {
      if (sessionId) await manager.getAdapter(sessionId)?.dispose();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("snapshots an explicit ask override for a new Goose ACP session", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "wingman-manager-goose-policy-"));
    const fakeCli = join(testDir, "goose");
    const rpcLog = join(testDir, "rpc.jsonl");
    writeFileSync(fakeCli, FAKE_GOOSE_ACP_SERVER);
    chmodSync(fakeCli, 0o755);
    const manager = new ProcessManager(gooseConfig(fakeCli, { TEST_ACP_LOG: rpcLog }, 47984));
    let sessionId: string | null = null;

    try {
      const snapshot = await manager.createSession(
        "goose",
        testDir,
        "Goose ask policy",
        null,
        undefined,
        undefined,
        { agentTransport: "goose-acp", acpPermissionPolicy: "ask" },
      );
      sessionId = snapshot.id;
      expect(snapshot.metadata?.acpPermissionPolicy).toBe("ask");
    } finally {
      if (sessionId) await manager.getAdapter(sessionId)?.dispose();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("rejects creation and keeps a visible error session when session/new fails", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "wingman-manager-goose-failure-"));
    const fakeCli = join(testDir, "goose");
    const rpcLog = join(testDir, "rpc.jsonl");
    writeFileSync(fakeCli, FAKE_GOOSE_ACP_SERVER);
    chmodSync(fakeCli, 0o755);
    const manager = new ProcessManager(gooseConfig(fakeCli, {
      TEST_ACP_LOG: rpcLog,
      TEST_ACP_SESSION_ERROR: "1",
    }, 47981));

    try {
      await expect(manager.createSession(
        "goose",
        testDir,
        "Goose failure",
        null,
        undefined,
        undefined,
        { agentTransport: "goose-acp" },
        "default",
      )).rejects.toThrow("Goose ACP session/new failed: authentication required");

      const failed = manager.listSessions();
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe("error");
      expect(failed[0]?.logs.some((entry) => entry.includes("authentication required"))).toBe(true);
      expect(readRpcLog(rpcLog).map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
    } finally {
      const failedSession = manager.listSessions()[0];
      if (failedSession) await manager.getAdapter(failedSession.id)?.dispose();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

const FAKE_GOOSE_ACP_SERVER = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.TEST_ACP_LOG;
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\\n");
  const { id, method } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: 0,
      agentCapabilities: { loadSession: true },
    } });
    return;
  }
  if (method === "session/new") {
    if (process.env.TEST_ACP_SESSION_ERROR) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "authentication required" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { sessionId: "goose-manager-session" } });
  }
});
`;
