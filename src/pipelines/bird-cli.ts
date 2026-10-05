import type { JsonObject } from "./pipeline-store";
import { BIRD_LIMITS, birdArgv, executeBird } from "./bird-adapter";
import type { BirdAction, BirdExecutor, BirdOperation } from "./bird-adapter";
import { cliContract, registerCliContract } from "./cli/contract";
import type { CliInterpretation } from "./cli/contract";
import { cliQuestions, prepareCliInterpretation, resolveCliDecision as resolveDecision, resolveCliFallback, validateCliSelection } from "./cli/interpreter";

registerCliContract({
  id: "bird.read.v1", readOnly: true,
  operations: { following: "Following feed (chronological)", for_you: "Explicit For You recommendation feed", user_tweets: "Tweets from one specified handle/profile", search: "Search for one specified query: quoted candidates directly, unquoted words via one evidence-span extraction fallback", mentions: "Mentions of current account or one handle" },
  arguments: {
    count: { kind: "number", description: "Number of tweets to RETRIEVE, not number of summary items, days, dates, likes or ranked results. If only top N tweets is requested, N is retrieval count.", default: 20, min: 1, max: 100 },
    handle: { kind: "handle", description: "Account whose tweets or mentions should be retrieved, excluding agent routing mentions" },
    query: { kind: "query", description: "Search query content: use exact quoted candidates in the Jev pass, or a verbatim span of explicitly requested unquoted query words in fallback" },
    downstreamCount: { kind: "number", description: "Number of summary items/output results requested AFTER retrieval, such as summarize 100 retrieved tweets into 10 points. Not the retrieval count.", min: 1, max: 100 },
  },
  required: { following: ["count"], for_you: ["count"], user_tweets: ["count", "handle"], search: ["count", "query"], mentions: ["count"] },
  applicable: { following: ["count"], for_you: ["count"], user_tweets: ["count", "handle"], search: ["count", "query"], mentions: ["count", "handle"] },
  defaultOperation: "following", policy: "Explicit Following or For You must win. Unspecified timeline/tweets/latest/feed retrieval defaults to Following with disclosure. Retrieval and downstream summary/ranking are distinct. A truly omitted user-tweets handle or search query needs clarification. A specified but unquoted search query requires the extraction fallback, not clarification. No writes, date filters, extra filtering, summary or metric ranking supported.",
  explicitSources: { following: "\\bfollowing\\b", for_you: "\\bfor[ -]you\\b" },
  argv: (operation, args) => birdArgv({ operation: operation as BirdOperation, ...args } as BirdAction),
});
export const birdCliQuestions = cliQuestions(cliContract("bird.read.v1"));
export function prepareBirdCli(input: JsonObject): JsonObject {
  return prepareCliInterpretation({ request: input.request, threadContext: input.threadContext, contractId: "bird.read.v1" });
}
export { resolveCliFallback };
export function resolveCliDecision(input: JsonObject): JsonObject {
  const state = prepareBirdCli({ request: input.request, threadContext: input.threadContext });
  const latency = (input.decision as JsonObject | undefined)?.latencyMs;
  if (typeof latency === "number" && Number.isFinite(latency)) state.startedAt = Number(state.startedAt) - latency;
  return resolveDecision({ state, decision: input.decision });
}
export async function retrieveBirdCli(input: JsonObject, executor: BirdExecutor = executeBird): Promise<JsonObject> {
  let interpretation = input.interpretation as unknown as CliInterpretation;
  if (interpretation.verdict === "fallback") interpretation = resolveCliFallback({ state: input.interpretation, extraction: input.extraction }) as unknown as CliInterpretation;
  const state: JsonObject = { request: interpretation.request, count: 0, tweets: [], evidence: [], source: null, verdict: interpretation.verdict, reason: interpretation.reason, resultCount: 0, attempt: 0, modelCalls: interpretation.modelCalls, usage: interpretation.usage, disclosures: interpretation.disclosures, interpretation: interpretation as unknown as JsonObject, latencyMs: Date.now() - interpretation.startedAt };
  if (interpretation.verdict !== "ready" || !interpretation.selection) return state;
  try { validateCliSelection(interpretation, interpretation.selection); } catch (error) { state.verdict = "blocked"; state.reason = error instanceof Error ? error.message : "invalid_selection"; return state; }
  const selection = interpretation.selection;
  const action = { operation: selection.operation as BirdOperation, ...selection.args } as BirdAction;
  state.source = action.operation; state.count = action.count;
  if (selection.downstream === "top_unspecified") interpretation.disclosures.push("Returning tweets in the selected source's order; no separate ranking metric was specified or applied.");
  if (["summary", "ranking", "summary_ranking"].includes(selection.downstream)) interpretation.disclosures.push(`Requested downstream stage (${selection.downstream}${selection.downstreamCount ? `; output count ${selection.downstreamCount}` : ""}) is unsupported. Retrieval only; that stage has not been completed.`);
  const tweets: JsonObject[] = []; const evidence: JsonObject[] = []; const seen = new Set<string>(); const cursors = new Set<string>();
  for (let attempt = 0; attempt < BIRD_LIMITS.executions; attempt++) {
    const remainingMs = BIRD_LIMITS.elapsedMs - (Date.now() - interpretation.startedAt);
    if (remainingMs <= 0) { state.verdict = tweets.length ? "partial" : "blocked"; state.reason = "elapsed_limit"; break; }
    state.attempt = attempt + 1;
    const pageAction = { ...action, count: action.count - tweets.length };
    const startedAt = Date.now();
    try {
      const page = await executor(pageAction, Math.min(BIRD_LIMITS.cliTimeoutMs, remainingMs));
      const added = page.tweets.filter(tweet => { const id = String(tweet.id); if (seen.has(id)) return false; seen.add(id); return true; });
      tweets.push(...added.slice(0, action.count - tweets.length));
      evidence.push({ argv: birdArgv(pageAction), tweets: page.tweets, cursor: page.cursor, latencyMs: Date.now() - startedAt });
      if (tweets.length >= action.count) { state.verdict = "complete"; state.reason = "requested_count_retrieved"; break; }
      state.verdict = "partial"; state.reason = "source_exhausted_or_no_progress";
      if (!added.length || !page.cursor || cursors.has(page.cursor) || !["search", "user_tweets"].includes(action.operation)) break;
      cursors.add(page.cursor); action.cursor = page.cursor;
      state.reason = "execution_limit";
    } catch (error) { state.verdict = tweets.length ? "partial" : "blocked"; state.reason = error instanceof Error ? error.message : "cli_failed"; evidence.push({ error: state.reason, latencyMs: Date.now() - startedAt }); break; }
  }
  state.tweets = tweets; state.evidence = evidence; state.resultCount = tweets.length; state.latencyMs = Date.now() - interpretation.startedAt;
  return state;
}
