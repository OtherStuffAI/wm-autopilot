/**
 * Gitea API Client
 *
 * Lightweight client for creating and managing git repositories
 * on a Gitea instance. Used by ngit_init to automatically provision
 * a remote git server for new projects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GiteaConfig {
  /** Base URL of the Gitea instance (no trailing slash). */
  url: string;
  /** API token for authentication. */
  apiToken: string;
  /** Username or org that owns created repos. */
  owner: string;
}

export interface CreateRepoInput {
  /** Repository name (kebab-case recommended). */
  name: string;
  /** Optional description. */
  description?: string;
  /** Whether the repo should be private. Defaults to false. */
  isPrivate?: boolean;
}

export interface GiteaRepo {
  /** Gitea internal ID. */
  id: number;
  /** Repository name. */
  name: string;
  /** Full name: owner/name. */
  fullName: string;
  /** HTTPS clone URL. */
  cloneUrl: string;
  /** SSH clone URL. */
  sshUrl: string;
  /** Web browsing URL. */
  htmlUrl: string;
  /** Description. */
  description: string;
  /** Whether the repo is private. */
  isPrivate: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Check whether Gitea is fully configured.
 */
export function isGiteaConfigured(config: Partial<GiteaConfig>): config is GiteaConfig {
  return Boolean(config.url && config.apiToken && config.owner);
}

/**
 * Create a new repository on Gitea.
 *
 * Uses POST /api/v1/user/repos to create a repo owned by the
 * authenticated user (the token owner).
 */
export async function createRepo(
  config: GiteaConfig,
  input: CreateRepoInput,
): Promise<GiteaRepo> {
  const response = await fetch(`${config.url}/api/v1/user/repos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `token ${config.apiToken}`,
    },
    body: JSON.stringify({
      name: input.name,
      description: input.description ?? "",
      private: input.isPrivate ?? false,
      auto_init: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gitea API error (${response.status}): ${errorText}`);
  }

  const data = parseObjectResponse(await response.json());
  return mapRepoResponse(data);
}

/**
 * Check if a repository exists on Gitea.
 */
export async function repoExists(
  config: GiteaConfig,
  repoName: string,
): Promise<GiteaRepo | null> {
  const response = await fetch(
    `${config.url}/api/v1/repos/${config.owner}/${repoName}`,
    {
      headers: { "Authorization": `token ${config.apiToken}` },
    },
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gitea API error (${response.status}): ${errorText}`);
  }

  const data = parseObjectResponse(await response.json());
  return mapRepoResponse(data);
}

/**
 * Get or create a repository — idempotent.
 * Returns the repo if it exists, creates it otherwise.
 */
export async function getOrCreateRepo(
  config: GiteaConfig,
  input: CreateRepoInput,
): Promise<{ repo: GiteaRepo; created: boolean }> {
  const existing = await repoExists(config, input.name);
  if (existing) {
    return { repo: existing, created: false };
  }

  const repo = await createRepo(config, input);
  return { repo, created: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseObjectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gitea API returned an invalid repository response");
  }
  return value as Record<string, unknown>;
}

function mapRepoResponse(data: Record<string, unknown>): GiteaRepo {
  return {
    id: data.id as number,
    name: data.name as string,
    fullName: data.full_name as string,
    cloneUrl: data.clone_url as string,
    sshUrl: data.ssh_url as string,
    htmlUrl: data.html_url as string,
    description: (data.description as string) ?? "",
    isPrivate: data.private as boolean,
  };
}
