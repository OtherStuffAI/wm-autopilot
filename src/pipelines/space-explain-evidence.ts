import { z } from "zod";
import { exactSupportId, supportSchema, type ExplainEvidence, type SpaceExplainRequest } from "./space-explain-contract";

const source = z.object({ id: z.string(), url: z.string(), title: z.string(), publisher: z.string() });
const support = z.object({ sourceId: z.string(), targetType: z.enum(["concept", "relation"]),
  targetId: z.string(), locator: z.string(), summary: z.string() });
const citation = z.object({ source, support });
const fact = z.object({ concept: z.object({ id: z.string() }), citations: z.array(citation).max(24),
  connections: z.array(z.object({ relation: z.object({ id: z.string(), from: z.string(), to: z.string() }),
    citations: z.array(citation).max(24) })).max(48) });
const guideSchema = z.object({ version: z.string(), contentHash: z.string(), focused: fact,
  prerequisites: z.array(fact).max(12), supporting: z.array(fact).max(12), neighbours: z.array(fact).max(12),
  notices: z.array(z.string()), limits: z.object({ depth: z.literal(1), nodes: z.literal(13) }) });

export function publicExplainGuide(raw: unknown) { return guideSchema.parse(raw); }

/** Only provenance tuples from a single version-pinned public guide enter the worker. */
export function readExplainEvidence(raw: unknown, input: SpaceExplainRequest): ExplainEvidence {
  if (JSON.stringify(raw).length > 256_000) throw new Error("evidence_limit");
  const guide = guideSchema.parse(raw);
  if (guide.version !== input.graphVersion || guide.contentHash !== input.graphHash || guide.focused.concept.id !== input.conceptId) {
    throw new Error("graph_mismatch");
  }
  if (guide.notices.length) throw new Error("incomplete_evidence");
  const facts = [guide.focused, ...guide.prerequisites, ...guide.supporting, ...guide.neighbours];
  const ids = facts.map(item => item.concept.id);
  if (ids.length > 13 || new Set(ids).size !== ids.length) throw new Error("evidence_limit");
  const supports = new Map<string, z.infer<typeof supportSchema>>();
  for (const item of facts.slice(0, 6)) {
    const citations = [...item.citations.map(value => ({ value, type: "concept", target: item.concept.id })),
      ...item.connections.flatMap(connection => {
        if (!ids.includes(connection.relation.from) || !ids.includes(connection.relation.to)) throw new Error("invalid_relation");
        return connection.citations.map(value => ({ value, type: "relation", target: connection.relation.id }));
      })];
    for (const { value, type, target } of citations) {
      if (value.support.sourceId !== value.source.id || value.support.targetId !== target || value.support.targetType !== type) {
        throw new Error("invalid_support");
      }
      const data = { ...value.support, url: value.source.url, title: value.source.title, publisher: value.source.publisher };
      const entry = supportSchema.parse({ ...data, supportId: exactSupportId(data) });
      const prior = supports.get(entry.supportId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) throw new Error("inconsistent_support");
      supports.set(entry.supportId, entry);
    }
  }
  // Prefer focused support, then neighbours. Keep context strictly bounded.
  const selected = [...supports.values()].slice(0, 24);
  if (JSON.stringify(selected).length > 24_000) throw new Error("evidence_limit");
  return { conceptIds: ids, supports: selected };
}
