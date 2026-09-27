import { afterEach, describe, expect, test } from "bun:test";
import { normalizeSpaceResearchCandidate, retrieveSpacePrimarySources, selectSpaceResearchTopics, spaceResearchReviewGate, validateSpaceSourcePlan } from "./space-research";
import { stageSpaceCandidate } from "./space-research-candidate-api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const topic = { id: "moon-phases-research", title: "Moon phases" };
const sourceUrl = "https://science.nasa.gov/moon/moon-phases/";
const excerpt = "The Moon has phases because we see different portions of its sunlit side";
const selection = selectSpaceResearchTopics({ graphVersion: "2026-09-27.1", topics: [topic] });
const proposal = { concepts: [{ id: "lunar-cycle", title: "Lunar cycle", subjectId: topic.id }], sources: [{ url: sourceUrl }] };
const plan = validateSpaceSourcePlan({ selection, plan: proposal });
const draft = {
  sources: [{ url: sourceUrl, title: "Moon Phases", publisher: "NASA Science" }],
  concepts: [{ id: "lunar-cycle", cluster: "moon", title: "Lunar cycle", claim: "The lunar cycle reflects changing views of the sunlit Moon." }],
  relations: [{ from: topic.id, to: "lunar-cycle", type: "prerequisite" }],
  supports: [
    { targetType: "concept", targetId: "lunar-cycle", sourceUrl, locator: "Introduction", excerpt, summary: "Visible lighting changes during the cycle." },
    { targetType: "relation", targetId: `${topic.id}--lunar-cycle--prerequisite`, sourceUrl, locator: "Introduction", excerpt, summary: "Phases support understanding the cycle." },
  ],
};

describe("Space research source-only flow", () => {
  test("retrieves primary text, validates citations and stages only a reviewable candidate", async () => {
    globalThis.fetch = (async () => new Response(`<html><body><h2>Introduction</h2>${excerpt}. This NASA page explains the lunar cycle in detail.</body></html>`, { headers: { "content-type": "text/html" } })) as typeof fetch;
    const retrieval = await retrieveSpacePrimarySources({ plan });
    const candidate = normalizeSpaceResearchCandidate({ selection, plan, retrieval, draft, existingPrerequisites: [] });
    expect(normalizeSpaceResearchCandidate({ selection, plan, retrieval, draft, existingPrerequisites: [] }).idempotencyKey).toBe(candidate.idempotencyKey);
    expect(candidate.graph).toBeDefined();
    let stagedBody: unknown;
    const staged = await stageSpaceCandidate(candidate, async (_path, body) => {
      stagedBody = body;
      return { candidate: { status: "staged" }, issues: [], idempotent: false };
    });
    expect((stagedBody as Record<string, unknown>).addition).toEqual(candidate.graph);
    expect(spaceResearchReviewGate({ staged })).toEqual({ candidateId: staged.candidateId, reviewStatus: "awaiting_independent_curator_review", published: false });
  });

  test("rejects unsupported claims and cyclic prerequisites", () => {
    const retrieval = { documents: [{ url: sourceUrl, text: `Introduction ${excerpt}. This is a long page with more details.`, retrievedAt: "2026-09-27" }] };
    expect(() => normalizeSpaceResearchCandidate({ selection, plan, retrieval, draft: { ...draft, supports: draft.supports.slice(0, 1) } })).toThrow("Unsupported relation");
    expect(() => normalizeSpaceResearchCandidate({ selection, plan, retrieval, draft: { ...draft, supports: [{ ...draft.supports[0], locator: "Missing section" }, draft.supports[1]] } })).toThrow("Unsupported citation");
    expect(() => normalizeSpaceResearchCandidate({ selection, plan, retrieval, draft, existingPrerequisites: [{ from: "lunar-cycle", to: topic.id }] })).toThrow("Cyclic prerequisite");
  });

  test("rejects untrusted sources and excessive fanout", () => {
    expect(() => validateSpaceSourcePlan({ selection, plan: { ...proposal, sources: [{ url: "https://example.com/moon" }] } })).toThrow("allowlisted primary");
    expect(() => validateSpaceSourcePlan({ selection, plan: proposal, existingConceptIds: ["lunar-cycle"] })).toThrow("Invalid supporting concept");
    expect(() => selectSpaceResearchTopics({ graphVersion: "v1", topics: [topic, topic, topic] })).toThrow("one or two");
  });

  test("reuses a staged candidate when only retrieval dates changed", async () => {
    const retrieval = { documents: [{ url: sourceUrl, text: `Introduction ${excerpt}. More source detail follows.`, retrievedAt: "2026-09-27" }] };
    const candidate = normalizeSpaceResearchCandidate({ selection, plan, retrieval, draft, existingPrerequisites: [] });
    const oldGraph = structuredClone(candidate.graph) as Record<string, unknown[]>;
    (oldGraph.sources[0] as Record<string, unknown>).retrievedAt = "2026-09-26";
    let posts = 0;
    const result = await stageSpaceCandidate(candidate, async () => { posts++; return {}; }, async () => ({ candidate: { status: "staged", base_version: candidate.baseVersion, addition: oldGraph } }));
    expect(result.idempotent).toBe(true);
    expect(posts).toBe(0);
  });
});
