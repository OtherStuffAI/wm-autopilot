export interface GitRemoteDescriptor {
  remote: string;
  url: string;
  host: string | null;
  usesSsh: boolean;
  isGithub: boolean;
  isGitea: boolean;
}

function extractHostFromSshRemote(url: string): string | null {
  const scpLikeMatch = url.match(/^[^@]+@([^:]+):.+$/);
  if (scpLikeMatch?.[1]) {
    return scpLikeMatch[1].toLowerCase();
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function extractHostFromRemoteUrl(url: string): { host: string | null; usesSsh: boolean } {
  if (/^(ssh|git\+ssh):\/\//i.test(url) || /^[^@]+@[^:]+:.+$/.test(url)) {
    return { host: extractHostFromSshRemote(url), usesSsh: true };
  }

  try {
    const parsed = new URL(url);
    return { host: parsed.hostname.toLowerCase(), usesSsh: parsed.protocol === "ssh:" };
  } catch {
    return { host: null, usesSsh: false };
  }
}

function normaliseConfiguredHost(giteaUrl: string | null | undefined): string | null {
  if (!giteaUrl) return null;
  try {
    return new URL(giteaUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function describeGitRemote(
  remote: string,
  url: string,
  options: { giteaUrl?: string | null } = {},
): GitRemoteDescriptor {
  const trimmedUrl = url.trim();
  const { host, usesSsh } = extractHostFromRemoteUrl(trimmedUrl);
  const configuredGiteaHost = normaliseConfiguredHost(options.giteaUrl);

  return {
    remote,
    url: trimmedUrl,
    host,
    usesSsh,
    isGithub: host === "github.com",
    isGitea: !!host && !!configuredGiteaHost && host === configuredGiteaHost,
  };
}

export function buildGitHostMismatchMessage(
  remote: string,
  expectedHost: string,
  actualHost: string | null,
): string {
  const actual = actualHost ?? "unknown host";
  return `Remote '${remote}' points to ${actual}. This action requires ${expectedHost}.`;
}

export function buildGitHubHttpsRequiredMessage(remote: string, url: string): string {
  return [
    `Remote '${remote}' uses SSH: ${url}`,
    "GitHub token authentication only works with HTTPS remotes.",
    "Update the remote to use https://github.com/<owner>/<repo>.git and retry.",
  ].join(" ");
}
