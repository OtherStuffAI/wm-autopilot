import type { FunctionRegistry } from "./declarative";
import type { JsonObject } from "./pipeline-store";
import { BIRD_LIMITS, birdArgv, executeBird } from "./bird-adapter";
import type { BirdAction, BirdExecutor, BirdOperation } from "./bird-adapter";

const operations = ["following", "for_you", "user_tweets", "search", "mentions"];
const choices = [...operations, "continue", "partial", "clarify"];
const candidateChoices = ["none", "c0", "c1", "c2", "c3"];
type Verdict = "running" | "complete" | "partial" | "needs_clarification" | "blocked";
interface RetrievalState {
  request: string; count: number; handles: string[]; queries: string[];
  startedAt: number; attempt: number; modelCalls: number; verdict: Verdict; reason: string;
  active: boolean; semanticNeeded: boolean; source: BirdOperation | null; handle: string | null; query: string | null;
  cursor: string | null; actions: string[]; tweets: JsonObject[]; evidence: JsonObject[]; usage: JsonObject[];
  latencyMs: number; resultCount: number;
}
function json(state: RetrievalState): JsonObject { return state as unknown as JsonObject; }
function stateOf(input: JsonObject): RetrievalState { return input.state as unknown as RetrievalState; }
function stop(state: RetrievalState, verdict: Verdict, reason: string): JsonObject {
  state.verdict = verdict; state.reason = reason; state.active = false; state.semanticNeeded = false;
  state.resultCount = state.tweets.length; state.latencyMs = Date.now() - state.startedAt;
  return json(state);
}
function requestWithoutArguments(request: string): string {
  return request.replace(/https?:\/\/\S+|@[A-Za-z0-9_]+|"[^"]*"|“[^”]*”|'[^']*'/g, "");
}
export function prepareBirdRetrieval(input: JsonObject): JsonObject {
  const request = typeof input.request === "string" ? input.request.trim() : "";
  const handles = [...new Set([...request.matchAll(/(?:@|https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)].map(m => m[1]!))];
  const queries = [...request.matchAll(/"([^"\n]{1,500})"|“([^”\n]{1,500})”|'([^'\n]{1,500})'/g)].map(m => (m[1] ?? m[2] ?? m[3])!);
  const countText = requestWithoutArguments(request);
  const counts = [...countText.matchAll(/(?<![A-Za-z0-9_])[-+]?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g)].map(m => Number(m[0]));
  const state: RetrievalState = { request, count: counts[0] ?? 20, handles, queries, startedAt: Date.now(), attempt: 0, modelCalls: 0, verdict: "running", reason: "", active: true, semanticNeeded: false, source: null, handle: null, query: null, cursor: null, actions: [], tweets: [], evidence: [], usage: [], latencyMs: 0, resultCount: 0 };
  if (/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/i.test(countText) || !request || request.length > BIRD_LIMITS.requestChars || counts.length > 1 || !Number.isInteger(state.count) || state.count < 1 || state.count > 100 || handles.length > 4 || queries.length > 4) return stop(state, "needs_clarification", "Specify one source, a count from 1 to 100, and at most four handle/query candidates.");
  const sourceRequest = requestWithoutArguments(request);
  if (/\b(?:timeline|latest|last|recent|home|feed)\b/i.test(sourceRequest)
    && !/\bfollowing\b|\bfor you\b|\bmentions\b|\bsearch\b/i.test(sourceRequest) && !handles.length && !queries.length) {
    return stop(state, "needs_clarification", "Would you like your Following feed or your For You feed?");
  }
  return json(state);
}
function probability(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function choice(answer: unknown, allowed: string[], enforceConfidence = true): string {
  const a = answer as Record<string, unknown> | null;
  if (!a || a.type !== "choice" || typeof a.choice !== "string" || !allowed.includes(a.choice) || !probability(a.confidence)) throw new Error("invalid_choice");
  const probabilities = a.probabilities as Record<string, unknown> | null;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) || Object.keys(probabilities).length !== allowed.length || allowed.some(key => !probability(probabilities[key]))) throw new Error("invalid_probabilities");
  if (Math.abs(Object.values(probabilities).reduce<number>((sum, p) => sum + Number(p), 0) - 1) > 0.02) throw new Error("invalid_probability_sum");
  if (enforceConfidence && (a.confidence < 0.75 || Number(probabilities[a.choice]) < 0.8)) throw new Error("uncertain_choice");
  return a.choice;
}
function noul(answer: unknown): number {
  const a = answer as Record<string, unknown> | null;
  if (!a || a.type !== "noul" || !probability(a.noul)) throw new Error("invalid_noul");
  return a.noul;
}
function recordDecision(state: RetrievalState, raw: unknown, ids: string[]): Record<string, unknown> {
  state.modelCalls += 1;
  const d = raw as Record<string, unknown> | null;
  state.usage.push({ usage: d?.usage ?? null, latencyMs: d?.latencyMs ?? null, model: d?.model ?? null, error: d?.error ?? null } as JsonObject);
  if (!d || d.shadowStatus !== "ok" || d.advisoryOnly !== true || d.authoritative !== false || d.error != null) throw new Error("decision_error");
  const answers = d.answers as Record<string, unknown> | null;
  if (!answers || Object.keys(answers).length !== ids.length || ids.some(id => !(id in answers))) throw new Error("missing_or_unexpected_decision");
  return answers;
}
function selected(value: string, candidates: string[]): string | null {
  if (value === "none") return null;
  const candidate = candidates[Number(value.slice(1))];
  if (!candidate) throw new Error("missing_candidate");
  return candidate;
}
function budget(state: RetrievalState): boolean { return state.attempt < BIRD_LIMITS.executions && state.modelCalls < BIRD_LIMITS.modelRequests && Date.now() - state.startedAt < BIRD_LIMITS.elapsedMs; }

export async function executeBirdDecision(input: JsonObject, executor: BirdExecutor = executeBird): Promise<JsonObject> {
  const state = stateOf(input);
  if (!state.active) return json(state);
  let action: BirdAction;
  try {
    const answers = recordDecision(state, input.decision, ["action", "handle", "query", "supported"]);
    if (state.attempt >= BIRD_LIMITS.executions || state.modelCalls > BIRD_LIMITS.modelRequests || Date.now() - state.startedAt >= BIRD_LIMITS.elapsedMs) return stop(state, state.tweets.length ? "partial" : "blocked", "budget_exhausted");
    // Validate every expected question before applying branch-specific uncertainty policy.
    choice(answers.action, choices, false);
    choice(answers.handle, candidateChoices, false);
    choice(answers.query, candidateChoices, false);
    const supported = noul(answers.supported);
    const operation = choice(answers.action, choices);
    const source = state.source ?? operation;
    const h = ["user_tweets", "mentions"].includes(source) ? choice(answers.handle, candidateChoices) : "none";
    const q = source === "search" ? choice(answers.query, candidateChoices) : "none";
    if (operation === "clarify" || supported < 0.9) return stop(state, "needs_clarification", "Specify an unambiguous supported source and required handle or quoted search query; extra filters are unsupported.");
    if (operation === "partial") return stop(state, state.tweets.length ? "partial" : "blocked", "model_stopped");
    if (state.source) {
      if (operation !== "continue" || !state.cursor) throw new Error("source_change_or_invalid_continuation");
      if (selected(h, state.handles) !== state.handle || selected(q, state.queries) !== state.query) throw new Error("argument_change");
    } else {
      if (!operations.includes(operation)) throw new Error("invalid_initial_action");
      state.source = operation as BirdOperation;
      state.handle = selected(h, state.handles); state.query = selected(q, state.queries);
      if (state.source === "user_tweets" && !state.handle || state.source === "search" && !state.query) return stop(state, "needs_clarification", "Provide @handle/profile URL for user tweets, or a quoted query for search.");
      if (["following", "for_you"].includes(state.source) && (state.handle || state.query) || state.source === "user_tweets" && state.query || state.source === "search" && state.handle || state.source === "mentions" && state.query) throw new Error("unexpected_arguments");
      // Explicit feed words cannot be redirected by advisory decisions.
      const sourceRequest = requestWithoutArguments(state.request);
      if (/\bfollowing\b/i.test(sourceRequest) && state.source !== "following" || /\bfor you\b/i.test(sourceRequest) && state.source !== "for_you") throw new Error("requested_source_mismatch");
    }
    action = { operation: state.source!, count: state.count - state.tweets.length, ...(state.handle ? { handle: state.handle } : {}), ...(state.query ? { query: state.query } : {}), ...(state.cursor ? { cursor: state.cursor } : {}) };
    birdArgv(action);
    const fingerprint = JSON.stringify(action);
    if (state.actions.includes(fingerprint)) return stop(state, state.tweets.length ? "partial" : "blocked", "repeated_action");
    state.actions.push(fingerprint);
  } catch (error) { return stop(state, error instanceof Error && error.message === "uncertain_choice" ? "needs_clarification" : "blocked", error instanceof Error ? error.message : "invalid_decision"); }
  state.attempt += 1;
  const startedAt = Date.now();
  try {
    const page = await executor(action, Math.min(BIRD_LIMITS.cliTimeoutMs, BIRD_LIMITS.elapsedMs - (Date.now() - state.startedAt)));
    const seen = new Set(state.tweets.map(tweet => tweet.id));
    const newTweets = page.tweets.filter(tweet => { if (seen.has(tweet.id)) return false; seen.add(tweet.id); return true; });
    state.tweets.push(...newTweets.slice(0, state.count - state.tweets.length));
    state.evidence.push({ action: action as unknown as JsonObject, tweets: page.tweets, cursor: page.cursor, latencyMs: Date.now() - startedAt, added: newTweets.length });
    const previousCursor = state.cursor;
    state.cursor = page.cursor;
    state.resultCount = state.tweets.length; state.latencyMs = Date.now() - state.startedAt;
    if (Date.now() - state.startedAt >= BIRD_LIMITS.elapsedMs) return stop(state, state.tweets.length ? "partial" : "blocked", "elapsed_limit");
    if (state.tweets.length >= state.count) return stop(state, "complete", "requested_count_retrieved");
    if (!newTweets.length || previousCursor !== null && previousCursor === page.cursor) return stop(state, "partial", "no_progress");
    if (!page.cursor || !["user_tweets", "search"].includes(state.source!)) return stop(state, "partial", "source_exhausted_or_no_cursor");
    if (!budget(state)) return stop(state, "partial", "budget_exhausted");
    state.semanticNeeded = true;
    return json(state);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "cli_failed";
    state.evidence.push({ action: action as unknown as JsonObject, error: reason, latencyMs: Date.now() - startedAt });
    return stop(state, state.tweets.length ? "partial" : "blocked", reason);
  }
}
export function checkBirdEvidence(input: JsonObject): JsonObject {
  const state = stateOf(input);
  if (!state.semanticNeeded) return json(state);
  try {
    const answers = recordDecision(state, input.decision, ["continueSafe"]);
    if (noul(answers.continueSafe) < 0.9) return stop(state, "partial", "semantic_check_uncertain_or_failed");
    state.semanticNeeded = false;
    if (!budget(state)) return stop(state, "partial", "budget_exhausted");
    return json(state);
  } catch (error) { return stop(state, "partial", error instanceof Error ? error.message : "invalid_evidence_decision"); }
}
export function birdModelState(input: JsonObject): JsonObject {
  const state = stateOf(input);
  if (!budget(state) || Date.now() - state.startedAt > BIRD_LIMITS.elapsedMs - 1_100) { stop(state, state.tweets.length ? "partial" : "blocked", "budget_exhausted"); }
  // Tweet text is intentionally absent from action control. Preserve it in results/evidence only.
  return { phase: state.source ? "continuation" : "initial", request: state.request, count: state.count, handles: state.handles, queries: state.queries, source: state.source, handle: state.handle, query: state.query, resultCount: state.tweets.length, attempt: state.attempt, hasCursor: !!state.cursor, active: state.active, remainingMs: Math.max(1, Math.min(10_000, BIRD_LIMITS.elapsedMs - (Date.now() - state.startedAt))) };
}
export function birdRetrievalFunctions(executor: BirdExecutor = executeBird): FunctionRegistry {
  return { "bird.prepare.v1": prepareBirdRetrieval, "bird.modelState.v1": birdModelState, "bird.executeDecision.v1": input => executeBirdDecision(input, executor), "bird.checkEvidence.v1": checkBirdEvidence };
}
