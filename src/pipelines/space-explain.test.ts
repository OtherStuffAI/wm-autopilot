import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestAuthContext } from "../auth/request-context";
import { handlePipelineApi, type PipelineApiContext } from "./pipeline-api-routes";
import { PipelineStore } from "./pipeline-store";
import { spaceExplainRequest, validateExplainOutput, type SpaceExplainRequest } from "./space-explain-contract";
import { readExplainEvidence } from "./space-explain-evidence";
import { guardExplainFetch } from "./space-explain-fetch-guard";
import { SpaceExplainService } from "./space-explain-service";
import { SpaceExplainStore } from "./space-explain-store";
import { createExplainWorker, fetchBrokeredExplainGuide, type ExplainWorker } from "./space-explain-runtime";
import { readCachedExplainGuide } from "./space-explain-cache";
import { prepareExplainCache } from "../../clis/space-explain-cache";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { createHash } from "node:crypto";
import { Nip98ReplayCache, verifyNip98Request } from "../auth/nip98-verifier";
import { resolveNip98AuthContext } from "../auth/nip98-auth";

const base = "/api/pipelines/space-explain.v1";
const input: SpaceExplainRequest = { requestId: "10000000-0000-4000-8000-000000000001", conceptId: "moon",
  mode: "explain", style: "simple", question: "PRIVATE Why does the Moon orbit?", graphVersion: "2026-09-27.1", graphHash: "a".repeat(64),
  learnerHints: [{ conceptId: "moon", state: "viewed", views: 2 }] };
const guide = { version: input.graphVersion, contentHash: input.graphHash,
  focused: { concept: { id: "moon" }, connections: [], citations: [{
    source: { id: "nasa", title: "Moon facts", publisher: "NASA", url: "https://science.nasa.gov/moon/" },
    support: { sourceId: "nasa", targetType: "concept", targetId: "moon", locator: "Orbit", summary: "The Moon orbits Earth." },
  }] }, prerequisites: [], supporting: [], neighbours: [], notices: [], limits: { depth: 1, nodes: 13 } };
const evidence = readExplainEvidence(guide, input);
function output() {
  const { summary: _summary, publisher: _publisher, ...citation } = evidence.supports[0]!;
  return { status: "supported", claims: [{ text: "The Moon orbits Earth.", supportIds: [citation.supportId] }],
    inferences: [], unknowns: [], citations: [citation], suggestedConceptIds: ["moon"] };
}

let dir: string;
let store: SpaceExplainStore;
let ctx: PipelineApiContext;
let calls: number;
let worker: ExplainWorker;
let previousOrigins: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "space-explain-"));
  store = new SpaceExplainStore(join(dir, "private.sqlite"));
  calls = 0;
  worker = { async guide() { return guide; }, async generate() { calls++; return output(); } };
  ctx = { store: new PipelineStore(join(dir, "pipelines.sqlite")),
    spaceExplainService: new SpaceExplainService(store, () => worker),
    ensureApiAccess: async () => null, AccessActions: { SessionsManage: "sessions.manage" },
    sessionApiContext: {}, defaultAgent: "codex", sharedInstanceAccess: true } as unknown as PipelineApiContext;
  previousOrigins = process.env.SPACE_EXPLAIN_APP_ORIGINS;
  process.env.SPACE_EXPLAIN_APP_ORIGINS = "https://atlas.example";
});
afterEach(() => {
  store.close(); rmSync(dir, { recursive: true, force: true });
  if (previousOrigins === undefined) delete process.env.SPACE_EXPLAIN_APP_ORIGINS;
  else process.env.SPACE_EXPLAIN_APP_ORIGINS = previousOrigins;
});

function auth(owner: string): RequestAuthContext {
  return { authMethod: "nip98", npub: owner, signerNpub: owner, session: null,
    delegatedOwnerNpub: "npub1pete", targetOwnerNpub: "npub1pete" };
}
async function api(path: string, method = "GET", body?: unknown, owner = "npub1alice", overrides: Partial<RequestAuthContext> = {}, origin?: string) {
  const url = new URL(`https://autopilot.example${path}`);
  const request = new Request(url, { method, headers: { ...(origin ? { origin } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await handlePipelineApi(request, url, method as "GET" | "POST", { ...auth(owner), ...overrides }, ctx))!;
}
async function create() {
  const response = await api(`${base}/runs`, "POST", input);
  expect(response.status).toBe(202);
  return (await response.json()).run.id as string;
}
async function finished(id: string) {
  for (let n = 0; n < 50; n++) {
    const run = store.get("npub1alice", id)!;
    if (run.status !== "running") return run;
    await Bun.sleep(2);
  }
  throw new Error("Test worker did not finish");
}

test("private asynchronous run uses actual signer, bounded worker and validated response", async () => {
  const id = await create();
  expect((await finished(id)).status).toBe("completed");
  const response = await api(`${base}/runs/${id}/output`, "GET", undefined, "npub1alice", {}, "https://atlas.example");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe("https://atlas.example");
  expect((await response.json()).response.disclaimer).toContain("assessment evidence unchanged");
  expect(calls).toBe(1);
  expect(store.get("npub1pete", id)).toBeNull();
  expect(ctx.store.listRunSummaries({ ownerNpub: "npub1alice", includeShared: true })).toHaveLength(0);
});

test("retries while running and after database reopen reuse run; changed input conflicts", async () => {
  const id = await create();
  const replay = await api(`${base}/runs`, "POST", { ...input });
  expect(replay.status).toBe(200);
  expect((await replay.json()).run.id).toBe(id);
  await finished(id);
  store.close(); store = new SpaceExplainStore(join(dir, "private.sqlite"));
  ctx.spaceExplainService = new SpaceExplainService(store, () => worker);
  expect((await (await api(`${base}/runs`, "POST", input)).json()).run.id).toBe(id);
  expect((await api(`${base}/runs`, "POST", { ...input, question: "Changed" })).status).toBe(409);
  expect(calls).toBe(1);
  const bob = await api(`${base}/runs`, "POST", input, "npub1bob");
  expect(bob.status).toBe(202);
  await Bun.sleep(5);
});

test("cross-user read denied on every surface, including generic paths on shared instance", async () => {
  const id = await create(); await finished(id);
  for (const suffix of ["", "/output", "/steps", "/steps/child", "/events", "/callbacks", "/sessions"]) {
    expect((await api(`${base}/runs/${id}${suffix}`, "GET", undefined, "npub1bob")).status).toBe(404);
    expect((await api(`/api/pipelines/runs/${id}${suffix}`, "GET", undefined, "npub1bob")).status).toBe(404);
  }
  for (const suffix of ["/analysis-sessions", "/resume-from-failure", "/cancel", "/steps/child/callback"]) {
    expect((await api(`${base}/runs/${id}${suffix}`, "POST", {}, "npub1bob")).status).toBe(404);
  }
  expect((await api(`${base}/runs`)).status).toBe(404);
  expect((await api(`${base}/definition`)).status).toBe(404);
});

test("tampered owner, URL, authority, prompt, callbacks and raw answers are rejected", async () => {
  for (const key of ["ownerNpub", "learnerNpub", "towerUrl", "callbackUrl", "channelId", "threadId", "authority", "prompt", "answer", "assessmentAnswer"]) {
    expect((await api(`${base}/runs`, "POST", { ...input, [key]: "forbidden" })).status).toBe(400);
  }
  expect((await api(`${base}/runs`, "POST", input, "npub1alice", { authMethod: "session" })).status).toBe(401);
  expect((await api(`${base}/runs`, "POST", input, "npub1alice", { signerNpub: "npub1bob" })).status).toBe(401);
  expect((await api(`${base}/runs`, "POST", input, "npub1alice", {}, "https://evil.example")).status).toBe(403);
  expect((await api(`${base}/runs`, "OPTIONS", undefined, "", {}, "https://atlas.example")).status).toBe(204);
});

test("input bounds include mode, style, concept, question, hash and coarse hints", () => {
  for (const change of [{ question: "x".repeat(2001) }, { conceptId: "../overlay" }, { mode: "assessment" },
    { style: "arbitrary prompt" }, { graphHash: "unknown" }, { learnerHints: Array(7).fill(input.learnerHints![0]) },
    { learnerHints: [{ conceptId: "moon", state: "viewed", answer: "private" }] }]) {
    expect(spaceExplainRequest.safeParse({ ...input, ...change }).success).toBe(false);
  }
});

test("invalid citations, locator, target, support and concept fail validation", () => {
  for (const change of [{ url: "https://evil.example" }, { locator: "Invented" }, { targetId: "sun" }, { supportId: "fake" }]) {
    const raw = output(); raw.citations[0] = { ...raw.citations[0]!, ...change };
    expect(() => validateExplainOutput(raw, evidence, input)).toThrow("invalid_citation");
  }
  expect(() => validateExplainOutput({ ...output(), citations: [] }, evidence, input)).toThrow("invalid_citation");
  expect(() => validateExplainOutput({ ...output(), suggestedConceptIds: ["unknown"] }, evidence, input)).toThrow("invalid_concept");
  expect(() => validateExplainOutput({ ...output(), explanation: "uncited prose" }, evidence, input)).toThrow();
});

test("unsupported and partial responses have explicit labels and no fabricated claims", async () => {
  worker.generate = async () => ({ status: "no_supported_match", claims: [], inferences: [], citations: [],
    unknowns: ["The supplied Space guide does not support this question."], suggestedConceptIds: [] });
  const id = await create();
  expect(JSON.parse((await finished(id)).output_json!).status).toBe("no_supported_match");
  expect(() => validateExplainOutput({ ...output(), status: "no_supported_match" }, evidence, input)).toThrow();
  expect(() => validateExplainOutput({ ...output(), status: "partial" }, evidence, input)).toThrow("partial_without_labels");
  expect(validateExplainOutput({ ...output(), status: "partial", unknowns: ["Cause is not supported here."] }, evidence, input).status).toBe("partial");
  expect(validateExplainOutput({ ...output(), status: "supported", unknowns: ["Cause is not supported here."] }, evidence, input).status).toBe("partial");
});

test("missing support avoids model cost; mismatched graph and source failures surface", async () => {
  worker.guide = async () => ({ ...guide, focused: { ...guide.focused, citations: [] } });
  const id = await create(); expect((await finished(id)).status).toBe("completed"); expect(calls).toBe(0);
  expect(() => readExplainEvidence({ ...guide, contentHash: "b".repeat(64) }, input)).toThrow("graph_mismatch");
  expect(() => readExplainEvidence({ ...guide, notices: ["Source unavailable"] }, input)).toThrow("incomplete_evidence");
});

test("timeout aborts worker and replay cannot relaunch; private errors never persisted", async () => {
  let aborted = false;
  worker.generate = async (_input, _evidence, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error(input.question)); });
  });
  ctx.spaceExplainService = new SpaceExplainService(store, () => worker, 10);
  const id = await create(); const run = await finished(id);
  expect(run.error).toBe("timeout"); expect(aborted).toBe(true);
  expect((await api(`${base}/runs/${id}/output`)).status).toBe(409);
  expect((await api(`${base}/runs`, "POST", input)).status).toBe(200);
  expect(JSON.stringify(run)).not.toContain(input.question);
  expect(readFileSync(join(dir, "private.sqlite-wal")).includes(Buffer.from(input.question))).toBe(false);
});

test("provider errors and invalid output are redacted; no shared event/comment data", async () => {
  worker.generate = async () => { throw new Error(`provider echoed ${input.question}`); };
  const id = await create(); const run = await finished(id);
  expect(run.error).toBe("invalid_output");
  expect(JSON.stringify(run)).not.toContain("PRIVATE");
  expect(ctx.store.listEvents(id)).toHaveLength(0);
});

test("invalid model citations fail the run without exposing generated prose", async () => {
  worker.generate = async () => ({ ...output(), citations: [{ ...output().citations[0], locator: "Fabricated" }] });
  const id = await create(); const run = await finished(id);
  expect(run.status).toBe("error"); expect(run.error).toBe("invalid_citation"); expect(run.output_json).toBeNull();
});

test("one active run per owner and hourly budget bound cost while replays remain allowed", async () => {
  let release: (() => void) | undefined;
  worker.generate = async () => { await new Promise<void>(resolve => { release = resolve; }); return output(); };
  const id = await create(); await Bun.sleep(2);
  expect((await api(`${base}/runs`, "POST", { ...input, requestId: "20000000-0000-4000-8000-000000000002" })).status).toBe(429);
  expect((await api(`${base}/runs`, "POST", input)).status).toBe(200);
  release!(); await finished(id);
});

test("transport guard restricts public pinned GETs and broker signing; redirects forbidden", async () => {
  const seen: RequestInit[] = [];
  const guarded = guardExplainFetch((async (_url, init) => { seen.push(init!); return Response.json({ ok: true }); }) as typeof fetch,
    "https://tower.example", "https://broker.example", "moon", input.graphVersion, "npub1worker");
  await guarded(`https://tower.example/api/v4/learning/research/concepts/moon/walk?depth=1&limit=13&version=${input.graphVersion}`);
  expect(seen[0]!.redirect).toBe("error");
  for (const path of ["/overlay", "/profile", "/research/concepts/moon/sources?version=changed", "/research/concepts/moon/walk?depth=4&limit=100&version=2026-09-27.1"]) {
    await expect(guarded(`https://tower.example/api/v4/learning${path}`)).rejects.toThrow("transport_denied");
  }
  await expect(guarded("https://evil.example/public")).rejects.toThrow("transport_denied");
  await expect(guarded("https://broker.example/api/mcp/capabilities/nip98", { method: "POST", body: JSON.stringify({ method: "GET", url: "https://tower.example/api/v4/learning/overlay" }) })).rejects.toThrow("transport_denied");
});

test("actual NIP-98 route accepts exact body/URL and rejects tampering", async () => {
  const secret = generateSecretKey();
  const url = new URL(`https://autopilot.example${base}/runs`);
  const body = JSON.stringify(input);
  const cache = new Nip98ReplayCache(100, join(dir, "replay.sqlite"));
  async function signed(signedUrl: string, signedBody: string, actualBody: string) {
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
      tags: [["u", signedUrl], ["method", "POST"], ["nonce", crypto.randomUUID()],
        ["payload", createHash("sha256").update(signedBody).digest("hex")]] }, secret);
    const request = new Request(url, { method: "POST", body: actualBody,
      headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` } });
    const resolved = await resolveNip98AuthContext(request, url, { npub: null, session: null }, {
      verifyNip98AuthHeader: req => verifyNip98Request({ request: req, requestUrl: url, configuredBaseUrl: url.origin, replayCache: cache }),
      lookupBotOwnerNpub: () => "npub1pete",
    });
    return (await handlePipelineApi(request, url, "POST", resolved, ctx))!;
  }
  expect((await signed(url.toString(), body, `${body} `)).status).toBe(401);
  expect((await signed(`${url}/wrong`, body, body)).status).toBe(401);
  const created = await signed(url.toString(), body, body); expect(created.status).toBe(202);
  const id = (await created.json()).run.id;
  await Bun.sleep(5);
  expect(store.get("npub1pete", id)).toBeNull();
});

test("runtime uses fixed guide command, isolated broker environment and exactly one capped model call", async () => {
  let childArgs: string[] = [];
  let childEnv: Record<string, string> = {};
  let providerCalls = 0;
  const cache = await prepareExplainCache({ ids: ["moon"], version: input.graphVersion, graphHash: input.graphHash,
    towerOrigin: "https://tower.example", outputDir: join(dir, "public-guides"), fetchGuide: async () => guide });
  const env = { SPACE_EXPLAIN_CLI_PATH: "/trusted/bin/space-graph.ts", SPACE_EXPLAIN_TOWER_URL: "https://tower.example",
    WINGMAN_URL: "https://broker.example", SESSION_ID: "worker-session", WINGMAN_CAPABILITY: "worker-capability", BOT_NPUB: "npub1worker",
    SPACE_EXPLAIN_GUIDE_MANIFEST_PATH: cache.manifestPath, SPACE_EXPLAIN_GUIDE_MANIFEST_SHA256: cache.manifestHash,
    SPACE_EXPLAIN_MODEL: "configured-model",
    PIPELINE_CLASSIFIER_OPENROUTER_API_KEY: "provider-key", PRIVATE_KEY: "must-not-inherit" };
  await fetchBrokeredExplainGuide(input, env, new AbortController().signal,
    ((args: string[], options: { env: Record<string, string> }) => {
      childArgs = args; childEnv = options.env;
      return { stdout: new Response(JSON.stringify(guide)).body, exited: Promise.resolve(0), exitCode: 0, kill() {} };
    }) as unknown as typeof Bun.spawn);
  const runtime = createExplainWorker(ctx, "npub1alice", { env: { SPACE_EXPLAIN_TOWER_URL: env.SPACE_EXPLAIN_TOWER_URL,
    SPACE_EXPLAIN_GUIDE_MANIFEST_PATH: cache.manifestPath, SPACE_EXPLAIN_GUIDE_MANIFEST_SHA256: cache.manifestHash,
    SPACE_EXPLAIN_MODEL: env.SPACE_EXPLAIN_MODEL, PIPELINE_CLASSIFIER_OPENROUTER_API_KEY: "provider-key" },
    fetch: (async (url, options) => {
      providerCalls++;
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      const data = JSON.parse(String(options!.body));
      expect(data.model).toBe("configured-model"); expect(data.max_tokens).toBe(1800);
      expect(data.provider).toEqual({ data_collection: "deny", zdr: true }); expect(data.tools).toBeUndefined();
      expect(options!.redirect).toBe("error");
      return Response.json({ choices: [{ message: { content: JSON.stringify(output()) } }] });
    }) as typeof fetch,
  });
  const signal = new AbortController().signal;
  expect(await runtime.guide(input, signal)).toEqual(guide);
  expect(childArgs).toContain("--preload"); expect(childArgs).toContain("guide");
  expect(JSON.stringify(childArgs)).not.toContain(input.question);
  expect(childEnv.PRIVATE_KEY).toBeUndefined(); expect(childEnv.SESSION_ID).toBe("worker-session");
  expect(childEnv.SPACE_EXPLAIN_WORKER_NPUB).toBe("npub1worker");
  expect(validateExplainOutput(await runtime.generate(input, evidence, signal), evidence, input).status).toBe("supported");
  expect(providerCalls).toBe(1);
  expect(() => createExplainWorker(ctx, "npub1alice", { env: {} })).toThrow("space_explain_unavailable");
});

test("public cache pins Tower origin, graph and file hashes with no transient runtime capability", async () => {
  const cache = await prepareExplainCache({ ids: ["moon"], version: input.graphVersion, graphHash: input.graphHash,
    towerOrigin: "https://tower.example", outputDir: join(dir, "cache"), fetchGuide: async () => ({ ...guide, learnerNpub: "private" }) });
  expect(readFileSync(join(dir, "cache/moon.json"), "utf8")).not.toContain("learnerNpub");
  const config = { manifestPath: cache.manifestPath, manifestHash: cache.manifestHash, towerOrigin: "https://tower.example" };
  const signal = new AbortController().signal;
  expect(await readCachedExplainGuide(input, config, signal)).toEqual(guide);
  await expect(readCachedExplainGuide(input, { ...config, towerOrigin: "https://wrong.example" }, signal)).rejects.toThrow("graph_mismatch");
  await expect(readCachedExplainGuide({ ...input, conceptId: "sun" }, config, signal)).rejects.toThrow("guide_not_cached");
  writeFileSync(join(dir, "cache/moon.json"), JSON.stringify({ ...guide, contentHash: "tampered" }));
  await expect(readCachedExplainGuide(input, config, signal)).rejects.toThrow("graph_mismatch");
  writeFileSync(cache.manifestPath, "{}");
  await expect(readCachedExplainGuide(input, config, signal)).rejects.toThrow("graph_mismatch");
});

test("broker cannot silently sign public evidence as a different identity", async () => {
  const guarded = guardExplainFetch((async () => Response.json({ token: "unused", signedBy: "npub1pete" })) as typeof fetch,
    "https://tower.example", "https://broker.example", "moon", input.graphVersion, "npub1worker");
  await expect(guarded("https://broker.example/api/mcp/capabilities/nip98", { method: "POST",
    body: JSON.stringify({ method: "GET", url: `https://tower.example/api/v4/learning/research/concepts/moon/sources?version=${input.graphVersion}` }) })).rejects.toThrow("worker_identity_mismatch");
});
