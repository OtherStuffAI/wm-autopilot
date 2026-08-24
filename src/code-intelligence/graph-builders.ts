import type { GraphEdgeInput, GraphNodeInput, ParserPassMetadata, Provenance, RepositoryDefinition } from "./types";

export const encodeGraphId = (value: string) => encodeURIComponent(value).replaceAll("%2F", "/");
export const repositoryPrefix = (repo: RepositoryDefinition) => `${repo.corpusId}:${repo.repositoryId}:`;
export const fileId = (repo: RepositoryDefinition, path: string) => `${repositoryPrefix(repo)}file:${encodeGraphId(path)}`;
export const symbolId = (repo: RepositoryDefinition, path: string, qualifiedName: string) => `${repositoryPrefix(repo)}symbol:${encodeGraphId(path)}#${encodeGraphId(qualifiedName)}`;
export const routeId = (repo: RepositoryDefinition, method: string, route: string) => `${repositoryPrefix(repo)}route:${method.toUpperCase()}:${encodeGraphId(route)}`;
export const tableId = (repo: RepositoryDefinition, table: string) => `${repositoryPrefix(repo)}table:${encodeGraphId(table)}`;

export function graphNode(external_id: string, node_type: string, labels: string[], properties: Record<string, unknown>): GraphNodeInput {
  return { external_id, node_type, labels: [...new Set(labels)].sort(), properties, property_mode: "replace" };
}

export function graphEdge(external_id: string, from_external_id: string, to_external_id: string, relationship_type: string, properties: Record<string, unknown>): GraphEdgeInput {
  return { external_id, from_external_id, to_external_id, relationship_type, properties, property_mode: "replace" };
}

export function basicProvenance(repo: RepositoryDefinition, commit: string, path: string, parser: ParserPassMetadata, confidence: number, evidence: string, range?: Provenance["range"]): Provenance {
  return { repository: repo.repositoryId, commit, path, range, parser, confidence, evidence };
}
