import { createHash } from "node:crypto";
import { z } from "zod";

const conceptId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
export const spaceExplainRequest = z.object({
  requestId: z.string().uuid(),
  conceptId,
  mode: z.enum(["explain", "compare", "check-understanding"]),
  question: z.string().trim().min(1).max(2000),
  style: z.enum(["simple", "standard", "technical"]),
  graphVersion: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(100),
  graphHash: z.string().regex(/^[a-f0-9]{64}$/),
  learnerHints: z.array(z.object({
    conceptId,
    state: z.enum(["unseen", "viewed", "tested", "demonstrated", "remembered"]),
    views: z.number().int().min(0).max(1000).optional(),
    due: z.boolean().optional(),
  }).strict()).max(6).optional(),
}).strict();
export type SpaceExplainRequest = z.infer<typeof spaceExplainRequest>;

export const supportSchema = z.object({
  supportId: z.string().min(1).max(150),
  sourceId: z.string().min(1).max(150),
  targetType: z.enum(["concept", "relation"]),
  targetId: z.string().min(1).max(150),
  url: z.string().url().max(2000).refine(value => /^https?:\/\//.test(value)),
  title: z.string().min(1).max(500),
  publisher: z.string().min(1).max(500),
  locator: z.string().min(1).max(2000),
  summary: z.string().min(1).max(6000),
}).strict();
export type ExplainSupport = z.infer<typeof supportSchema>;
export interface ExplainEvidence {
  conceptIds: string[];
  supports: ExplainSupport[];
}

const supportIds = z.array(z.string().min(1).max(150)).min(1).max(12);
export const spaceExplainOutput = z.object({
  status: z.enum(["supported", "partial", "no_supported_match"]),
  claims: z.array(z.object({ text: z.string().min(1).max(1000), supportIds }).strict()).max(6),
  inferences: z.array(z.object({ text: z.string().min(1).max(1000), basisSupportIds: supportIds }).strict()).max(3),
  unknowns: z.array(z.string().min(1).max(500)).max(6),
  citations: z.array(supportSchema.omit({ summary: true, publisher: true })).max(24),
  suggestedConceptIds: z.array(conceptId).max(3),
  followUpQuestion: z.string().min(1).max(500).optional(),
}).strict();

export function hashExplainInput(input: SpaceExplainRequest): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function exactSupportId(value: Omit<ExplainSupport, "supportId">): string {
  // Tower support records have tuple identity, not a standalone ID.
  return `support:${createHash("sha256").update(JSON.stringify([
    value.targetType, value.targetId, value.sourceId, value.locator, value.summary,
  ])).digest("hex")}`;
}

export function validateExplainOutput(raw: unknown, evidence: ExplainEvidence, input: SpaceExplainRequest) {
  const output = spaceExplainOutput.parse(raw);
  const available = new Map(evidence.supports.map(item => [item.supportId, item]));
  const cited = new Set<string>();
  for (const citation of output.citations) {
    const support = available.get(citation.supportId);
    if (!support || Object.entries(citation).some(([key, value]) => support[key as keyof ExplainSupport] !== value)) {
      throw new Error("invalid_citation");
    }
    cited.add(citation.supportId);
  }
  const used = [...output.claims.flatMap(item => item.supportIds), ...output.inferences.flatMap(item => item.basisSupportIds)];
  if (used.some(id => !available.has(id) || !cited.has(id))) throw new Error("invalid_citation");
  if (output.suggestedConceptIds.some(id => !evidence.conceptIds.includes(id))) throw new Error("invalid_concept");
  if (output.status === "no_supported_match") {
    if (output.claims.length || output.inferences.length || output.citations.length || !output.unknowns.length) throw new Error("invalid_unsupported_response");
  } else if (!output.claims.length || !used.length) throw new Error("missing_support");
  if (output.status === "partial" && !output.unknowns.length && !output.inferences.length) throw new Error("partial_without_labels");
  if (output.status === "supported" && (output.inferences.length || output.unknowns.length)) throw new Error("unlabelled_partial_response");
  // The UI renders claims and explicitly labelled inference/unknown sections; no uncited free prose.
  return { ...output, contract: "space-explain.v1", requestId: input.requestId, mode: input.mode,
    graphVersion: input.graphVersion, graphHash: input.graphHash,
    disclaimer: "Generated explanation; assessment evidence unchanged." };
}
