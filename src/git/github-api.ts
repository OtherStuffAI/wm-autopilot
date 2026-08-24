import { getGitHubUserCredentials, type GitHubUserCredentials } from "./github-credential-helper";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export type GitHubAuthenticatedUser = {
  login: string;
  id: number;
};

export type GitHubRepository = {
  owner: string;
  name: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch?: string | null;
};

export type GitHubRepoProtectionMode = "main" | "deployed";

export type GitHubBranch = {
  name: string;
  sha: string;
  protected: boolean;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  headRepoFullName: string | null;
  userLogin: string | null;
};

export type GitHubCheckRunSummary = {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
};

export type GitHubPullRequestChecks = {
  totalCount: number;
  checkRuns: GitHubCheckRunSummary[];
};

export type GitHubCombinedStatus = {
  state: string;
  totalCount: number;
  statuses: Array<{
    context: string;
    state: string;
    targetUrl: string | null;
    description: string | null;
  }>;
};

export type GitHubCompareResult = {
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  htmlUrl: string | null;
};

export type GitHubMergeResult = {
  merged: boolean;
  sha: string | null;
  message: string;
};

export type GitHubUpdateBranchRefResult = {
  ref: string;
  sha: string;
};

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

function normaliseGitHubOwner(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(trimmed)) {
    throw new Error("GitHub owner must be a valid user or organization name");
  }
  return trimmed;
}

function normaliseGitHubRepoName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error("GitHub repo name may only contain letters, numbers, dots, dashes, and underscores");
  }
  return trimmed;
}

function normaliseGitHubBranchName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("..") || trimmed.includes(" ")) {
    throw new Error("GitHub branch must be a non-empty branch name without spaces or '..'");
  }
  return trimmed;
}

function normaliseGitHubRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("GitHub ref must be non-empty");
  return trimmed;
}

async function parseGitHubJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function resolveGitHubError(payload: Record<string, unknown>, fallback: string): string {
  const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : fallback;
  const errors = Array.isArray(payload.errors)
    ? payload.errors
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const record = entry as Record<string, unknown>;
          return [record.resource, record.field, record.code, record.message].filter(Boolean).join(" ");
        })
        .filter(Boolean)
    : [];
  return errors.length ? `${message}: ${errors.join("; ")}` : message;
}

export function getGitHubCredentialsForNpub(npub: string | null | undefined): GitHubUserCredentials | null {
  const normalized = typeof npub === "string" ? npub.trim() : "";
  return normalized ? getGitHubUserCredentials(normalized) : null;
}

export class GitHubApiClient {
  constructor(private readonly token: string) {}

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await parseGitHubJson(response);
    if (!response.ok) {
      throw new GitHubApiError(resolveGitHubError(payload, response.statusText), response.status);
    }
    return payload;
  }

  private async requestArray(method: string, path: string, body?: unknown): Promise<Record<string, unknown>[]> {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => []) as unknown;
    if (!response.ok) {
      throw new GitHubApiError(resolveGitHubError(
        payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {},
        response.statusText,
      ), response.status);
    }
    return Array.isArray(payload) ? payload.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
  }

  async getAuthenticatedUser(): Promise<GitHubAuthenticatedUser> {
    const payload = await this.request("GET", "/user");
    const login = typeof payload.login === "string" ? payload.login : "";
    const id = typeof payload.id === "number" ? payload.id : 0;
    if (!login) throw new Error("GitHub token did not return an authenticated user");
    return { login, id };
  }

  async createRepository(input: {
    owner: string;
    name: string;
    private: boolean;
    description?: string | null;
    authenticatedLogin: string;
  }): Promise<GitHubRepository> {
    const owner = normaliseGitHubOwner(input.owner);
    const name = normaliseGitHubRepoName(input.name);
    const body = {
      name,
      private: Boolean(input.private),
      auto_init: false,
      description: input.description || undefined,
    };
    const path =
      owner.toLowerCase() === input.authenticatedLogin.toLowerCase()
        ? "/user/repos"
        : `/orgs/${encodeURIComponent(owner)}/repos`;
    const payload = await this.request("POST", path, body);
    const cloneUrl = typeof payload.clone_url === "string" ? payload.clone_url : "";
    const htmlUrl = typeof payload.html_url === "string" ? payload.html_url : "";
    if (!cloneUrl || !htmlUrl) throw new Error("GitHub repository was created but did not return clone URLs");
    return {
      owner,
      name,
      cloneUrl,
      htmlUrl,
      private: Boolean(payload.private),
      defaultBranch: typeof payload.default_branch === "string" ? payload.default_branch : null,
    };
  }

  async getRepository(input: { owner: string; repo: string }): Promise<GitHubRepository> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const payload = await this.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
    return mapRepository(payload, owner, repoName);
  }

  async getBranch(input: { owner: string; repo: string; branch: string }): Promise<GitHubBranch> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const branch = normaliseGitHubBranchName(input.branch);
    const payload = await this.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/branches/${encodeURIComponent(branch)}`);
    return {
      name: typeof payload.name === "string" ? payload.name : branch,
      sha: stringAt(payload, ["commit", "sha"]) || "",
      protected: Boolean(payload.protected),
    };
  }

  async listPullRequests(input: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
    base?: string | null;
    head?: string | null;
    perPage?: number;
  }): Promise<GitHubPullRequest[]> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const params = new URLSearchParams();
    params.set("state", input.state || "open");
    if (input.base) params.set("base", input.base);
    if (input.head) params.set("head", input.head);
    params.set("per_page", String(Math.min(Math.max(Number(input.perPage) || 100, 1), 100)));
    const payload = await this.requestArray("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls?${params.toString()}`);
    return payload.map(mapPullRequest).filter((pr) => pr.number > 0);
  }

  async getPullRequest(input: { owner: string; repo: string; number: number }): Promise<GitHubPullRequest> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const number = normalisePullRequestNumber(input.number);
    return mapPullRequest(await this.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${number}`));
  }

  async getPullRequestChecks(input: { owner: string; repo: string; ref: string }): Promise<GitHubPullRequestChecks> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const ref = normaliseGitHubRef(input.ref);
    const payload = await this.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`);
    const checkRuns = Array.isArray(payload.check_runs)
      ? payload.check_runs.map((entry) => mapCheckRun(entry)).filter((entry) => entry.name)
      : [];
    return {
      totalCount: Number(payload.total_count) || checkRuns.length,
      checkRuns,
    };
  }

  async getCombinedStatus(input: { owner: string; repo: string; ref: string }): Promise<GitHubCombinedStatus> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const ref = normaliseGitHubRef(input.ref);
    const payload = await this.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/commits/${encodeURIComponent(ref)}/status`);
    const statuses = Array.isArray(payload.statuses)
      ? payload.statuses.map((entry) => mapStatus(entry)).filter((entry) => entry.context)
      : [];
    return {
      state: typeof payload.state === "string" ? payload.state : "unknown",
      totalCount: Number(payload.total_count) || statuses.length,
      statuses,
    };
  }

  async getCompare(input: { owner: string; repo: string; base: string; head: string }): Promise<GitHubCompareResult> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const base = normaliseGitHubRef(input.base);
    const head = normaliseGitHubRef(input.head);
    const payload = await this.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return {
      status: typeof payload.status === "string" ? payload.status : "unknown",
      aheadBy: Number(payload.ahead_by) || 0,
      behindBy: Number(payload.behind_by) || 0,
      totalCommits: Number(payload.total_commits) || 0,
      htmlUrl: typeof payload.html_url === "string" ? payload.html_url : null,
    };
  }

  async mergePullRequest(input: {
    owner: string;
    repo: string;
    number: number;
    sha?: string | null;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string | null;
    commitMessage?: string | null;
  }): Promise<GitHubMergeResult> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const number = normalisePullRequestNumber(input.number);
    const payload = await this.request("PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${number}/merge`, {
      ...(input.sha ? { sha: input.sha } : {}),
      ...(input.mergeMethod ? { merge_method: input.mergeMethod } : {}),
      ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
      ...(input.commitMessage ? { commit_message: input.commitMessage } : {}),
    });
    return {
      merged: Boolean(payload.merged),
      sha: typeof payload.sha === "string" ? payload.sha : null,
      message: typeof payload.message === "string" ? payload.message : "",
    };
  }

  async updateBranchRef(input: { owner: string; repo: string; branch: string; sha: string; force?: boolean }): Promise<GitHubUpdateBranchRefResult> {
    const owner = normaliseGitHubOwner(input.owner);
    const repoName = normaliseGitHubRepoName(input.repo);
    const branch = normaliseGitHubBranchName(input.branch);
    const payload = await this.request("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: normaliseGitHubRef(input.sha),
      force: Boolean(input.force),
    });
    return {
      ref: typeof payload.ref === "string" ? payload.ref : `refs/heads/${branch}`,
      sha: stringAt(payload, ["object", "sha"]) || "",
    };
  }

  async protectBranch(input: {
    owner: string;
    repo: string;
    branch: string;
    actorLogin: string;
    mode: GitHubRepoProtectionMode;
  }): Promise<void> {
    const requiredPullRequestReviews =
      input.mode === "main"
        ? {
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            required_approving_review_count: 1,
          }
        : null;

    await this.request(
      "PUT",
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(input.branch)}/protection`,
      {
        required_status_checks: null,
        enforce_admins: true,
        required_pull_request_reviews: requiredPullRequestReviews,
        restrictions: {
          users: [input.actorLogin],
          teams: [],
          apps: [],
        },
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
        block_creations: false,
        required_conversation_resolution: input.mode === "main",
        lock_branch: false,
        allow_fork_syncing: false,
      },
    );
  }
}

function normalisePullRequestNumber(value: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("GitHub pull request number must be a positive integer");
  return number;
}

function objectAt(value: unknown, path: string[]): Record<string, unknown> {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return {};
    current = (current as Record<string, unknown>)[part];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
}

function stringAt(value: unknown, path: string[]): string | null {
  const parent = path.length > 1 ? objectAt(value, path.slice(0, -1)) : value;
  const key = path[path.length - 1];
  if (!key || !parent || typeof parent !== "object" || Array.isArray(parent)) return null;
  const raw = (parent as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function mapRepository(payload: Record<string, unknown>, fallbackOwner: string, fallbackName: string): GitHubRepository {
  const ownerLogin = stringAt(payload, ["owner", "login"]);
  return {
    owner: ownerLogin || fallbackOwner,
    name: typeof payload.name === "string" ? payload.name : fallbackName,
    cloneUrl: typeof payload.clone_url === "string" ? payload.clone_url : "",
    htmlUrl: typeof payload.html_url === "string" ? payload.html_url : "",
    private: Boolean(payload.private),
    defaultBranch: typeof payload.default_branch === "string" ? payload.default_branch : null,
  };
}

function mapPullRequest(payload: Record<string, unknown>): GitHubPullRequest {
  return {
    number: Number(payload.number) || 0,
    title: typeof payload.title === "string" ? payload.title : "",
    state: typeof payload.state === "string" ? payload.state : "",
    htmlUrl: typeof payload.html_url === "string" ? payload.html_url : "",
    draft: Boolean(payload.draft),
    mergeable: typeof payload.mergeable === "boolean" ? payload.mergeable : null,
    mergeableState: typeof payload.mergeable_state === "string" ? payload.mergeable_state : null,
    baseBranch: stringAt(payload, ["base", "ref"]) || "",
    headBranch: stringAt(payload, ["head", "ref"]) || "",
    headSha: stringAt(payload, ["head", "sha"]) || "",
    headRepoFullName: stringAt(payload, ["head", "repo", "full_name"]),
    userLogin: stringAt(payload, ["user", "login"]),
  };
}

function mapCheckRun(value: unknown): GitHubCheckRunSummary {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    name: typeof payload.name === "string" ? payload.name : "",
    status: typeof payload.status === "string" ? payload.status : "unknown",
    conclusion: typeof payload.conclusion === "string" ? payload.conclusion : null,
    htmlUrl: typeof payload.html_url === "string" ? payload.html_url : null,
  };
}

function mapStatus(value: unknown): GitHubCombinedStatus["statuses"][number] {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    context: typeof payload.context === "string" ? payload.context : "",
    state: typeof payload.state === "string" ? payload.state : "unknown",
    targetUrl: typeof payload.target_url === "string" ? payload.target_url : null,
    description: typeof payload.description === "string" ? payload.description : null,
  };
}
