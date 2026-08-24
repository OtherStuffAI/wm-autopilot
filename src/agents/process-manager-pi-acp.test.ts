import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { WingmanConfig } from "../config";
import { ProcessManager } from "./process-manager";

function readRpcLog(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function piConfig(acpCli: string, env: Record<string, string>, port: number): WingmanConfig {
  return {
    allowedHosts: "localhost,127.0.0.1",
    agentPortStart: port,
    agentPortMax: port,
    agents: {
      pi: {
        label: "Pi",
        command: ({ port: agentPort }) => ["agentapi", "--port", String(agentPort), "--", "pi"],
        env: { ...env, PI_ACP_CLI: acpCli },
        modelOptions: ["default", "openrouter/google/gemini-3.6-flash"],
      },
    },
  } as unknown as WingmanConfig;
}

describe("ProcessManager Pi ACP creation boundary", () => {
  test("returns only after Pi initialization, session creation, and model validation", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "wingman-manager-pi-ready-"));
    const fakeCli = join(testDir, "pi-acp");
    const rpcLog = join(testDir, "rpc.jsonl");
    writeFileSync(fakeCli, FAKE_PI_ACP_SERVER);
    chmodSync(fakeCli, 0o755);
    const manager = new ProcessManager(piConfig(fakeCli, { TEST_ACP_LOG: rpcLog }, 47982));
    let sessionId: string | null = null;

    try {
      const snapshot = await manager.createSession(
        "pi",
        testDir,
        "Pi ready",
        null,
        undefined,
        undefined,
        { agentTransport: "pi-acp" },
        "openrouter/google/gemini-3.6-flash",
      );
      sessionId = snapshot.id;

      expect(snapshot.status).toBe("running");
      expect(snapshot.metadata?.nativeAgentSession?.sessionId).toBe("pi-manager-session");
      expect(readRpcLog(rpcLog).map((entry) => entry.method)).toEqual([
        "initialize",
        "session/new",
        "session/set_config_option",
      ]);
      expect(snapshot.logs.some((entry) => entry.includes("Pi ACP initialization and session negotiation completed")))
        .toBe(true);
    } finally {
      if (sessionId) await manager.getAdapter(sessionId)?.dispose();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("rejects creation and keeps an honest error session when the model is unavailable", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "wingman-manager-pi-failure-"));
    const fakeCli = join(testDir, "pi-acp");
    const rpcLog = join(testDir, "rpc.jsonl");
    writeFileSync(fakeCli, FAKE_PI_ACP_SERVER);
    chmodSync(fakeCli, 0o755);
    const manager = new ProcessManager(piConfig(fakeCli, {
      TEST_ACP_LOG: rpcLog,
      TEST_ACP_NO_OPENROUTER: "1",
    }, 47983));

    try {
      await expect(manager.createSession(
        "pi",
        testDir,
        "Pi failure",
        null,
        undefined,
        undefined,
        { agentTransport: "pi-acp" },
        "openrouter/google/gemini-3.6-flash",
      )).rejects.toThrow('provider "openrouter" is not authenticated or exposes no models');

      const failed = manager.listSessions();
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe("error");
      expect(failed[0]?.metadata?.nativeAgentSession).toBeUndefined();
      expect(failed[0]?.logs.some((entry) => entry.includes("not authenticated"))).toBe(true);
      expect(readRpcLog(rpcLog).map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
    } finally {
      const failedSession = manager.listSessions()[0];
      if (failedSession) await manager.getAdapter(failedSession.id)?.dispose();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

const FAKE_PI_ACP_SERVER = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.TEST_ACP_LOG;
const selected = "openrouter/google/gemini-3.6-flash";
const values = process.env.TEST_ACP_NO_OPENROUTER ? ["openai-codex/gpt-5.4"] : [selected];
const configOptions = (currentValue = values[0]) => [{
  id: "model",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
}];
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\\n");
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    } });
    return;
  }
  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: {
      sessionId: "pi-manager-session",
      configOptions: configOptions(),
    } });
    return;
  }
  if (method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id, result: { configOptions: configOptions(params.value) } });
  }
});
`;
