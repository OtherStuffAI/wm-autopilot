import { describe, expect, test } from "bun:test";

import {
  buildClaudeWingmanServer,
  buildGooseWingmanExtension,
  buildOpenCodeWingmanMcp,
  removeClaudeWingmanServer,
  removeGooseWingmanExtension,
  removeOpenCodeWingmanMcp,
  upsertClaudeWingmanServer,
  upsertGooseWingmanExtension,
  upsertOpenCodeWingmanMcp,
} from "./mcp-config-helpers";

describe("mcp-config-helpers", () => {
  test("upsertClaudeWingmanServer merges without removing existing servers", () => {
    const server = buildClaudeWingmanServer("/tmp/stdio-server.ts", "http://localhost:3600", "session-1");
    const config = upsertClaudeWingmanServer(
      {
        mcpServers: {
          github: { type: "stdio", command: "npx", args: ["-y", "github-mcp"] },
        },
      },
      server,
    );

    const mcpServers = config.mcpServers as Record<string, unknown>;
    expect(mcpServers.github).toBeDefined();
    expect(mcpServers.wingman).toEqual(server);
  });

  test("removeClaudeWingmanServer marks file deletable when wingman is only key", () => {
    const result = removeClaudeWingmanServer({
      mcpServers: {
        wingman: { command: "bun" },
      },
    });

    expect(result.changed).toBe(true);
    expect(result.shouldDeleteFile).toBe(true);
  });

  test("removeClaudeWingmanServer preserves non-wingman entries", () => {
    const result = removeClaudeWingmanServer({
      mcpServers: {
        wingman: { command: "bun" },
        github: { command: "npx" },
      },
      other: true,
    });

    expect(result.changed).toBe(true);
    expect(result.shouldDeleteFile).toBe(false);
    const mcpServers = result.config.mcpServers as Record<string, unknown>;
    expect(mcpServers.wingman).toBeUndefined();
    expect(mcpServers.github).toBeDefined();
  });

  test("upsertGooseWingmanExtension preserves existing extensions", () => {
    const extension = buildGooseWingmanExtension("/tmp/stdio-server.ts", "http://localhost:3600", "session-1");
    const config = upsertGooseWingmanExtension(
      {
        extensions: {
          existing: { cmd: "node", enabled: true },
        },
      },
      extension,
    );

    const extensions = config.extensions as Record<string, unknown>;
    expect(extensions.existing).toBeDefined();
    expect(extensions.wingman).toEqual(extension);
  });

  test("removeGooseWingmanExtension removes only wingman", () => {
    const result = removeGooseWingmanExtension({
      extensions: {
        wingman: { cmd: "bun" },
        keep: { cmd: "node" },
      },
    });

    expect(result.changed).toBe(true);
    const extensions = result.config.extensions as Record<string, unknown>;
    expect(extensions.wingman).toBeUndefined();
    expect(extensions.keep).toBeDefined();
  });

  test("upsertOpenCodeWingmanMcp preserves existing mcp entries", () => {
    const wingman = buildOpenCodeWingmanMcp("/tmp/stdio-server.ts", "http://localhost:3600", "session-1");
    const config = upsertOpenCodeWingmanMcp(
      {
        mcp: {
          github: { type: "remote", url: "https://example.com/mcp" },
        },
      },
      wingman,
    );

    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp.github).toBeDefined();
    expect(mcp.wingman).toEqual(wingman);
  });

  test("removeOpenCodeWingmanMcp removes only wingman", () => {
    const result = removeOpenCodeWingmanMcp({
      mcp: {
        wingman: { type: "local" },
        github: { type: "remote" },
      },
    });

    expect(result.changed).toBe(true);
    const mcp = result.config.mcp as Record<string, unknown>;
    expect(mcp.wingman).toBeUndefined();
    expect(mcp.github).toBeDefined();
  });
});
