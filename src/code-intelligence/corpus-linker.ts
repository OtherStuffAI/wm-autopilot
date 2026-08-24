import { encodeGraphId, graphEdge } from "./graph-builders";
import type { GraphEdgeInput, GraphNodeInput, RepositoryDeltaPayload } from "./types";

export const CORPUS_LINKER = { adapter: "code-intelligence-corpus-linker", version: "1", pass: "cross-file-cross-repository" };

function text(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function provenance(node: GraphNodeInput, evidence: string, confidence = 0.98) {
  const original = node.properties.provenance as Record<string, unknown>;
  return { ...original, parser: CORPUS_LINKER, confidence, evidence };
}

export function linkCorpusDeltas(deltas: RepositoryDeltaPayload[]): RepositoryDeltaPayload[] {
  const byCorpus = new Map<string, RepositoryDeltaPayload[]>();
  for (const delta of deltas) byCorpus.set(delta.corpus_id, [...(byCorpus.get(delta.corpus_id) ?? []), delta]);
  for (const corpusDeltas of byCorpus.values()) {
    const allNodes = corpusDeltas.flatMap((delta) => delta.nodes);
    const files = new Map<string, GraphNodeInput>();
    const symbolsByName = new Map<string, GraphNodeInput[]>();
    const routes = new Map<string, GraphNodeInput[]>();
    for (const value of allNodes) {
      const path = text(value.properties.path);
      const repository = text((value.properties.provenance as Record<string, unknown> | undefined)?.repository);
      if (value.node_type === "file" && path && repository) files.set(`${repository}:${path}`, value);
      if ((value.node_type === "callable" || value.node_type === "declaration") && text(value.properties.name)) {
        const name = text(value.properties.name)!;
        symbolsByName.set(name, [...(symbolsByName.get(name) ?? []), value]);
        const qualified = text(value.properties.qualified_name);
        if (qualified && qualified !== name) symbolsByName.set(qualified, [...(symbolsByName.get(qualified) ?? []), value]);
      }
      if (value.node_type === "http_route") {
        const key = `${text(value.properties.method)} ${text(value.properties.route)}`;
        routes.set(key, [...(routes.get(key) ?? []), value]);
      }
    }
    for (const delta of corpusDeltas) {
      const generated: GraphEdgeInput[] = [];
      for (const value of delta.nodes) {
        if (value.node_type === "module_reference") {
          const targetPath = text(value.properties.resolved_path);
          const target = targetPath ? files.get(`${delta.repository_id}:${targetPath}`) ?? files.get(`${delta.repository_id}:${targetPath.replace(/\.ts$/, "/index.ts")}`) : null;
          if (target) generated.push(graphEdge(`${value.external_id}:resolves_to:${target.external_id}`, value.external_id, target.external_id, "RESOLVES_TO", { provenance: provenance(value, "exact repository-relative import path") }));
        }
        if (value.node_type === "ui_action") {
          const requested = text(value.properties.target_symbol_name);
          const candidates = requested ? symbolsByName.get(requested) ?? symbolsByName.get(requested.split(".").at(-1)!) ?? [] : [];
          if (candidates.length === 1) generated.push(graphEdge(`${value.external_id}:triggers:${candidates[0]!.external_id}`, value.external_id, candidates[0]!.external_id, "TRIGGERS", { provenance: provenance(value, "unique callable name in corpus", 0.92) }));
        }
        if (value.node_type === "api_consumer") {
          const key = `${text(value.properties.method)} ${text(value.properties.route)}`;
          const candidates = routes.get(key) ?? [];
          if (candidates.length === 1) generated.push(graphEdge(`${value.external_id}:matches:${candidates[0]!.external_id}`, value.external_id, candidates[0]!.external_id, "MATCHES_ROUTE", { provenance: provenance(value, "exact normalized method and route across corpus") }));
        }
      }
      const existing = new Set(delta.edges.map((item) => item.external_id));
      delta.edges.push(...generated.filter((item) => !existing.has(item.external_id)));
      delta.edges.sort((a, b) => a.external_id.localeCompare(b.external_id));
      delta.parser_metadata = { ...delta.parser_metadata, linker: CORPUS_LINKER };
      delta.index_metadata = { ...delta.index_metadata, corpusLinked: true };
    }
  }
  return deltas;
}
