import type { AgentType } from "./agent-types";

type ConfigEnvironment = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

const AGENT_CLI_UPDATE_DISABLE_ENV: Partial<Record<AgentType, Record<string, string>>> = {
  claude: {
    DISABLE_AUTOUPDATER: "1",
  },
  codex: {
    NO_UPDATE_NOTIFIER: "1",
    npm_config_update_notifier: "false",
  },
};

const AGENT_CLI_UPDATE_DISABLE_ARGS: Partial<Record<AgentType, string[]>> = {
  codex: ["-c", "check_for_update_on_startup=false"],
};

function readBooleanEnv(value: string | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? "");
}

export function isAgentCliAutoUpdateEnabled(env: ConfigEnvironment = Bun.env): boolean {
  return readBooleanEnv(env.AGENT_CLI_AUTOUPDATE);
}

export function buildAgentCliUpdateEnv(
  agent: AgentType,
  autoUpdateEnabled: boolean,
): Record<string, string> {
  if (autoUpdateEnabled) {
    return {};
  }
  return AGENT_CLI_UPDATE_DISABLE_ENV[agent] ?? {};
}

export function buildAgentCliUpdateArgs(
  agent: AgentType,
  autoUpdateEnabled: boolean,
): string[] {
  if (autoUpdateEnabled) {
    return [];
  }
  return AGENT_CLI_UPDATE_DISABLE_ARGS[agent] ?? [];
}
