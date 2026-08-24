/**
 * GitHub Credential Helper
 *
 * Builds per-user git credential environment for github.com HTTPS remotes.
 * Credentials are read from user settings and scoped to this host only.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { userSettingsStore } from "../storage/user-settings-store";

const HELPER_FILENAME = "github-credential-helper.sh";

const HELPER_SCRIPT = `#!/bin/sh
# Wingman GitHub credential helper — reads from env vars
case "$1" in
  get)
    echo "username=\${WINGMAN_GITHUB_USERNAME}"
    echo "password=\${WINGMAN_GITHUB_TOKEN}"
    ;;
esac
`;

let helperVerifiedPath: string | null = null;

function ensureGitHubCredentialHelper(dataDir: string): string | null {
  if (helperVerifiedPath) return helperVerifiedPath;

  const helperPath = join(dataDir, HELPER_FILENAME);

  try {
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(helperPath)) {
      writeFileSync(helperPath, HELPER_SCRIPT, { mode: 0o755 });
    } else {
      chmodSync(helperPath, 0o755);
    }
    helperVerifiedPath = helperPath;
    return helperPath;
  } catch (error) {
    console.error(`[github-cred] Failed to prepare credential helper: ${(error as Error).message}`);
    return null;
  }
}

export type GitHubUserCredentials = {
  username: string;
  token: string;
  authorName: string | null;
  authorEmail: string | null;
};

function normalizeSetting(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getGitHubUserCredentials(
  npub: string,
): GitHubUserCredentials | null {
  const token =
    normalizeSetting(userSettingsStore.get(npub, "github_api_key")) ||
    normalizeSetting(userSettingsStore.get(npub, "github_token")) ||
    "";
  if (!token) return null;

  const username =
    normalizeSetting(userSettingsStore.get(npub, "github_username")) ||
    normalizeSetting(userSettingsStore.get(npub, "github_user")) ||
    "x-access-token";

  const authorEmail =
    normalizeSetting(userSettingsStore.get(npub, "github_git_email")) ||
    normalizeSetting(userSettingsStore.get(npub, "github_email")) ||
    null;
  const authorName =
    normalizeSetting(userSettingsStore.get(npub, "github_git_name")) ||
    normalizeSetting(userSettingsStore.get(npub, "github_name")) ||
    (username !== "x-access-token" ? username : null);

  return { username, token, authorName, authorEmail };
}

export function buildGitHubGitEnv(
  creds: GitHubUserCredentials,
  helperPath: string,
): Record<string, string> {
  const env: Record<string, string> = {
    WINGMAN_GITHUB_USERNAME: creds.username,
    WINGMAN_GITHUB_TOKEN: creds.token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: helperPath,
  };

  if (creds.authorEmail) {
    const authorName = creds.authorName || creds.authorEmail.split("@")[0] || "GitHub User";
    Object.assign(env, {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: creds.authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: creds.authorEmail,
    });
  }

  return env;
}

export function getGitHubGitEnvForUser(
  npub: string | null | undefined,
  dataDir: string,
): Record<string, string> | null {
  const normalizedNpub = typeof npub === "string" ? npub.trim() : "";
  if (!normalizedNpub) return null;

  const creds = getGitHubUserCredentials(normalizedNpub);
  if (!creds) return null;

  const helperPath = ensureGitHubCredentialHelper(dataDir);
  if (!helperPath) return null;

  return buildGitHubGitEnv(creds, helperPath);
}
