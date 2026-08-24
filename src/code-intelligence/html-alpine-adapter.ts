import { encodeGraphId, fileId, graphEdge, graphNode } from "./graph-builders";
import type { CodeIntelligencePass, PassOutput, SourceInput } from "./pass";

export const ALPINE_ADAPTER = { adapter: "html-alpine", version: "1", pass: "template-bindings" };

function lineFor(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

export const alpineHtmlPass: CodeIntelligencePass = {
  metadata: ALPINE_ADAPTER,
  supports: (path) => /\.html?$/.test(path),
  parse(input: SourceInput): PassOutput {
    const nodes: PassOutput["nodes"] = [];
    const edges: PassOutput["edges"] = [];
    const unresolved: PassOutput["unresolved"] = [];
    const owner = fileId(input.repository, input.path);
    const baseProvenance = { repository: input.repository.repositoryId, commit: input.commit, path: input.path, parser: ALPINE_ADAPTER, confidence: 1, evidence: "HTML source" };
    nodes.push(graphNode(owner, "file", ["File", "UITemplate"], { path: input.path, extension: ".html", test: false, provenance: baseProvenance }));
    const elementPattern = /<([a-z][\w-]*)([^>]*?(?:@|x-on:)([\w:-]+)\s*=\s*(["'])(.*?)\4[^>]*)>/gis;
    for (const match of input.text.matchAll(elementPattern)) {
      const offset = match.index ?? 0;
      const line = lineFor(input.text, offset);
      const tag = match[1]!;
      const event = match[3]!;
      const expression = match[5]!.trim();
      const callable = expression.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(|$)/)?.[1] ?? null;
      const testId = match[2]?.match(/data-testid\s*=\s*["']([^"']+)/i)?.[1];
      const id = `${owner}:ui-action:${encodeGraphId(testId ?? `${tag}-${event}-${line}`)}`;
      const provenance = { ...baseProvenance, range: { startLine: line, startColumn: 1, endLine: line, endColumn: match[0].length + 1 }, confidence: callable ? 0.96 : 0.7, evidence: "Alpine event binding" };
      nodes.push(graphNode(id, "ui_action", ["UIAction", "UIElement"], { tag, event, expression, target_symbol_name: callable, test_id: testId ?? null, path: input.path, provenance }));
      edges.push(graphEdge(`${owner}:contains:${id}`, owner, id, "CONTAINS_UI_ACTION", { provenance }));
      if (!callable) unresolved.push({ path: input.path, line, kind: "ui_binding", expression });
    }
    return { nodes, edges, unresolved };
  },
};
