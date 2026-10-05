import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { birdCliQuestions, prepareBirdCli, resolveCliDecision, retrieveBirdCli } from "./bird-cli";
import { resolveCliFallback } from "./cli/interpreter";
import { formatBirdRetrieval } from "./bird-format";
import { PipelineStore } from "./pipeline-store";
import { runDeclarativePipeline } from "./pipeline-runner";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { builtinPipelineFunctions } from "./functions";
import type { DeclarativePipeline } from "./declarative";
import type { JsonObject } from "./pipeline-store";
import spec from "./default-definitions/bird.retrieve.v3.json";

const nativeFetch = globalThis.fetch;
const oldKey = process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY;
afterEach(() => { globalThis.fetch = nativeFetch; if (oldKey === undefined) delete process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY; else process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = oldKey; });
function decision(values: Record<string, string>, probability = 1): JsonObject {
  const answers = Object.fromEntries(Object.entries(birdCliQuestions).map(([id, question]) => {
    if (question.type === "noul") return [id, { type: "noul", noul: probability < .8 ? .5 : values[id] === "unsupported" ? 1 : 0 }];
    const criteria = (question as { criteria: Record<string, unknown> }).criteria;
    const keys = Object.keys(criteria); const selected = values[id] ?? (id === "count" ? "default" : id === "operation" ? "following" : id === "downstream" ? "none" : "none");
    return [id, { type: "choice", choice: selected, confidence: probability, probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? probability : (1 - probability) / (keys.length - 1)])) }];
  }));
  return { shadowStatus: "ok", error: null, answers, model: "fixture-jev", latencyMs: 4, usage: { cost: 0.0001 } };
}
function interpret(request: string, values: Record<string, string> = {}, probability = 1): JsonObject { return resolveCliDecision({ request, decision: decision(values, probability) }); }
const exact = (id: number) => ({ id: String(id), text: `Exact text ${id} <>& @user\nsecond line`, author: { username: "alice" } });

test("original live failure is the supported Noul gate, not source/count", async () => {
  const { prepareBirdRetrieval, executeBirdDecision } = await import("./bird-retrieval");
  const old = (selected: string, keys: string[]) => ({ type: "choice", choice: selected, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, Number(key === selected)])) });
  const state = prepareBirdRetrieval({ request: "can you please send me the top 20 following tweets" });
  let calls = 0;
  const rejected = await executeBirdDecision({ state, decision: { shadowStatus: "ok", error: null, authoritative: false, advisoryOnly: true, answers: { action: old("following", ["following", "for_you", "user_tweets", "search", "mentions", "continue", "partial", "clarify"]), handle: old("none", ["none", "c0", "c1", "c2", "c3"]), query: old("none", ["none", "c0", "c1", "c2", "c3"]), supported: { type: "noul", noul: 0.81 } } } }, async () => { calls++; return { tweets: [], cursor: null }; });
  expect(rejected).toMatchObject({ count: 20, verdict: "needs_clarification", attempt: 0 }); expect(calls).toBe(0);
});
for (const [request, operation, count, downstream] of [
  ["top 20 following tweets", "following", "c0", "top_unspecified"],
  ["latest 20 tweets", "default", "c0", "none"],
  ["20 For You tweets", "for_you", "c0", "none"],
  ["retrieve 100 following tweets then summarize into 10 points", "following", "c0", "summary"],
] as const) test(`argument roles: ${request}`, async () => {
  const interpretation = interpret(request, { operation, count, downstream, downstreamCount: downstream === "summary" ? "c1" : "none" });
  expect(interpretation.verdict).toBe("ready");
  const calls: unknown[] = [];
  const state = await retrieveBirdCli({ interpretation }, async action => { calls.push(action); return { tweets: Array.from({ length: action.count }, (_, i) => exact(i)), cursor: null }; });
  expect(calls).toEqual([{ operation: operation === "default" ? "following" : operation, count: downstream === "summary" ? 100 : 20 }]);
  expect(state.tweets).toEqual(Array.from({ length: downstream === "summary" ? 100 : 20 }, (_, i) => exact(i)));
  const formatted = formatBirdRetrieval({ state });
  if (operation === "default") expect(formatted.message).toContain("defaulted");
  if (downstream === "summary") { expect(formatted.message).toContain("output count 10"); expect(formatted.message).toContain("not been completed"); }
  if (downstream === "top_unspecified") expect(formatted.message).toContain("no separate ranking");
});
test("source pins, missing/unsupported, invalid candidates/count and routing metadata cannot invent argv", async () => {
  const prepared = prepareBirdCli({ request: "@[Piper](mention:agent:npub1routing123) latest 20 tweets" });
  expect(prepared.candidates).toMatchObject({ count: [{ value: 20 }], handle: [] });
  expect(interpret("20 For You tweets", { operation: "following", count: "c0" })).toMatchObject({ verdict: "needs_clarification", reason: "explicit_source_conflict" });
  expect(interpret("please post a tweet", { operation: "unsupported" })).toMatchObject({ verdict: "unsupported", selection: null });
  expect(interpret("hello", { operation: "missing" })).toMatchObject({ verdict: "needs_clarification", selection: null });
  expect(interpret("101 following tweets", { count: "c0" })).toMatchObject({ verdict: "needs_clarification", reason: "invalid_count" });
  const state = interpret("tweets from a user", { operation: "user_tweets", handle: "c7" });
  expect(state.verdict).toBe("fallback");
  const rejected = resolveCliFallback({ state, extraction: { status: "ready", operation: "user_tweets", intentSpan: "tweets", argumentSpans: { handle: "@invented" }, downstream: "none" } });
  expect(rejected).toMatchObject({ verdict: "needs_clarification", selection: null, modelCalls: 2 });
  let calls = 0; await retrieveBirdCli({ interpretation: rejected }, async () => { calls++; return { tweets: [], cursor: null }; }); expect(calls).toBe(0);
});
test("one fallback copies numeric evidence without rewrite/retry; exhausted extraction stops", () => {
  const request = "give me a score of tweets from my following feed";
  const state = interpret(request, {}, 0.5);
  const resolved = resolveCliFallback({ state, extraction: { status: "ready", operation: "following", intentSpan: "tweets from my following feed", argumentSpans: { count: "a score", downstreamCount: null, handle: null, query: null }, downstream: "none" } });
  expect(resolved).toMatchObject({ verdict: "ready", selection: { args: { count: 20 } }, modelCalls: 2 });
  const invalid = resolveCliFallback({ state: interpret(request, {}, 0.5), extraction: {} });
  expect(invalid).toMatchObject({ verdict: "needs_clarification", selection: null });
  expect(resolveCliFallback({ state: invalid, extraction: {} }).modelCalls).toBe(2);
});
test("bounded paging preserves exact records and stops repeated cursor and CLI errors", async () => {
  let calls = 0;
  const state = await retrieveBirdCli({ interpretation: interpret('search "bitcoin" for 5 tweets', { operation: "search", query: "c0", count: "c0" }) }, async () => { calls++; return { tweets: [exact(calls)], cursor: "same" }; });
  expect(calls).toBe(2); expect(state).toMatchObject({ verdict: "partial", resultCount: 2 });
  calls = 0;
  const failed = await retrieveBirdCli({ interpretation: interpret("following tweets") }, async () => { calls++; throw new Error("cli_authentication"); });
  expect(calls).toBe(1); expect(failed).toMatchObject({ verdict: "blocked", reason: "cli_authentication" });
});
test("real v3 pipeline batches roles in one Jev call, uses zero preliminary LLMs and hot loads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bird-cli-"));
  const store = new PipelineStore(join(dir, "runs.sqlite"));
  process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = "fixture-only";
  const requests: JsonObject[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { expect(url).toContain("decisions"); const body = JSON.parse(String(init.body)); requests.push(body); return Response.json({ answers: decision({ count: "c0", downstream: "top_unspecified" }).answers, model: "fixture-jev", usage: { cost: 0.0001 } }); }) as typeof fetch;
  try {
    const loaded = await loadPipelineFunctionRegistry(null, builtinPipelineFunctions);
    const run = await runDeclarativePipeline({ store, definition: { id: "fixture", slug: spec.name, name: spec.name, scope: "shared", ownerAlias: null, path: "fixture", spec: spec as DeclarativePipeline }, registry: { ...loaded.registry, "bird.retrieveCli.v1": input => retrieveBirdCli(input, async action => ({ tweets: Array.from({ length: action.count }, (_, i) => exact(i)), cursor: null })) }, input: { request: "top 20 following tweets" }, ownerNpub: "npub1fixture", ownerAlias: null, sessionApiContext: {} as never, callbackOrigin: "http://fixture" });
    expect(run.status).toBe("ok"); expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions as JsonObject)).toHaveLength(7);
    expect(JSON.stringify(requests)).not.toContain("fixture-only");
    expect(run.result?.retrieval).toMatchObject({ verdict: "complete", count: 20, modelCalls: 1 });
    expect(loaded.records.filter(record => record.name.includes("Cli")).every(record => record.status === "ok" && record.hash)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fallback cannot discard unsupported constraints or invent downstream quantity", () => {
  const state = interpret("retrieve following tweets with at least 50 likes", {}, 0.5);
  expect(resolveCliFallback({ state, extraction: { status: "ready", operation: "following", downstream: "unsupported" } })).toMatchObject({ verdict: "unsupported", selection: null });
  const invalid = resolveCliFallback({ state: interpret("retrieve 100 following tweets and summarize into 10", {}, 0.5), extraction: { status: "ready", operation: "following", intentSpan: "following tweets", argumentSpans: { count: "100", downstreamCount: "101" }, downstream: "summary" } });
  expect(invalid).toMatchObject({ verdict: "needs_clarification", selection: null });
});
test("registered contract interpretation is reusable outside Bird and need not expose a downstream count", async () => {
  const { registerCliContract } = await import("./cli/contract");
  const { prepareCliInterpretation, resolveCliDecision: resolve, cliQuestions } = await import("./cli/interpreter");
  const contract = { id: "fixture.files.v1", readOnly: true as const, operations: { list: "List file metadata" }, arguments: { limit: { kind: "number" as const, description: "Number of metadata records to list", default: 10, min: 1, max: 100 } }, required: { list: ["limit"] }, applicable: { list: ["limit"] }, defaultOperation: "list", policy: "Read-only file metadata listing", explicitSources: {}, argv: (_operation: string, args: Record<string, string | number>) => ["fixture", "list", "--limit", String(args.limit)] };
  registerCliContract(contract);
  const state = prepareCliInterpretation({ contractId: contract.id, request: "list 4 file records" });
  const answers = Object.fromEntries(Object.entries(cliQuestions(contract)).map(([id, q]) => { if (q.type === "noul") return [id, { type: "noul", noul: 0 }]; const keys = Object.keys((q as { criteria: object }).criteria); const value = id === "operation" ? "list" : id === "limit" ? "c0" : "none"; return [id, { type: "choice", choice: value, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, Number(key === value)])) }]; }));
  expect(resolve({ state, decision: { shadowStatus: "ok", error: null, answers } })).toMatchObject({ verdict: "ready", selection: { operation: "list", args: { limit: 4 } } });
});
test("extraction fallback is exactly one inference call and validates before CLI execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bird-fallback-")); const store = new PipelineStore(join(dir, "runs.sqlite"));
  process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = "fixture-only"; let requests = 0; let executed = 0;
  globalThis.fetch = (async (url: string) => { requests++; if (url.includes("decisions")) return Response.json({ answers: decision({}, .5).answers, model: "fixture-jev", usage: {} }); return Response.json({ choices: [{ message: { content: JSON.stringify({ status: "ready", operation: "following", intentSpan: "following feed", argumentSpans: { count: "a score" }, downstream: "none" }) } }] }); }) as typeof fetch;
  try {
    const loaded = await loadPipelineFunctionRegistry(null, builtinPipelineFunctions);
    const run = await runDeclarativePipeline({ store, definition: { id: "fixture", slug: spec.name, name: spec.name, scope: "shared", ownerAlias: null, path: "fixture", spec: spec as DeclarativePipeline }, registry: { ...loaded.registry, "bird.retrieveCli.v1": input => retrieveBirdCli(input, async action => { executed++; expect(action.count).toBe(20); return { tweets: [], cursor: null }; }) }, input: { request: "give me a score of tweets from my following feed" }, ownerNpub: "npub1fixture", ownerAlias: null, sessionApiContext: {} as never, callbackOrigin: "http://fixture" });
    expect(run.status).toBe("ok"); expect(requests).toBe(2); expect(executed).toBe(1); expect(run.result?.retrieval).toMatchObject({ modelCalls: 2, count: 20 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fallback locates an unquoted complex search span, preserving the literal query argv", async () => {
  const request = "Search for posts about small businesses adopting AI and get 20 results";
  const state = interpret(request, { operation: "search", query: "none", count: "c0" });
  expect(state.verdict).toBe("fallback");
  const extraction = { status: "ready", operation: "search", intentSpan: "Search for posts", argumentSpans: { count: "20", query: "small businesses adopting AI" }, downstream: "none" };
  let action: unknown;
  const result = await retrieveBirdCli({ interpretation: state, extraction }, async selected => { action = selected; return { tweets: [exact(1)], cursor: null }; });
  expect(action).toEqual({ operation: "search", count: 20, query: "small businesses adopting AI" });
  expect(result).toMatchObject({ verdict: "partial", modelCalls: 2 });
  expect((result.evidence as JsonObject[])[0]!.argv).toEqual(["bird", "--timeout", "10000", "--cookie-timeout", "3000", "search", "--all", "--max-pages", "1", "--count", "20", "--json", "--", "small businesses adopting AI"]);
  expect(resolveCliFallback({ state: interpret(request, {}, .5), extraction: { ...extraction, argumentSpans: { count: "20", query: "small businesses adopting AI -recruitment" } } })).toMatchObject({ verdict: "needs_clarification", selection: null });
  expect(resolveCliFallback({ state: interpret(request, {}, .5), extraction: { ...extraction, argumentSpans: { count: "20", secret: "AI" } } })).toMatchObject({ verdict: "needs_clarification", selection: null });
});

test("fallback rejects array-valued enums instead of coercing them into CLI arguments", () => {
  const request = "search for small businesses adopting AI and get 20 results";
  expect(resolveCliFallback({ state: interpret(request, {}, .5), extraction: { status: "ready", operation: ["search"], intentSpan: "search", argumentSpans: { count: "20", query: "small businesses adopting AI" }, downstream: ["none"] } })).toMatchObject({ verdict: "needs_clarification", selection: null });
});

test("v3 authentication failures remain concrete user-facing blockers", async () => {
  const state = await retrieveBirdCli({ interpretation: interpret("following tweets") }, async () => { throw new Error("cli_authentication"); });
  expect(formatBirdRetrieval({ state }).message).toContain("account authentication needs attention");
});
