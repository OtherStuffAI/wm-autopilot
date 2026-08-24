import type { GraphEdgeInput, GraphNodeInput, ParserOptions, RepositoryDefinition } from "./types";

export interface UnresolvedReference {
  path: string;
  line: number;
  kind: string;
  expression: string;
}

export interface SourceInput {
  repository: RepositoryDefinition;
  commit: string;
  path: string;
  text: string;
  options: ParserOptions;
}

export interface PassOutput {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  unresolved: UnresolvedReference[];
}

export interface CodeIntelligencePass {
  readonly metadata: { adapter: string; version: string; pass: string };
  supports(path: string): boolean;
  parse(input: SourceInput): PassOutput;
}
