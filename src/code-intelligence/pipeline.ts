import { spawn } from "bun";
import { buildRepositoryDelta } from "./engine";
import { linkCorpusDeltas } from "./corpus-linker";
import { TowerCodeIntelligenceClient } from "./tower-client";
import type { IndexingMode, ParserOptions, RepositoryDefinition } from "./types";

export interface RepositoryPipelineInput {
  towerUrl: string;
  repository: RepositoryDefinition & { root: string };
  mode?: IndexingMode;
  parserOptions?: ParserOptions;
}

async function gitHead(root: string): Promise<string> {
  const child = spawn(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Unable to resolve repository HEAD: ${error.trim()}`);
  return out.trim();
}

export async function indexRepositoryForPipeline(input: RepositoryPipelineInput, client = new TowerCodeIntelligenceClient(input.towerUrl)) {
  try {
    return await indexRepository(input, client);
  } catch (error) {
    return resultBase(input, null, "", input.mode ?? "incremental", { status: "validation_failure", error: error instanceof Error ? error.message : String(error) });
  }
}

async function indexRepository(input: RepositoryPipelineInput, client: TowerCodeIntelligenceClient) {
  const { root, ...definition } = input.repository;
  const headSha = await gitHead(root);
  const checkpoint = await client.getCheckpoint(definition);
  const mode = input.mode ?? "incremental";
  if (mode === "incremental" && checkpoint?.head_sha === headSha) {
    return resultBase(input, checkpoint.head_sha, headSha, mode, { status: "skip", skipReason: "checkpoint_matches_head" });
  }
  if (mode === "incremental" && !checkpoint) {
    return resultBase(input, null, headSha, mode, { status: "validation_failure", error: "incremental indexing requires an existing Tower checkpoint; run full_rebuild first" });
  }
  const generated = await buildRepositoryDelta({ repository: definition, repositoryRoot: root, previousSha: checkpoint?.head_sha ?? null, currentSha: headSha, mode, parserOptions: input.parserOptions });
    if (!generated.delta) return resultBase(input, checkpoint?.head_sha ?? null, headSha, mode, { status: "skip", skipReason: generated.diagnostics.skipReason, filesChanged: generated.diagnostics.filesChanged });
    const submitted = await client.submitDelta(generated.delta);
  return resultBase(input, checkpoint?.head_sha ?? null, headSha, mode, {
      ...submitted,
      filesChanged: generated.diagnostics.filesChanged,
      nodesUpserted: submitted.status === "success" ? submitted.counts.nodes_upserted : 0,
      edgesUpserted: submitted.status === "success" ? submitted.counts.edges_upserted : 0,
      nodesDeleted: submitted.status === "success" ? submitted.counts.nodes_deleted : 0,
      edgesDeleted: submitted.status === "success" ? submitted.counts.edges_deleted : 0,
      checkpoint: submitted.status === "success" ? submitted.checkpoint.head_sha : checkpoint?.head_sha ?? null,
  });
}

function resultBase(input: RepositoryPipelineInput, baseSha: string | null, headSha: string, mode: IndexingMode, extra: Record<string, unknown>): Record<string, unknown> {
  return { corpus: input.repository.corpusId, repository: input.repository.repositoryId, baseSha, headSha, mode, filesChanged: 0, nodesUpserted: 0, edgesUpserted: 0, nodesDeleted: 0, edgesDeleted: 0, checkpoint: baseSha, skipReason: null, error: null, ...extra };
}

export async function indexCorpusSequentially(input: { towerUrl: string; repositories: Array<RepositoryDefinition & { root: string; available?: boolean; unavailableReason?: string }>; mode?: IndexingMode; parserOptions?: ParserOptions }) {
  const results: Record<string, unknown>[] = [];
  const pending: Array<{ input: RepositoryPipelineInput; baseSha: string | null; headSha: string; generated: Awaited<ReturnType<typeof buildRepositoryDelta>>; client: TowerCodeIntelligenceClient }> = [];
  const unchanged: Array<{ input: RepositoryPipelineInput; definition: RepositoryDefinition; headSha: string; client: TowerCodeIntelligenceClient }> = [];
  const mode = input.mode ?? "incremental";
  for (const repository of input.repositories) {
    if (repository.available === false) {
      results.push({ corpus: repository.corpusId, repository: repository.repositoryId, mode, status: "skip", skipReason: repository.unavailableReason ?? "repository_unavailable", error: null });
      continue;
    }
    try {
      const { root, ...definition } = repository;
      const pipelineInput = { towerUrl: input.towerUrl, repository: { ...definition, root }, mode, parserOptions: input.parserOptions };
      const client = new TowerCodeIntelligenceClient(input.towerUrl);
      const [headSha, checkpoint] = await Promise.all([gitHead(root), client.getCheckpoint(definition)]);
      if (mode === "incremental" && checkpoint?.head_sha === headSha) {
        unchanged.push({ input: pipelineInput, definition, headSha, client });
        continue;
      }
      if (mode === "incremental" && !checkpoint) {
        results.push(resultBase(pipelineInput, null, headSha, mode, { status: "validation_failure", error: "incremental indexing requires an existing Tower checkpoint; run full_rebuild first" }));
        continue;
      }
      const generated = await buildRepositoryDelta({ repository: definition, repositoryRoot: root, previousSha: checkpoint?.head_sha ?? null, currentSha: headSha, mode, parserOptions: input.parserOptions });
      if (!generated.delta) {
        results.push(resultBase(pipelineInput, checkpoint?.head_sha ?? null, headSha, mode, { status: "skip", skipReason: generated.diagnostics.skipReason, filesChanged: generated.diagnostics.filesChanged }));
        continue;
      }
      pending.push({ input: pipelineInput, baseSha: checkpoint?.head_sha ?? null, headSha, generated, client });
    } catch (error) {
      results.push({ corpus: repository.corpusId, repository: repository.repositoryId, mode, status: "validation_failure", skipReason: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (pending.length === 0) {
    for (const item of unchanged) results.push(resultBase(item.input, item.headSha, item.headSha, mode, { status: "skip", skipReason: "checkpoint_matches_head" }));
  } else {
    // A link owned by an unchanged repository can change when another repository
    // adds/removes a route or export. Promote unchanged corpus members to a full
    // repository reconciliation so Tower cannot retain stale cross-repo edges.
    for (const item of unchanged) {
      const generated = await buildRepositoryDelta({ repository: item.definition, repositoryRoot: item.input.repository.root, previousSha: null, currentSha: item.headSha, mode: "full_rebuild", parserOptions: input.parserOptions });
      pending.push({ input: item.input, baseSha: item.headSha, headSha: item.headSha, generated, client: item.client });
    }
  }
  linkCorpusDeltas(pending.flatMap((item) => item.generated.delta ? [item.generated.delta] : []));
  for (const item of pending) {
    try {
      const submitted = await item.client.submitDelta(item.generated.delta!);
      results.push(resultBase(item.input, item.baseSha, item.headSha, mode, {
        ...submitted,
        filesChanged: item.generated.diagnostics.filesChanged,
        nodesUpserted: submitted.status === "success" ? submitted.counts.nodes_upserted : 0,
        edgesUpserted: submitted.status === "success" ? submitted.counts.edges_upserted : 0,
        nodesDeleted: submitted.status === "success" ? submitted.counts.nodes_deleted : 0,
        edgesDeleted: submitted.status === "success" ? submitted.counts.edges_deleted : 0,
        checkpoint: submitted.status === "success" ? submitted.checkpoint.head_sha : item.baseSha,
        effectiveMode: item.generated.delta?.mode,
      }));
    } catch (error) {
      results.push(resultBase(item.input, item.baseSha, item.headSha, mode, { status: "validation_failure", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  const ordered = input.repositories.flatMap((repository) => results.filter((result) => result.repository === repository.repositoryId));
  return { corpus: input.repositories[0]?.corpusId ?? null, mode, repositories: ordered, succeeded: ordered.filter((item) => item.status === "success").length, skipped: ordered.filter((item) => item.status === "skip").length, failed: ordered.filter((item) => !["success", "skip"].includes(String(item.status))).length };
}
