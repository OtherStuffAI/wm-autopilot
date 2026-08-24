export type IndexingMode = "incremental" | "full_rebuild";

export interface GraphScope {
  visibility: "personal" | "agent" | "group";
  workspace_owner_npub?: string;
  owner_npub?: string;
  actor_npub?: string;
  source_app_npub?: string;
  group_id?: string;
}

export interface RepositoryDefinition {
  corpusId: string;
  repositoryId: string;
  source: string;
  scope: GraphScope;
  schemaVersion?: string;
}

export interface ParserOptions {
  extensions?: string[];
  exclude?: string[];
  externalRoutes?: Record<string, string>;
  apiCallNames?: string[];
  routeObjectNames?: string[];
  sqlCallNames?: string[];
}

export interface ParserPassMetadata {
  adapter: string;
  version: string;
  pass: string;
}

export interface Provenance {
  repository: string;
  commit: string;
  path: string;
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  parser: { adapter: string; version: string };
  confidence: number;
  evidence: string;
}

export interface GraphNodeInput {
  external_id: string;
  labels: string[];
  node_type: string;
  properties: Record<string, unknown>;
  property_mode: "replace";
}

export interface GraphEdgeInput {
  external_id: string;
  from_external_id: string;
  to_external_id: string;
  relationship_type: string;
  properties: Record<string, unknown>;
  property_mode: "replace";
}

export interface RepositoryDeltaPayload extends GraphScope {
  source: string;
  corpus_id: string;
  repository_id: string;
  base_sha: string | null;
  head_sha: string;
  schema_version: string;
  mode: IndexingMode;
  parser_metadata: Record<string, unknown>;
  index_metadata: Record<string, unknown>;
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  delete_node_external_ids: string[];
  delete_edge_external_ids: string[];
}

export interface IndexRequest {
  repository: RepositoryDefinition;
  repositoryRoot: string;
  previousSha: string | null;
  currentSha: string;
  mode: IndexingMode;
  parserOptions?: ParserOptions;
}

export interface IndexDiagnostics {
  skipped: boolean;
  skipReason: string | null;
  filesChanged: number;
  filesParsed: number;
  added: string[];
  changed: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  warnings: string[];
  unresolved: Array<{ path: string; line: number; kind: string; expression: string }>;
}

export interface IndexResult {
  delta: RepositoryDeltaPayload | null;
  diagnostics: IndexDiagnostics;
}
