/**
 * Gitea User Manager
 *
 * Provisions per-user Gitea accounts via the admin API using the
 * shared configured service administrator token. Each user gets their own repos, identity,
 * and API token stored in userSettingsStore.
 *
 * Username is derived from the deterministic 3-word identity alias
 * (e.g. "clever-coral-haven") so the same npub always maps to the
 * same Gitea username.
 */

import { randomBytes } from "node:crypto";

import type { WingmanConfig } from "../config";
import { userSettingsStore } from "../storage/user-settings-store";
import type { GiteaConfig } from "./gitea-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProvisionResult {
  username: string;
  apiToken: string;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Admin API helpers
// ---------------------------------------------------------------------------

async function adminGet(
  baseUrl: string,
  path: string,
  adminToken: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1${path}`, {
    headers: { Authorization: `token ${adminToken}` },
  });
}

async function adminPost(
  baseUrl: string,
  path: string,
  adminToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${adminToken}`,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Check whether a Gitea user exists.
 */
async function giteaUserExists(
  baseUrl: string,
  adminToken: string,
  username: string,
): Promise<boolean> {
  const resp = await adminGet(baseUrl, `/users/${username}`, adminToken);
  return resp.status === 200;
}

/**
 * Create a Gitea user via the admin API.
 * Returns true if created, false if username was already taken (422).
 * Throws on unexpected errors.
 */
async function createGiteaUser(
  baseUrl: string,
  adminToken: string,
  username: string,
  password: string,
): Promise<boolean> {
  const resp = await adminPost(baseUrl, "/admin/users", adminToken, {
    username,
    email: `${username}@wingman-os.ai`,
    password,
    must_change_password: false,
    visibility: "public",
  });

  if (resp.ok) return true;
  if (resp.status === 422) return false; // username taken
  const text = await resp.text();
  throw new Error(`Gitea create user failed (${resp.status}): ${text}`);
}

/**
 * Reset a Gitea user's password via the admin API.
 * Used when the user exists but we don't have credentials for them.
 */
async function resetGiteaUserPassword(
  baseUrl: string,
  adminToken: string,
  username: string,
  newPassword: string,
): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/v1/admin/users/${username}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${adminToken}`,
    },
    body: JSON.stringify({
      password: newPassword,
      must_change_password: false,
      source_id: 0,
      login_name: username,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gitea password reset failed (${resp.status}): ${text}`);
  }
}

/**
 * Create an API token for a Gitea user.
 *
 * Uses the user's own basic auth credentials (username:password) since
 * Gitea blocks token creation for other users via token auth.
 * See: https://github.com/go-gitea/gitea/issues/21186
 */
async function createGiteaToken(
  baseUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");

  const resp = await fetch(`${baseUrl}/api/v1/users/${username}/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify({ name: "wingman", scopes: ["all"] }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gitea create token failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { sha1?: string; token?: string };
  const token = data.sha1 || data.token;
  if (!token) {
    throw new Error("Gitea token response missing sha1/token field");
  }
  return token;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a Gitea user account exists for the given npub.
 *
 * 1. Check userSettingsStore for existing token → return early if set
 * 2. Check if user exists on Gitea → create if not
 * 3. Create API token for the user
 * 4. Store username + token in userSettingsStore
 *
 * The `alias` parameter is the deterministic 3-word identity alias
 * from `generateIdentityAlias()`.
 */
export async function ensureGiteaUser(
  config: WingmanConfig,
  npub: string,
  alias: string,
): Promise<ProvisionResult | null> {
  const baseUrl = config.giteaUrl;
  const adminToken = config.giteaApiToken;
  if (!baseUrl || !adminToken) return null;

  // Already provisioned?
  const existingToken = userSettingsStore.get(npub, "gitea_api_token");
  const existingUsername = userSettingsStore.get(npub, "gitea_username");
  if (existingToken && existingUsername) {
    return { username: existingUsername, apiToken: existingToken, created: false };
  }

  // Try the primary alias as username
  let username = alias;
  const password = randomBytes(32).toString("hex");
  let userCreated = false;

  const exists = await giteaUserExists(baseUrl, adminToken, username);
  if (!exists) {
    const created = await createGiteaUser(baseUrl, adminToken, username, password);
    if (!created) {
      // Username collision — append 4-char hex suffix from npub hash
      const suffix = npub.slice(-8, -4);
      username = `${alias}-${suffix}`;
      const retryCreated = await createGiteaUser(baseUrl, adminToken, username, password);
      if (!retryCreated) {
        // Check if the suffixed user also exists (maybe from a previous attempt)
        const suffixedExists = await giteaUserExists(baseUrl, adminToken, username);
        if (!suffixedExists) {
          throw new Error(`Failed to create Gitea user: ${username} (both alias and suffix taken)`);
        }
        // Exists from a previous attempt — reset their password so we can auth
        await resetGiteaUserPassword(baseUrl, adminToken, username, password);
      } else {
        userCreated = true;
      }
    } else {
      userCreated = true;
    }
  } else {
    // User already exists — reset password so we can create a token
    await resetGiteaUserPassword(baseUrl, adminToken, username, password);
  }

  // Create API token using the user's basic auth credentials
  // (Gitea blocks token creation for other users via token auth)
  const apiToken = await createGiteaToken(baseUrl, username, password);

  // Persist
  userSettingsStore.set(npub, "gitea_username", username);
  userSettingsStore.set(npub, "gitea_api_token", apiToken);

  console.log(`[gitea] User provisioned: ${username} for ${npub.slice(0, 16)}...${userCreated ? " (new account)" : " (existing account)"}`);

  return { username, apiToken, created: userCreated };
}

/**
 * Resolve Gitea credentials for a given npub.
 *
 * Returns per-user credentials if available, otherwise falls back
 * to the configured service administrator credentials from config.
 */
export function resolveGiteaCredentials(
  npub: string | undefined,
  config: WingmanConfig,
): GiteaConfig | null {
  const baseUrl = config.giteaUrl;
  if (!baseUrl) return null;

  // Try per-user credentials first
  if (npub) {
    const userToken = userSettingsStore.get(npub, "gitea_api_token");
    const username = userSettingsStore.get(npub, "gitea_username");
    if (userToken && username) {
      return { url: baseUrl, apiToken: userToken, owner: username };
    }
  }

  // Fall back to configured service administrator
  if (config.giteaApiToken && config.giteaOwner) {
    return { url: baseUrl, apiToken: config.giteaApiToken, owner: config.giteaOwner };
  }

  return null;
}
