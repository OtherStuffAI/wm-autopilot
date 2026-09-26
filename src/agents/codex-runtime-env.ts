export const CODEX_PROVIDER_AUTH_ENV_KEYS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API",
  "PIPELINE_CLASSIFIER_OPENROUTER_API_KEY",
] as const;

/** Keep server credentials out of Codex; billing supplies session-scoped auth. */
export function buildCodexRuntimeEnv(
  parentEnv: Record<string, string | undefined>,
  sessionEnv: Record<string, string> = {},
): Record<string, string> {
  const env = buildInheritedAgentEnvironment(parentEnv);
  for (const key of CODEX_PROVIDER_AUTH_ENV_KEYS) delete env[key];
  return { ...env, ...sanitizeInjectedAgentEnvironment(sessionEnv) };
}
import { buildInheritedAgentEnvironment, sanitizeInjectedAgentEnvironment } from "./agent-environment";
