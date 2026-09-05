const GIT_CONFIG_COUNT_KEY = "GIT_CONFIG_COUNT";
const GIT_CONFIG_KEY_PREFIX = "GIT_CONFIG_KEY_";
const GIT_CONFIG_VALUE_PREFIX = "GIT_CONFIG_VALUE_";
const WINGMAN_HELPER_VALUE = "wingman";

interface GitConfigEntry {
  key: string;
  value: string;
}

function normalizeGatewayOrigin(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Native Forgejo configuration contains an invalid origin.");
  }
  return origin.origin;
}

function readEntries(env: Record<string, string>): GitConfigEntry[] {
  const count = Number.parseInt(env[GIT_CONFIG_COUNT_KEY] ?? "0", 10);
  if (!Number.isSafeInteger(count) || count < 0) return [];
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = env[`${GIT_CONFIG_KEY_PREFIX}${index}`];
    const value = env[`${GIT_CONFIG_VALUE_PREFIX}${index}`];
    if (key && value !== undefined) entries.push({ key, value });
  }
  return entries;
}

function withoutGeneratedConfigKeys(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => (
    key !== GIT_CONFIG_COUNT_KEY
    && !key.startsWith(GIT_CONFIG_KEY_PREFIX)
    && !key.startsWith(GIT_CONFIG_VALUE_PREFIX)
  )));
}

function withoutWingmanCredentialEntries(entries: GitConfigEntry[]): GitConfigEntry[] {
  const wingmanPrefixes = new Set(entries
    .filter((entry) => entry.key.startsWith("credential.https://") && entry.key.endsWith(".helper") && entry.value === WINGMAN_HELPER_VALUE)
    .map((entry) => entry.key.slice(0, -".helper".length)));
  return entries.filter((entry) => ![...wingmanPrefixes].some((prefix) => (
    entry.key === `${prefix}.helper` || entry.key === `${prefix}.useHttpPath`
  )));
}

export function replaceWingmanGitCredentialConfig(
  env: Record<string, string>,
  advertisedGatewayOrigins: string[],
): Record<string, string> {
  const gatewayOrigins = [...new Set(advertisedGatewayOrigins.map(normalizeGatewayOrigin))].sort();
  const entries = withoutWingmanCredentialEntries(readEntries(env));
  for (const origin of gatewayOrigins) {
    entries.push(
      { key: `credential.${origin}.helper`, value: WINGMAN_HELPER_VALUE },
      { key: `credential.${origin}.useHttpPath`, value: "true" },
    );
  }

  const result = withoutGeneratedConfigKeys(env);
  if (entries.length === 0) return result;
  result[GIT_CONFIG_COUNT_KEY] = String(entries.length);
  entries.forEach((entry, index) => {
    result[`${GIT_CONFIG_KEY_PREFIX}${index}`] = entry.key;
    result[`${GIT_CONFIG_VALUE_PREFIX}${index}`] = entry.value;
  });
  return result;
}
