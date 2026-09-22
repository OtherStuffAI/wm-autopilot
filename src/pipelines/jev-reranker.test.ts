import { describe, expect, test } from "bun:test";
import { composeJevRerank } from "./jev-reranker";

const candidate = (id: string, originalRank: number, text = id) => ({
  id,
  originalRank,
  title: text,
  provenance: { source: `fixture:${id}` },
});

const judgment = (probability: number, overrides: Record<string, unknown> = {}) => ({
  result: {
    shadowStatus: "ok",
    answers: { relevance: { type: "noul", noul: probability } },
    usage: { input_tokens: 10, output_tokens: 2, cost: 0.001 },
    latencyMs: 25,
    ...overrides,
  },
});

describe("composeJevRerank", () => {
  test("sorts by probability with original-rank stable ties and retains provenance telemetry", () => {
    const result = composeJevRerank({
      candidates: [candidate("later", 2), candidate("first", 1), candidate("best", 3)],
      judgments: { items: [judgment(0.7), judgment(0.7), judgment(0.9)] },
      config: { threshold: 0, minimumShortlist: 0, maximumShortlist: 3, contextBudgetChars: 10_000 },
    });
    expect((result.rankings as Array<Record<string, unknown>>).map((entry) => entry.candidateId)).toEqual(["best", "first", "later"]);
    expect((result.rankings as Array<Record<string, unknown>>)[0]).toMatchObject({
      originalRank: 3,
      rerankedRank: 1,
      included: true,
      probability: 0.9,
      provenance: { source: "fixture:best" },
      cost: 0.001,
      latencyMs: 25,
    });
  });

  test("applies threshold while preserving the minimum shortlist", () => {
    const result = composeJevRerank({
      candidates: [candidate("a", 1), candidate("b", 2), candidate("c", 3)],
      judgments: { items: [judgment(0.2), judgment(0.1), judgment(0.05)] },
      config: { threshold: 0.8, minimumShortlist: 2, maximumShortlist: 3, contextBudgetChars: 10_000 },
    });
    expect((result.selectedCandidates as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("enforces maximum count and context budget after the minimum", () => {
    const candidates = [candidate("a", 1, "a".repeat(100)), candidate("b", 2, "b".repeat(100)), candidate("c", 3, "c".repeat(100))];
    const budget = JSON.stringify(candidates[0]).length + 5;
    const result = composeJevRerank({
      candidates,
      judgments: { items: [judgment(0.9), judgment(0.8), judgment(0.7)] },
      config: { threshold: 0, minimumShortlist: 1, maximumShortlist: 2, contextBudgetChars: budget },
    });
    expect((result.selectedCandidates as unknown[]).length).toBe(1);
    expect((result.excludedCandidates as Array<Record<string, unknown>>).every((entry) => entry.included === false)).toBe(true);
  });

  test("reports historical recall, reduction, requests, latency and cost", () => {
    const result = composeJevRerank({
      candidates: [candidate("selected", 1), candidate("noise", 2)],
      knownSelectedIds: ["selected"],
      judgments: { items: [judgment(0.9), judgment(0.1)] },
      config: { threshold: 0.5, minimumShortlist: 1, maximumShortlist: 1, contextBudgetChars: 10_000 },
    });
    expect(result.metrics).toMatchObject({
      selectedStoryRecall: 1,
      candidateReduction: 0.5,
      requestCount: 2,
      inputTokens: 20,
      outputTokens: 4,
      cost: 0.002,
      modelLatencyMs: 50,
      fallbacks: 0,
      errors: 0,
    });
  });

  test("handles empty candidate input without model results", () => {
    expect(composeJevRerank({ candidates: [], judgments: { items: [] } })).toMatchObject({
      mode: "empty",
      selectedCandidates: [],
      rankings: [],
      metrics: { candidateCount: 0, candidateReduction: 0, requestCount: 0 },
    });
  });

  test.each([
    ["partial answers", { items: [judgment(0.9)] }],
    ["malformed answer", { items: [judgment(0.9), judgment(0.4, { answers: { relevance: { type: "noul", noul: "bad" } } })] }],
    ["service failure", { items: [judgment(0.9), { result: { shadowStatus: "error", answers: {}, error: "timeout" } }] }],
  ])("fails open and restores original order for %s", (_label, judgments) => {
    const candidates = [candidate("a", 1), candidate("b", 2)];
    const result = composeJevRerank({ candidates, judgments });
    expect(result).toMatchObject({ mode: "full_set_fallback", fallback: true, selectedCandidates: candidates });
    expect((result.rankings as Array<Record<string, unknown>>).map((entry) => entry.candidateId)).toEqual(["a", "b"]);
    expect((result.rankings as Array<Record<string, unknown>>).every((entry) => entry.fallback === true)).toBe(true);
    expect(result.metrics).toMatchObject({ fallbacks: 1 });
  });

  test("preserves valid raw Jev telemetry when an incomplete batch forces fallback", () => {
    const result = composeJevRerank({
      candidates: [candidate("a", 1), candidate("b", 2)],
      judgments: { items: [judgment(0.73)] },
    });
    expect((result.rankings as Array<Record<string, unknown>>)[0]).toMatchObject({ probability: 0.73, cost: 0.001, latencyMs: 25, fallback: true });
    expect(result.metrics).toMatchObject({ errors: 1, fallbacks: 1 });
  });
});
