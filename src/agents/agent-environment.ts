const INHERITED_AGENT_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "BUN_INSTALL",
  "CODEX_HOME",
  "SSH_AUTH_SOCK",
  "GPG_TTY",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export const FORBIDDEN_AGENT_ENV_KEYS = new Set([
  "AGENT_NSEC",
  "WINGMAN_PRIV",
  "WINGMAN_NSEC",
  "WINGMAN_SIGNING_SECRET",
  "WINGMAN_SIGNING_TOKEN",
  "KEYTELEPORT_PRIVKEY",
  "WINGMAN_BROKER_MASTER_KEY_FILE",
  "WINGMAN_BROKER_MASTER_KEY",
  "BROKER_MASTER_KEY",
  "WINGMAN_BROKER_VAULT_BACKEND",
  "NOSTR_SECRET_KEY",
  "NWC_CONNECTION_STRING",
  "NWC_SECRET",
  "WINGMAN_WALLET_DIR",
  "CASHU_SEED",
  "CASHU_TOKEN",
  "CASHU_MNEMONIC",
  "CASHU_API_KEY",
  "CASHU_AUTH_TOKEN",
]);

export const CLAUDE_OAUTH_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Give subscription-billed Claude sessions a long-lived OAuth token so they do
 * not depend on the macOS Keychain, which differs between GUI and SSH logins.
 * Credits sessions authenticate through the billing proxy and must never
 * carry the subscription token.
 */
export function applyClaudeSubscriptionAuth(
  env: Record<string, string> | undefined,
  options: { agent: string; billingMode: "credits" | "subscription"; oauthToken: string | null },
): Record<string, string> {
  const next = { ...env };
  delete next[CLAUDE_OAUTH_TOKEN_ENV_KEY];
  const token = options.oauthToken?.trim();
  if (options.agent === "claude" && options.billingMode === "subscription" && token) {
    next[CLAUDE_OAUTH_TOKEN_ENV_KEY] = token;
  }
  return next;
}

export function buildInheritedAgentEnvironment(
  parentEnv: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of INHERITED_AGENT_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}

export function sanitizeInjectedAgentEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (FORBIDDEN_AGENT_ENV_KEYS.has(key) || /^(?:CASHU|COCO|WINGMAN_WALLET)_/.test(key) || typeof value !== "string") continue;
    result[key] = value;
  }
  return result;
}
