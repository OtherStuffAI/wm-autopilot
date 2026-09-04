export interface GitCredentialInput {
  protocol: string;
  host: string;
  path: string;
  fields: ReadonlyMap<string, string>;
}

export interface CanonicalGitCredentialRequest {
  protocol: "https";
  host: string;
  path: string;
  gatewayOrigin: string;
  organization: string;
  repository: string;
}

const CREDENTIAL_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\[\])?$/;
const FORGEJO_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function parseGitCredentialInput(input: string): GitCredentialInput {
  const fields = new Map<string, string>();
  for (const rawLine of input.split(/\r?\n/)) {
    if (rawLine.length === 0) break;
    const separator = rawLine.indexOf("=");
    if (separator <= 0) throw new Error("Malformed Git credential input.");
    const key = rawLine.slice(0, separator);
    const value = rawLine.slice(separator + 1);
    if (!CREDENTIAL_KEY_PATTERN.test(key) || fields.has(key)) {
      throw new Error("Malformed Git credential input.");
    }
    fields.set(key, value);
  }
  return {
    protocol: fields.get("protocol") ?? "",
    host: fields.get("host") ?? "",
    path: fields.get("path") ?? "",
    fields,
  };
}

export function canonicalizeGitCredentialRequest(
  input: Pick<GitCredentialInput, "protocol" | "host" | "path">,
): CanonicalGitCredentialRequest {
  if (input.protocol !== "https") {
    throw new Error("Tower-backed Git credentials require HTTPS.");
  }
  if (!input.host || /[\s/@?#\\]/.test(input.host)) {
    throw new Error("Git credential host is malformed.");
  }

  let origin: URL;
  try {
    origin = new URL(`https://${input.host}`);
  } catch {
    throw new Error("Git credential host is malformed.");
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Git credential host is malformed.");
  }

  const normalizedPath = input.path.startsWith("/") ? input.path : `/${input.path}`;
  if (normalizedPath.includes("%") || normalizedPath.includes("\\") || normalizedPath.includes("//")) {
    throw new Error("Git credential path is malformed.");
  }
  const match = /^\/([^/]+)\/([^/]+)\.git$/.exec(normalizedPath);
  if (!match) throw new Error("Git credential path must identify one Forgejo repository.");
  const organization = match[1]!;
  const repository = match[2]!;
  if (!FORGEJO_PATH_SEGMENT_PATTERN.test(organization) || !FORGEJO_PATH_SEGMENT_PATTERN.test(repository)) {
    throw new Error("Git credential path is malformed.");
  }

  return {
    protocol: "https",
    host: origin.host,
    path: `/${organization}/${repository}.git`,
    gatewayOrigin: origin.origin,
    organization,
    repository,
  };
}

export function formatGitCredentialOutput(input: { username: string; password: string }): string {
  if (!input.username || /[\r\n]/.test(input.username) || !input.password || /[\r\n]/.test(input.password)) {
    throw new Error("Credential exchange returned malformed data.");
  }
  return `username=${input.username}\npassword=${input.password}\n\n`;
}
