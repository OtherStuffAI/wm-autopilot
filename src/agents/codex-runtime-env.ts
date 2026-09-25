const PROVIDER_AUTH_ENV_KEYS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

/** Keep server credentials out of Codex; billing supplies session-scoped auth. */
export function buildCodexRuntimeEnv(
  parentEnv: Record<string, string | undefined>,
  sessionEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of PROVIDER_AUTH_ENV_KEYS) delete env[key];
  return { ...env, ...sessionEnv };
}
