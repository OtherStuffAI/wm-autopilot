import { describe, expect, test } from "bun:test";
import { stat, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { injectMcpConfig } from "./mcp-injector";
import type { WingmanConfig } from "../config";

describe("injectMcpConfig codex structured config", () => {
  test("writes Claude strict config privately without capability or project mutation", async () => {
    const capability = `wmcap_v1.${crypto.randomUUID()}`;
    const result = await injectMcpConfig({
      sessionId: `claude-${crypto.randomUUID()}`,
      agent: "claude",
      workingDirectory: "/tmp/project-must-not-be-written",
      config: { port: 3600, baseUrl: "http://localhost:3600" } as WingmanConfig,
      capabilityToken: capability,
    });
    const path = result.cleanupFiles[0]!;
    expect(result.commandArgs).toEqual(["--mcp-config", path, "--strict-mcp-config"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(new URL(".", `file://${path}`).pathname)).mode & 0o777).toBe(0o700);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(capability);
    expect(raw).not.toContain("WINGMAN_CAPABILITY");
    expect(result.env.WINGMAN_CAPABILITY).toBe(capability);
    const { cleanupMcpConfig } = await import("./mcp-injector");
    await cleanupMcpConfig(result.cleanupFiles);
    await expect(stat(path)).rejects.toThrow();
    await expect(stat(dirname(path))).rejects.toThrow();
  });
  test("emits a structured codexConfig mirroring the wingman MCP CLI overrides", async () => {
    const result = await injectMcpConfig({
      sessionId: "session-xyz",
      agent: "codex",
      workingDirectory: "/tmp/project",
      config: { port: 3600, baseUrl: "https://agent.example.invalid/" } as WingmanConfig,
      botNpub: "npub1bot",
    });

    const mcp = result.codexConfig?.mcp_servers as Record<string, any> | undefined;
    const wingman = mcp?.wingman;

    expect(wingman?.command).toBe("bun");
    expect(Array.isArray(wingman?.args)).toBe(true);
    expect(wingman?.args[0]).toBe("run");
    expect(wingman?.env?.SESSION_ID).toBe("session-xyz");
    expect(wingman?.env?.WINGMAN_URL).toBe("https://agent.example.invalid");
    expect(wingman?.env?.WINGMAN_BROKER_URL).toBe("http://127.0.0.1:3600");
    expect(wingman?.env_vars).toEqual(["WINGMAN_CAPABILITY"]);
    expect(result.env?.SESSION_ID).toBe("session-xyz");

    // The structured config must carry the same MCP server path the CLI args use.
    const argsPath = (() => {
      const idx = (result.commandArgs ?? []).findIndex((a) => a.startsWith("mcp_servers.wingman.args="));
      if (idx === -1) return null;
      const raw = result.commandArgs![idx]!.split("=").slice(1).join("=");
      return JSON.parse(raw)[1];
    })();
    expect(wingman?.args[1]).toBe(argsPath);
  });

  test("passes the opaque capability to a real MCP-like child only through inherited environment", async () => {
    const capability = `wmcap_v1.${crypto.randomUUID()}`;
    const result = await injectMcpConfig({
      sessionId: "session-subprocess",
      agent: "codex",
      workingDirectory: "/tmp/project",
      config: { port: 3600, baseUrl: "http://localhost:3600" } as WingmanConfig,
      capabilityToken: capability,
    });
    const config = JSON.stringify(result.codexConfig);
    const args = JSON.stringify(result.commandArgs);
    expect(config).not.toContain(capability);
    expect(args).not.toContain(capability);
    expect(config).toContain("WINGMAN_CAPABILITY");

    const child = Bun.spawn(["bun", "-e", "process.stdout.write(process.env.WINGMAN_CAPABILITY ?? '')"], {
      env: { PATH: process.env.PATH ?? "", ...result.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toBe(capability);
  });

  test("binds native agent commands to the capability session", async () => {
    const result = await injectMcpConfig({
      sessionId: "current-native-session",
      agent: "codex",
      workingDirectory: "/tmp/project",
      config: { port: 3600, baseUrl: "https://agent.example.invalid" } as WingmanConfig,
      capabilityToken: "opaque-capability",
    });

    expect(result.env).toMatchObject({
      SESSION_ID: "current-native-session",
      WINGMAN_CAPABILITY: "opaque-capability",
      WINGMAN_URL: "https://agent.example.invalid",
      WINGMAN_BROKER_URL: "http://127.0.0.1:3600",
    });
  });
});
