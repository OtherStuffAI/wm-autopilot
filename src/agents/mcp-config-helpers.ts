export type JsonObject = Record<string, unknown>;

export function buildClaudeWingmanServer(
  mcpServerPath: string,
  wingmanUrl: string,
  sessionId: string,
  identityEnv?: Record<string, string>,
): JsonObject {
  return {
    type: "stdio",
    command: "bun",
    args: ["run", mcpServerPath],
    env: {
      WINGMAN_URL: wingmanUrl,
      SESSION_ID: sessionId,
      ...identityEnv,
    },
  };
}

export function upsertClaudeWingmanServer(
  existingConfig: JsonObject,
  wingmanServer: JsonObject,
): JsonObject {
  const mcpServers = (existingConfig.mcpServers as JsonObject | undefined) ?? {};
  return {
    ...existingConfig,
    mcpServers: {
      ...mcpServers,
      wingman: wingmanServer,
    },
  };
}

export function removeClaudeWingmanServer(existingConfig: JsonObject): {
  config: JsonObject;
  changed: boolean;
  shouldDeleteFile: boolean;
} {
  const mcpServers = (existingConfig.mcpServers as JsonObject | undefined) ?? null;
  if (!mcpServers || !("wingman" in mcpServers)) {
    return { config: existingConfig, changed: false, shouldDeleteFile: false };
  }

  const nextServers = { ...mcpServers };
  delete nextServers.wingman;
  const nextConfig = { ...existingConfig, mcpServers: nextServers };
  const shouldDeleteFile = Object.keys(nextServers).length === 0 && Object.keys(nextConfig).length <= 1;

  return {
    config: nextConfig,
    changed: true,
    shouldDeleteFile,
  };
}

export function buildGooseWingmanExtension(
  mcpServerPath: string,
  wingmanUrl: string,
  sessionId: string,
  identityEnv?: Record<string, string>,
): JsonObject {
  return {
    args: ["run", mcpServerPath],
    available_tools: [],
    bundled: null,
    cmd: "bun",
    description: "Wingman MCP server providing AI agent tools",
    enabled: true,
    env_keys: ["WINGMAN_CAPABILITY"],
    envs: {
      WINGMAN_URL: wingmanUrl,
      SESSION_ID: sessionId,
      ...identityEnv,
    },
    name: "wingman",
    timeout: 300,
    type: "stdio",
  };
}

export function upsertGooseWingmanExtension(
  existingConfig: JsonObject,
  wingmanExtension: JsonObject,
): JsonObject {
  const extensions = (existingConfig.extensions as JsonObject | undefined) ?? {};
  return {
    ...existingConfig,
    extensions: {
      ...extensions,
      wingman: wingmanExtension,
    },
  };
}

export function removeGooseWingmanExtension(existingConfig: JsonObject): {
  config: JsonObject;
  changed: boolean;
} {
  const extensions = (existingConfig.extensions as JsonObject | undefined) ?? null;
  if (!extensions || !("wingman" in extensions)) {
    return { config: existingConfig, changed: false };
  }

  const nextExtensions = { ...extensions };
  delete nextExtensions.wingman;

  return {
    config: {
      ...existingConfig,
      extensions: nextExtensions,
    },
    changed: true,
  };
}

export function buildOpenCodeWingmanMcp(
  mcpServerPath: string,
  wingmanUrl: string,
  sessionId: string,
  identityEnv?: Record<string, string>,
): JsonObject {
  return {
    type: "local",
    command: ["bun", "run", mcpServerPath],
    enabled: true,
    environment: {
      WINGMAN_URL: wingmanUrl,
      SESSION_ID: sessionId,
      WINGMAN_CAPABILITY: "{env:WINGMAN_CAPABILITY}",
      ...identityEnv,
    },
  };
}

export function upsertOpenCodeWingmanMcp(
  existingConfig: JsonObject,
  wingmanMcp: JsonObject,
): JsonObject {
  const mcp = (existingConfig.mcp as JsonObject | undefined) ?? {};
  return {
    ...existingConfig,
    mcp: {
      ...mcp,
      wingman: wingmanMcp,
    },
  };
}

export function removeOpenCodeWingmanMcp(existingConfig: JsonObject): {
  config: JsonObject;
  changed: boolean;
} {
  const mcp = (existingConfig.mcp as JsonObject | undefined) ?? null;
  if (!mcp || !("wingman" in mcp)) {
    return { config: existingConfig, changed: false };
  }

  const nextMcp = { ...mcp };
  delete nextMcp.wingman;

  return {
    config: {
      ...existingConfig,
      mcp: nextMcp,
    },
    changed: true,
  };
}
