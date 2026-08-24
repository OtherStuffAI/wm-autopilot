/**
 * Git Credential Helper for Gitea
 *
 * Writes a small shell script that git invokes as a credential helper.
 * The script reads WINGMAN_GITEA_OWNER and WINGMAN_GITEA_TOKEN from
 * environment variables (injected by Wingman into agent processes).
 *
 * Git is configured to use this helper for the Gitea domain only via
 * GIT_CONFIG_* environment variables, so it won't affect pushes to
 * GitHub or other remotes.
 */

import { join } from "node:path";
import { existsSync, chmodSync, writeFileSync } from "node:fs";
import type { WingmanConfig } from "../config";
import { isGiteaConfigured, type GiteaConfig } from "./gitea-client";

// ---------------------------------------------------------------------------
// Credential helper script
// ---------------------------------------------------------------------------

const HELPER_FILENAME = "gitea-credential-helper.sh";

/**
 * The credential helper script.
 * Reads username and password from environment variables set by Wingman.
 * Only responds to "get" requests — git also sends "store" and "erase"
 * which we silently ignore.
 */
const HELPER_SCRIPT = `#!/bin/sh
# Wingman Gitea credential helper — reads from env vars
case "$1" in
  get)
    echo "username=\${WINGMAN_GITEA_OWNER}"
    echo "password=\${WINGMAN_GITEA_TOKEN}"
    ;;
esac
`;

// Cache: once the helper has been written and chmod'd, skip on subsequent calls.
let helperVerifiedPath: string | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the credential helper script exists in the data directory.
 * Returns the absolute path to the script, or null if it couldn't be written.
 * After the first successful write+chmod, subsequent calls return immediately.
 */
export function ensureCredentialHelper(dataDir: string): string | null {
  if (helperVerifiedPath) return helperVerifiedPath;

  const helperPath = join(dataDir, HELPER_FILENAME);

  try {
    if (!existsSync(helperPath)) {
      writeFileSync(helperPath, HELPER_SCRIPT, { mode: 0o755 });
      console.log(`[gitea-cred] Wrote credential helper: ${helperPath}`);
    } else {
      // Ensure it's still executable
      chmodSync(helperPath, 0o755);
    }
    helperVerifiedPath = helperPath;
    return helperPath;
  } catch (err) {
    console.error(`[gitea-cred] Failed to write credential helper: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build environment variables that configure git to use the Wingman
 * credential helper for the Gitea domain.
 *
 * Accepts either a WingmanConfig (legacy) or a resolved GiteaConfig
 * (per-user credentials). Returns an empty object if Gitea is not
 * configured.
 */
export function getGiteaGitEnv(
  config: WingmanConfig | GiteaConfig,
  helperPath: string,
): Record<string, string> {
  let giteaConfig: GiteaConfig | null;

  if ("port" in config) {
    // WingmanConfig — resolve to GiteaConfig
    const partial: Partial<GiteaConfig> = {
      url: config.giteaUrl ?? undefined,
      apiToken: config.giteaApiToken ?? undefined,
      owner: config.giteaOwner ?? undefined,
    };
    giteaConfig = isGiteaConfigured(partial) ? partial : null;
  } else {
    // Already a GiteaConfig
    giteaConfig = config;
  }

  if (!giteaConfig) return {};

  // GIT_CONFIG_COUNT + GIT_CONFIG_KEY_N + GIT_CONFIG_VALUE_N
  // tells git to treat these as config entries. We scope the
  // credential helper to the Gitea URL so it only fires for
  // that host, not for GitHub or other remotes.
  return {
    // Credentials available to the helper script
    WINGMAN_GITEA_OWNER: giteaConfig.owner,
    WINGMAN_GITEA_TOKEN: giteaConfig.apiToken,
    // Git config: use our helper for this specific host
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `credential.${giteaConfig.url}.helper`,
    GIT_CONFIG_VALUE_0: helperPath,
  };
}
