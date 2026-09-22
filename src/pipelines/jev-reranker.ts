import type { JsonObject } from "./pipeline-store";

interface RankedCandidate {
  candidate: JsonObject;
  candidateId: string;
  originalRank: number;
  originalIndex: number;
  probability: number;
  judgment: JsonObject;
  estimatedChars: number;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MINIMUM = 1;
const DEFAULT_MAXIMUM = 20;
const DEFAULT_CONTEXT_BUDGET = 24_000;

export function composeJevRerank(input: JsonObject): JsonObject {
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.filter(isJsonObject)
    : [];
  const judgments = isJsonObject(input.judgments) && Array.isArray(input.judgments.items)
    ? input.judgments.items
    : [];
  const config = isJsonObject(input.config) ? input.config : {};
  const threshold = boundedNumber(config.threshold, DEFAULT_THRESHOLD, 0, 1);
  const minimumShortlist = nonNegativeInteger(config.minimumShortlist, DEFAULT_MINIMUM);
  const maximumShortlist = Math.max(minimumShortlist, positiveInteger(config.maximumShortlist, DEFAULT_MAXIMUM));
  const contextBudgetChars = positiveInteger(config.contextBudgetChars, DEFAULT_CONTEXT_BUDGET);
  const startedAt = Date.now();
  const knownSelectedIds = Array.isArray(input.knownSelectedIds) ? input.knownSelectedIds.map(String) : [];

  if (candidates.length === 0) {
    return buildResult({
      mode: "empty",
      reason: "no_candidates",
      candidates,
      rankings: [],
      selected: [],
      warnings: [],
      threshold,
      minimumShortlist,
      maximumShortlist,
      contextBudgetChars,
      judgments: input.judgments,
      knownSelectedIds,
      composeLatencyMs: Date.now() - startedAt,
    });
  }

  const validation = validateJudgments(candidates, judgments);
  if (!validation.ok) {
    return buildFailOpenResult({
      candidates,
      judgments: input.judgments,
      knownSelectedIds,
      reason: validation.reason,
      warning: validation.warning,
      threshold,
      minimumShortlist,
      maximumShortlist,
      contextBudgetChars,
      composeLatencyMs: Date.now() - startedAt,
    });
  }

  const ranked: RankedCandidate[] = candidates.map((candidate, originalIndex) => {
    const result = asObject(asObject(judgments[originalIndex]).result);
    const answer = asObject(asObject(result.answers).relevance);
    return {
      candidate,
      candidateId: candidateId(candidate, originalIndex),
      originalRank: positiveInteger(candidate.originalRank, originalIndex + 1),
      originalIndex,
      probability: Number(answer.noul),
      judgment: result,
      estimatedChars: JSON.stringify(candidate).length,
    };
  }).sort((left, right) => right.probability - left.probability || left.originalRank - right.originalRank || left.originalIndex - right.originalIndex);

  const thresholdEligible = ranked.filter((entry) => entry.probability >= threshold);
  const minimumCount = Math.min(ranked.length, minimumShortlist);
  const wanted = new Set(ranked.slice(0, minimumCount).map((entry) => entry.originalIndex));
  thresholdEligible.slice(0, maximumShortlist).forEach((entry) => wanted.add(entry.originalIndex));

  const selectedIndexes = new Set<number>();
  let usedChars = 0;
  for (const entry of ranked) {
    if (!wanted.has(entry.originalIndex) || selectedIndexes.size >= maximumShortlist) continue;
    const requiredForMinimum = selectedIndexes.size < minimumCount;
    if (!requiredForMinimum && usedChars + entry.estimatedChars > contextBudgetChars) continue;
    selectedIndexes.add(entry.originalIndex);
    usedChars += entry.estimatedChars;
  }

  const rankings = ranked.map((entry, rerankedIndex) => ({
    candidateId: entry.candidateId,
    originalRank: entry.originalRank,
    rerankedRank: rerankedIndex + 1,
    included: selectedIndexes.has(entry.originalIndex),
    exclusionReason: selectedIndexes.has(entry.originalIndex)
      ? null
      : entry.probability < threshold && rerankedIndex >= minimumCount
        ? "below_threshold"
        : selectedIndexes.size >= maximumShortlist && rerankedIndex >= maximumShortlist
          ? "maximum_shortlist"
          : "context_budget",
    probability: entry.probability,
    provenance: entry.candidate.provenance ?? entry.candidate.source ?? entry.candidate.url ?? null,
    estimatedChars: entry.estimatedChars,
    usage: entry.judgment.usage ?? null,
    cost: extractCost(entry.judgment),
    latencyMs: finiteNumber(entry.judgment.latencyMs),
    error: entry.judgment.error ?? null,
    fallback: false,
  }));
  const selected = ranked
    .filter((entry) => selectedIndexes.has(entry.originalIndex))
    .map((entry) => entry.candidate);

  return buildResult({
    mode: "jev_reranked",
    reason: "deterministic_policy",
    candidates,
    rankings,
    selected,
    warnings: usedChars > contextBudgetChars
      ? ["Minimum shortlist exceeds the configured context budget."]
      : [],
    threshold,
    minimumShortlist,
    maximumShortlist,
    contextBudgetChars,
    judgments: input.judgments,
    knownSelectedIds,
    composeLatencyMs: Date.now() - startedAt,
  });
}

function validateJudgments(candidates: JsonObject[], judgments: unknown[]): { ok: true } | { ok: false; reason: string; warning: string } {
  if (judgments.length !== candidates.length) {
    return { ok: false, reason: "incomplete_jev_results", warning: `Expected ${candidates.length} Jev results but received ${judgments.length}.` };
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const result = asObject(asObject(judgments[index]).result);
    const answer = asObject(asObject(result.answers).relevance);
    const probability = finiteNumber(answer.noul);
    if (result.shadowStatus !== "ok" || answer.type !== "noul" || probability === null || probability < 0 || probability > 1) {
      return {
        ok: false,
        reason: "malformed_or_failed_jev_result",
        warning: `Candidate ${candidateId(candidates[index]!, index)} did not receive a valid Jev Noul result.`,
      };
    }
  }
  return { ok: true };
}

function buildFailOpenResult(input: {
  candidates: JsonObject[];
  judgments: unknown;
  knownSelectedIds: string[];
  reason: string;
  warning: string;
  threshold: number;
  minimumShortlist: number;
  maximumShortlist: number;
  contextBudgetChars: number;
  composeLatencyMs: number;
}): JsonObject {
  const rankings = input.candidates.map((candidate, index) => ({
    ...fallbackRankingTelemetry(input.judgments, index),
    candidateId: candidateId(candidate, index),
    originalRank: positiveInteger(candidate.originalRank, index + 1),
    rerankedRank: index + 1,
    included: true,
    exclusionReason: null,
    provenance: candidate.provenance ?? candidate.source ?? candidate.url ?? null,
    estimatedChars: JSON.stringify(candidate).length,
    fallback: true,
  }));
  return buildResult({ ...input, mode: "full_set_fallback", rankings, selected: input.candidates, warnings: [input.warning] });
}

function buildResult(input: {
  mode: string;
  reason: string;
  candidates: JsonObject[];
  rankings: JsonObject[];
  selected: JsonObject[];
  warnings: string[];
  threshold: number;
  minimumShortlist: number;
  maximumShortlist: number;
  contextBudgetChars: number;
  judgments: unknown;
  knownSelectedIds: string[];
  composeLatencyMs: number;
}): JsonObject {
  const selectedIds = new Set(input.selected.map((candidate, index) => candidateId(candidate, index)));
  const knownSelectedIds = input.knownSelectedIds;
  const telemetry = aggregateTelemetry(input.judgments, input.candidates.length);
  return {
    mode: input.mode,
    reason: input.reason,
    fallback: input.mode === "full_set_fallback",
    originalCandidates: input.candidates,
    selectedCandidates: input.selected,
    excludedCandidates: input.rankings.filter((entry) => entry.included !== true),
    rankings: input.rankings,
    warnings: input.warnings,
    policy: {
      threshold: input.threshold,
      minimumShortlist: input.minimumShortlist,
      maximumShortlist: input.maximumShortlist,
      contextBudgetChars: input.contextBudgetChars,
    },
    metrics: {
      candidateCount: input.candidates.length,
      selectedCount: input.selected.length,
      candidateReduction: input.candidates.length === 0 ? 0 : 1 - input.selected.length / input.candidates.length,
      knownSelectedCount: knownSelectedIds.length,
      knownSelectedSurvived: knownSelectedIds.filter((id) => selectedIds.has(id)).length,
      selectedStoryRecall: knownSelectedIds.length === 0 ? null : knownSelectedIds.filter((id) => selectedIds.has(id)).length / knownSelectedIds.length,
      ...telemetry,
      errors: input.mode === "full_set_fallback" ? Math.max(1, Number(telemetry.errors ?? 0)) : telemetry.errors,
      fallbacks: input.mode === "full_set_fallback" ? 1 : 0,
      composeLatencyMs: input.composeLatencyMs,
    },
    judgments: input.judgments ?? null,
  };
}

function aggregateTelemetry(judgments: unknown, expectedCount: number): JsonObject {
  const items = isJsonObject(judgments) && Array.isArray(judgments.items) ? judgments.items : [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let latencyMs = 0;
  let maximumLatencyMs = 0;
  let errors = 0;
  for (const item of items) {
    const result = asObject(asObject(item).result);
    const usage = asObject(result.usage);
    inputTokens += finiteNumber(usage.input_tokens ?? usage.prompt_tokens) ?? 0;
    outputTokens += finiteNumber(usage.output_tokens ?? usage.completion_tokens) ?? 0;
    cost += extractCost(result) ?? 0;
    const itemLatencyMs = finiteNumber(result.latencyMs) ?? 0;
    latencyMs += itemLatencyMs;
    maximumLatencyMs = Math.max(maximumLatencyMs, itemLatencyMs);
    if (result.shadowStatus !== "ok") errors += 1;
  }
  return {
    requestCount: items.length,
    expectedRequestCount: expectedCount,
    inputTokens,
    outputTokens,
    cost,
    modelLatencyMs: latencyMs,
    maximumRequestLatencyMs: maximumLatencyMs,
    averageRequestLatencyMs: items.length === 0 ? 0 : latencyMs / items.length,
    errors,
    fallbacks: items.length !== expectedCount || errors > 0 ? 1 : 0,
  };
}

function fallbackRankingTelemetry(judgments: unknown, index: number): JsonObject {
  const items = isJsonObject(judgments) && Array.isArray(judgments.items) ? judgments.items : [];
  const result = asObject(asObject(items[index]).result);
  const answer = asObject(asObject(result.answers).relevance);
  const probability = answer.type === "noul" ? finiteNumber(answer.noul) : null;
  return {
    probability,
    usage: result.usage ?? null,
    cost: extractCost(result),
    latencyMs: finiteNumber(result.latencyMs),
    error: result.error ?? (probability === null ? "Missing or malformed Jev Noul result." : null),
  };
}

function extractCost(result: JsonObject): number | null {
  const usage = asObject(result.usage);
  return finiteNumber(usage.cost ?? result.cost);
}

function candidateId(candidate: JsonObject, index: number): string {
  const value = candidate.id ?? candidate.externalId ?? candidate.external_id ?? candidate.url;
  return typeof value === "string" && value.trim() ? value.trim() : `candidate-${index + 1}`;
}

function asObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.min(maximum, Math.max(minimum, number));
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.max(0, Math.trunc(number));
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = finiteNumber(value);
  return number === null || number <= 0 ? fallback : Math.trunc(number);
}
