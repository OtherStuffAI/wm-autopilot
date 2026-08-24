import { diffFiles, listFilesAt, normaliseRepositoryPath, readFileAt } from "./git-source";
import { linkCorpusDeltas } from "./corpus-linker";
import { alpineHtmlPass } from "./html-alpine-adapter";
import type { CodeIntelligencePass } from "./pass";
import { typescriptPass, TYPESCRIPT_ADAPTER } from "./typescript-adapter";
import type { GraphEdgeInput, GraphNodeInput, IndexDiagnostics, IndexRequest, IndexResult } from "./types";

const defaultExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".html", ".htm"];
const generatedKinds = ["file", "symbol", "route", "module", "ui_action", "api_consumer", "data_table"];
const passes: CodeIntelligencePass[] = [typescriptPass, alpineHtmlPass];

function isEligible(path: string, extensions: string[], exclude: string[]): boolean {
  return extensions.some((extension) => path.endsWith(extension)) && !exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
function sortNodes(values: GraphNodeInput[]) { return values.sort((a, b) => a.external_id.localeCompare(b.external_id)); }
function sortEdges(values: GraphEdgeInput[]) { return values.sort((a, b) => a.external_id.localeCompare(b.external_id)); }

export async function buildRepositoryDelta(request: IndexRequest): Promise<IndexResult> {
  const diagnostics: IndexDiagnostics = { skipped: false, skipReason: null, filesChanged: 0, filesParsed: 0, added: [], changed: [], deleted: [], renamed: [], warnings: [], unresolved: [] };
  if (request.mode === "incremental" && request.previousSha === request.currentSha) {
    return { delta: null, diagnostics: { ...diagnostics, skipped: true, skipReason: "checkpoint_matches_head" } };
  }
  if (request.mode === "incremental" && !request.previousSha) throw new Error("previousSha is required for incremental indexing");
  const extensions = request.parserOptions?.extensions ?? defaultExtensions;
  const exclude = (request.parserOptions?.exclude ?? ["node_modules", "dist", "build", ".git"]).map(normaliseRepositoryPath);
  const deletes = new Set<string>();
  const deletedEdges = new Set<string>();
  let paths: string[];
  if (request.mode === "full_rebuild") {
    paths = (await listFilesAt(request.repositoryRoot, request.currentSha)).filter((path) => isEligible(path, extensions, exclude));
    diagnostics.added = [...paths];
  } else {
    const changes = await diffFiles(request.repositoryRoot, request.previousSha!, request.currentSha);
    diagnostics.added = changes.added; diagnostics.changed = changes.changed; diagnostics.deleted = changes.deleted; diagnostics.renamed = changes.renamed;
    // Corpus links can be owned by unchanged files. Reparse both snapshots so
    // deletion/relinking remains deterministic after a rename or route removal.
    const previousPaths = (await listFilesAt(request.repositoryRoot, request.previousSha!)).filter((path) => isEligible(path, extensions, exclude));
    const previous = await parseSnapshot(request, request.previousSha!, previousPaths);
    previous.nodes.forEach((value) => deletes.add(value.external_id));
    previous.edges.forEach((value) => deletedEdges.add(value.external_id));
    paths = (await listFilesAt(request.repositoryRoot, request.currentSha)).filter((path) => isEligible(path, extensions, exclude));
  }
  diagnostics.filesChanged = new Set([...diagnostics.added, ...diagnostics.changed, ...diagnostics.deleted, ...diagnostics.renamed.flatMap((item) => [item.from, item.to])]).size;
  if (request.mode === "incremental" && diagnostics.filesChanged === 0) return { delta: null, diagnostics: { ...diagnostics, skipped: true, skipReason: "git_diff_empty" } };

  const parsed = await parseSnapshot(request, request.currentSha, paths);
  const nodes: GraphNodeInput[] = [...parsed.nodes];
  const edges: GraphEdgeInput[] = [...parsed.edges];
  diagnostics.filesParsed = paths.length;
  diagnostics.unresolved.push(...parsed.unresolved);
  diagnostics.warnings.push(...parsed.unresolved.map((item) => `Unresolved ${item.kind} at ${item.path}:${item.line}: ${item.expression}`));
  // Reconciliation deletes every previously generated identity owned by a changed file.
  // Tower ignores nonexistent IDs; explicit current IDs are then replaced by the upserts.
  const deleteNodeIds = [...deletes];
  const deleteEdgeIds = [...deletedEdges];
  const repoPrefix = `${request.repository.corpusId}:${request.repository.repositoryId}:`;
  nodes.push({ external_id: `${repoPrefix}repository`, labels: ["Repository"], node_type: "repository", properties: { repository_id: request.repository.repositoryId, corpus_id: request.repository.corpusId, provenance: { repository: request.repository.repositoryId, commit: request.currentSha, path: ".", parser: TYPESCRIPT_ADAPTER, confidence: 1, evidence: "repository definition" } }, property_mode: "replace" });
  nodes.push({ external_id: `${repoPrefix}commit:${request.currentSha}`, labels: ["Commit"], node_type: "commit", properties: { sha: request.currentSha, provenance: { repository: request.repository.repositoryId, commit: request.currentSha, path: ".", parser: TYPESCRIPT_ADAPTER, confidence: 1, evidence: "requested Git revision" } }, property_mode: "replace" });
  edges.push({ external_id: `${repoPrefix}repository:at_commit:${request.currentSha}`, from_external_id: `${repoPrefix}repository`, to_external_id: `${repoPrefix}commit:${request.currentSha}`, relationship_type: "AT_COMMIT", properties: { provenance: { repository: request.repository.repositoryId, commit: request.currentSha, path: ".", parser: TYPESCRIPT_ADAPTER, confidence: 1, evidence: "requested Git revision" } }, property_mode: "replace" });
  for (const value of nodes.filter((value) => value.node_type === "file")) {
    const path = String(value.properties.path);
    edges.push({ external_id: `${repoPrefix}commit:${request.currentSha}:contains:${encodeURIComponent(path).replaceAll("%2F", "/")}`, from_external_id: `${repoPrefix}commit:${request.currentSha}`, to_external_id: value.external_id, relationship_type: "CONTAINS_FILE", properties: { provenance: { repository: request.repository.repositoryId, commit: request.currentSha, path, parser: TYPESCRIPT_ADAPTER, confidence: 1, evidence: "file present at Git revision" } }, property_mode: "replace" });
  }

  const delta = { ...request.repository.scope, source: request.repository.source, corpus_id: request.repository.corpusId, repository_id: request.repository.repositoryId, base_sha: request.previousSha, head_sha: request.currentSha, schema_version: request.repository.schemaVersion ?? "code-intelligence.v2", mode: request.mode, parser_metadata: { adapter: "code-intelligence-passes", version: "2", passes: passes.map((item) => item.metadata) }, index_metadata: { generatedKinds, filesParsed: diagnostics.filesParsed, relinkStrategy: "full_repository_snapshot" }, nodes: sortNodes(nodes), edges: sortEdges(edges), delete_node_external_ids: request.mode === "full_rebuild" ? [] : [...new Set(deleteNodeIds)].sort(), delete_edge_external_ids: request.mode === "full_rebuild" ? [] : [...new Set(deleteEdgeIds)].sort() };
  linkCorpusDeltas([delta]);
  return { delta, diagnostics };
}

export async function buildCorpusDeltas(requests: IndexRequest[]): Promise<IndexResult[]> {
  const results = await Promise.all(requests.map((request) => buildRepositoryDelta(request)));
  linkCorpusDeltas(results.flatMap((result) => result.delta ? [result.delta] : []));
  return results;
}

async function parseSnapshot(request: IndexRequest, commit: string, paths: string[]) {
  const nodes: GraphNodeInput[] = [];
  const edges: GraphEdgeInput[] = [];
  const unresolved: IndexDiagnostics["unresolved"] = [];
  for (const path of [...new Set(paths)].sort()) {
    const pass = passes.find((item) => item.supports(path));
    if (!pass) continue;
    const parsed = pass.parse({ repository: request.repository, commit, path, text: await readFileAt(request.repositoryRoot, commit, path), options: request.parserOptions ?? {} });
    nodes.push(...parsed.nodes); edges.push(...parsed.edges); unresolved.push(...parsed.unresolved);
  }
  const linked = { ...request.repository.scope, source: request.repository.source, corpus_id: request.repository.corpusId, repository_id: request.repository.repositoryId, base_sha: null, head_sha: commit, schema_version: "code-intelligence.v2", mode: "full_rebuild" as const, parser_metadata: {}, index_metadata: {}, nodes, edges, delete_node_external_ids: [], delete_edge_external_ids: [] };
  linkCorpusDeltas([linked]);
  return { nodes, edges, unresolved };
}
