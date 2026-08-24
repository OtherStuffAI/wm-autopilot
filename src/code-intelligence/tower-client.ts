import { capabilityNip98Fetch } from "../mcp/capability-client";
import type { RepositoryDeltaPayload, RepositoryDefinition } from "./types";

export interface RepositoryCheckpoint {
  source: string;
  corpus_id: string;
  repository_id: string;
  head_sha: string;
  schema_version: string;
  parser_metadata: Record<string, unknown>;
  index_metadata: Record<string, unknown>;
  updated_at: string;
}
export type TowerSubmitResult =
  | { status: "success"; checkpoint: RepositoryCheckpoint; replayed: boolean; counts: MutationCounts }
  | { status: "stale_base"; currentHeadSha: string | null; error: string }
  | { status: "validation_failure"; httpStatus: number; code: string | null; error: string }
  | { status: "retryable_transport_failure"; httpStatus: number | null; error: string };
export interface MutationCounts { nodes_upserted: number; edges_upserted: number; nodes_deleted: number; edges_deleted: number; schema_upserted: number }
export type SignedFetch = (url: string, init?: RequestInit) => Promise<Response>;

function scopeQuery(repository: RepositoryDefinition): URLSearchParams {
  const query = new URLSearchParams({ source: repository.source, corpus_id: repository.corpusId, repository_id: repository.repositoryId, visibility: repository.scope.visibility, limit: "1" });
  for (const [key, value] of Object.entries(repository.scope)) if (key !== "visibility" && value) query.set(key, value);
  return query;
}

export class TowerCodeIntelligenceClient {
  constructor(private readonly baseUrl: string, private readonly signedFetch: SignedFetch = capabilityNip98Fetch) {}

  async getCheckpoint(repository: RepositoryDefinition): Promise<RepositoryCheckpoint | null> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/v4/graph/repository-checkpoints?${scopeQuery(repository)}`;
    const response = await this.signedFetch(url);
    if (!response.ok) throw new Error(`Tower checkpoint read failed (${response.status}): ${await errorText(response)}`);
    const body = await response.json() as { checkpoints?: RepositoryCheckpoint[] };
    return body.checkpoints?.[0] ?? null;
  }

  async submitDelta(delta: RepositoryDeltaPayload): Promise<TowerSubmitResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/v4/graph/repository-deltas`;
    let response: Response;
    try {
      response = await this.signedFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(delta) });
    } catch (error) {
      return { status: "retryable_transport_failure", httpStatus: null, error: error instanceof Error ? error.message : String(error) };
    }
    const parsed = await response.json().catch(() => null);
    const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    if (response.ok && body.checkpoint && body.counts) return { status: "success", checkpoint: body.checkpoint as RepositoryCheckpoint, replayed: body.replayed === true, counts: body.counts as MutationCounts };
    if (response.ok) return { status: "retryable_transport_failure", httpStatus: response.status, error: "Tower returned an empty or malformed delta response" };
    const message = typeof body.error === "string" ? body.error : `Tower request failed (${response.status})`;
    const code = typeof body.code === "string" ? body.code : null;
    if (response.status === 409 && code === "graph_delta_stale_base") return { status: "stale_base", currentHeadSha: typeof body.current_head_sha === "string" ? body.current_head_sha : null, error: message };
    if (response.status === 408 || response.status === 429 || response.status >= 500) return { status: "retryable_transport_failure", httpStatus: response.status, error: message };
    return { status: "validation_failure", httpStatus: response.status, code, error: message };
  }
}

async function errorText(response: Response): Promise<string> {
  const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : await response.text();
}
