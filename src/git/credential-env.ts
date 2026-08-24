import type { GiteaConfig } from "../gitea/gitea-client";
import { ensureCredentialHelper, getGiteaGitEnv } from "../gitea/credential-helper";
import { getGitHubGitEnvForUser } from "./github-credential-helper";

type GitEnv = Record<string, string> | null | undefined;

const GIT_CONFIG_COUNT_KEY = "GIT_CONFIG_COUNT";
const GIT_CONFIG_KEY_PREFIX = "GIT_CONFIG_KEY_";
const GIT_CONFIG_VALUE_PREFIX = "GIT_CONFIG_VALUE_";

function extractGitConfigEntries(env: Record<string, string>): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  const count = Number.parseInt(env[GIT_CONFIG_COUNT_KEY] ?? "0", 10);
  if (!Number.isFinite(count) || count <= 0) {
    return entries;
  }

  for (let index = 0; index < count; index += 1) {
    const key = env[`${GIT_CONFIG_KEY_PREFIX}${index}`];
    const value = env[`${GIT_CONFIG_VALUE_PREFIX}${index}`];
    if (key && value) {
      entries.push({ key, value });
    }
  }

  return entries;
}

export function mergeGitCredentialEnvs(...envs: GitEnv[]): Record<string, string> {
  const merged: Record<string, string> = {};
  const configEntries: Array<{ key: string; value: string }> = [];

  for (const env of envs) {
    if (!env) continue;

    for (const [key, value] of Object.entries(env)) {
      if (
        key === GIT_CONFIG_COUNT_KEY ||
        key.startsWith(GIT_CONFIG_KEY_PREFIX) ||
        key.startsWith(GIT_CONFIG_VALUE_PREFIX)
      ) {
        continue;
      }
      merged[key] = value;
    }

    configEntries.push(...extractGitConfigEntries(env));
  }

  if (configEntries.length > 0) {
    merged[GIT_CONFIG_COUNT_KEY] = String(configEntries.length);
    configEntries.forEach((entry, index) => {
      merged[`${GIT_CONFIG_KEY_PREFIX}${index}`] = entry.key;
      merged[`${GIT_CONFIG_VALUE_PREFIX}${index}`] = entry.value;
    });
  }

  return merged;
}

export function buildSessionGitCredentialEnv(options: {
  npub: string | null | undefined;
  dataDir: string;
  giteaConfig?: GiteaConfig | null;
}): Record<string, string> {
  const githubEnv = getGitHubGitEnvForUser(options.npub, options.dataDir);
  const helperPath = options.giteaConfig ? ensureCredentialHelper(options.dataDir) : null;
  const giteaEnv =
    options.giteaConfig && helperPath
      ? getGiteaGitEnv(options.giteaConfig, helperPath)
      : null;
  return mergeGitCredentialEnvs(githubEnv, giteaEnv);
}
