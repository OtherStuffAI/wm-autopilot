import type { CapabilityClientContext } from '../mcp/capability-client';
import { capabilityNip98Fetch } from '../mcp/capability-client';

export interface ForgejoIssueAuthor {
  username: string;
  display_name: string | null;
}

export interface ForgejoIssueLabel {
  name: string;
  color: string | null;
}

export interface ForgejoIssue {
  issue_number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  url: string;
  author: ForgejoIssueAuthor;
  labels: ForgejoIssueLabel[];
  comment_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ForgejoIssueComment {
  comment_id: number;
  issue_number: number;
  body: string;
  url: string;
  author: ForgejoIssueAuthor;
  created_at: string;
  updated_at: string;
}

export class TowerForgejoIssueError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'TowerForgejoIssueError';
  }
}

export interface TowerForgejoIssuesClientConfig {
  towerUrl: string;
  capabilityContext: CapabilityClientContext;
  fetchImpl?: typeof fetch;
}

export class TowerForgejoIssuesClient {
  private readonly towerUrl: string;
  private readonly capabilityContext: CapabilityClientContext;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TowerForgejoIssuesClientConfig) {
    this.towerUrl = normalizeHttpOrigin(config.towerUrl, 'Tower URL');
    this.fetchImpl = config.fetchImpl ?? config.capabilityContext.fetch ?? fetch;
    this.capabilityContext = { ...config.capabilityContext, fetch: this.fetchImpl };
  }

  async listIssues(workspaceId: string, repositoryId: string, input: {
    state?: 'open' | 'closed' | 'all';
    page?: number;
    limit?: number;
  } = {}): Promise<{ issues: ForgejoIssue[] }> {
    const query = new URLSearchParams({
      state: input.state ?? 'open',
      page: String(input.page ?? 1),
      limit: String(input.limit ?? 30),
    });
    return await this.request(
      'GET',
      `${repositoryPath(workspaceId, repositoryId)}/issues?${query.toString()}`,
    );
  }

  async readIssue(workspaceId: string, repositoryId: string, issueNumber: number): Promise<{ issue: ForgejoIssue }> {
    return await this.request(
      'GET',
      `${repositoryPath(workspaceId, repositoryId)}/issues/${positiveInteger(issueNumber, 'issue number')}`,
    );
  }

  async createIssue(workspaceId: string, repositoryId: string, input: {
    title: string;
    body?: string;
    correlationId?: string | null;
  }): Promise<{ issue: ForgejoIssue }> {
    return await this.request('POST', `${repositoryPath(workspaceId, repositoryId)}/issues`, {
      title: requiredText(input.title, 'title'),
      body: input.body ?? '',
      ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    });
  }

  async commentIssue(workspaceId: string, repositoryId: string, issueNumber: number, input: {
    body: string;
    correlationId?: string | null;
  }): Promise<{ comment: ForgejoIssueComment }> {
    return await this.request(
      'POST',
      `${repositoryPath(workspaceId, repositoryId)}/issues/${positiveInteger(issueNumber, 'issue number')}/comments`,
      {
        body: requiredText(input.body, 'comment body'),
        ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
      },
    );
  }

  private async request<T>(method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>): Promise<T> {
    const url = `${this.towerUrl}${path}`;
    // Serialize once. The broker hashes this exact string and the same bytes are
    // sent to Tower's strict, one-use NIP-98 mutation verifier.
    const rawBody = payload === undefined ? undefined : JSON.stringify(payload);
    const response = await capabilityNip98Fetch(url, {
      method,
      headers: rawBody ? { 'content-type': 'application/json' } : undefined,
      body: rawBody,
    }, this.capabilityContext);
    if (response.ok) return await response.json() as T;
    const error = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    throw new TowerForgejoIssueError(
      typeof error.error === 'string' && error.error.trim()
        ? error.error
        : `Tower Forgejo issue request failed (${response.status})`,
      response.status,
      typeof error.code === 'string' ? error.code : null,
    );
  }
}

function repositoryPath(workspaceId: string, repositoryId: string): string {
  return `/api/v4/git/workspaces/${encodeURIComponent(requiredText(workspaceId, 'workspace id'))}`
    + `/repositories/${encodeURIComponent(requiredText(repositoryId, 'repository id'))}`;
}

function normalizeHttpOrigin(value: string, label: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error(`Missing ${label}.`);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  return normalized;
}

function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Missing ${label}.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}
