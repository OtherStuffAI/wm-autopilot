import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { AccessActions, clearAccessRules, evaluateAccess, registerAccessRule, requireAuthentication } from "../auth/access-control";
import { createTrustedExecutionRule } from "../auth/trusted-execution";
import { resolveNip98AuthContext } from "../auth/nip98-auth";
import { Nip98ReplayCache, verifyNip98Request } from "../auth/nip98-verifier";
import type { RequestAuthContext } from "../auth/request-context";
import { createHash } from "node:crypto";
import { handlePipelineHttp } from "../server/pipeline-http";
import { PipelineStore } from "./pipeline-store";
import type { PipelineApiContext } from "./pipeline-api-routes";
import { waitForPublicRun } from "./public-call-contract";
import { ResultWebhookService } from "./result-webhook-service";

let directory: string;
let root: string | undefined;
let store: PipelineStore;
let ctx: PipelineApiContext;
let releaseSlow: (() => void) | undefined;
const secret = generateSecretKey();
const owner = nip19.npubEncode(getPublicKey(secret));
const outsiderSecret = generateSecretKey();
const outsider = nip19.npubEncode(getPublicKey(outsiderSecret));
const anonymous: RequestAuthContext = { npub: null, actorNpub: null, session: null };
let replay: Nip98ReplayCache;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pipeline-calls-"));
  root = process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT = join(directory, "root");
  mkdirSync(join(directory, "root/shared/definitions"), { recursive: true });
  writeFileSync(join(directory, "root/shared/definitions/quick.json"), JSON.stringify({ name: "quick", steps: [] }));
  store = new PipelineStore(join(directory, "runs.sqlite"));
  clearAccessRules();
  registerAccessRule(AccessActions.SessionsManage, requireAuthentication({ allowNip98: true }));
  registerAccessRule(AccessActions.SessionsManage, createTrustedExecutionRule({ kind: "sessions", isAdminNpub: () => false, isApprovedNpub: npub => npub === owner || npub === outsider }));
  replay = new Nip98ReplayCache();
  ctx = { store, defaultAgent: "codex", sharedInstanceAccess: true, AccessActions,
    sessionApiContext: {} as PipelineApiContext["sessionApiContext"],
    ensureApiAccess: async (action, request, url, auth) => {
      const decision = await evaluateAccess(action, { request, url, auth });
      return decision.allowed ? null : Response.json({ error: decision.reason }, { status: decision.status });
    },
  };
});
afterEach(async () => {
  releaseSlow?.(); releaseSlow = undefined;
  await Bun.sleep(10);
  clearAccessRules();
  if (root === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
  else process.env.WINGMEN_PIPELINES_ROOT = root;
  rmSync(directory, { recursive: true, force: true });
});

function signedRequest(path: string, method: string, body?: unknown, key = secret, extra: Record<string, string> = {}) {
  const url = `https://autopilot.example${path}`;
  const bytes = body === undefined ? "" : JSON.stringify(body);
  const tags = [["u", url], ["method", method]];
  if (bytes) tags.push(["payload", createHash("sha256").update(bytes).digest("hex")]);
  tags.push(["nonce", crypto.randomUUID()]);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags }, key);
  return new Request(url, { method, headers: { ...extra, Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`, "Content-Type": "application/json" }, ...(bytes ? { body: bytes } : {}) });
}
async function call(request: Request, auth = anonymous) {
  return (await handlePipelineHttp(request, new URL(request.url), auth, ctx,
    (req, url, initial) => resolveNip98AuthContext(req, url, initial, {
      verifyNip98AuthHeader: async (request, requestUrl) => await verifyNip98Request({ request, requestUrl, configuredBaseUrl: "https://autopilot.example", replayCache: replay }),
    }), "https://site.example"))!;
}

async function slowDefinition() {
  mkdirSync(join(directory, "root/shared/functions"), { recursive: true });
  const key = `testPipelineGate_${crypto.randomUUID()}`;
  let released: () => void;
  (globalThis as Record<string, unknown>)[key] = new Promise<void>(resolve => { released = resolve; });
  releaseSlow = () => { released(); delete (globalThis as Record<string, unknown>)[key]; };
  writeFileSync(join(directory, "root/shared/functions/gate.ts"), `export const name = "test.gate"; export default async function(input) { await globalThis[${JSON.stringify(key)}]; return {...input, finished:true}; }`);
  writeFileSync(join(directory, "root/shared/definitions/slow.json"), JSON.stringify({ name: "slow", steps: [{ name: "Wait for work", type: "code", function: "test.gate", display: { in: [{ label: "Input", path: "$" }], out: [{ label: "Finished", path: "finished", format: "text" }] } }] }));
}

describe("public pipeline calls", () => {
  test("fast wait completes; async=1 and polling preserve the envelope", async () => {
    const fast = await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", { input: { answer: 42 } }));
    const result = await fast.json();
    expect(fast.status).toBe(200);
    expect(result).toMatchObject({ status: "ok", terminal: true, timedOut: false, result: { answer: 42 }, error: null });
    const async = await call(signedRequest("/api/pipelines/definitions/quick/runs?async=1", "POST", {}));
    expect(async.status).toBe(202);
    const accepted = await async.json();
    const polled = await call(signedRequest(accepted.pollingUrl, "GET"));
    expect(await polled.json()).toMatchObject({ runId: accepted.runId, status: "ok", terminal: true, result: {} });
  });

  test("60-second wait expiry advances a fake clock; completion uses the same run", async () => {
    await slowDefinition();
    let elapsed = 0;
    ctx.publicWaitClock = { now: () => elapsed, sleep: async ms => { elapsed += ms; } };
    const response = await call(signedRequest("/api/pipelines/definitions/slow/runs", "POST", { input: { a: 1 } }));
    const accepted = await response.json();
    expect(response.status).toBe(202);
    expect(accepted.timedOut).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(60_000);
    expect(elapsed).toBeGreaterThan(59_000);
    expect(accepted.status).toBe("running");
    expect(store.listRuns({ ownerNpub: owner })).toHaveLength(1);
    releaseSlow!();
    await Bun.sleep(20);
    const poll = await call(signedRequest(accepted.pollingUrl, "GET"));
    expect(await poll.json()).toMatchObject({ runId: accepted.runId, status: "ok", result: { a: 1, finished: true } });
  });

  test("wait helper clamps an oversized deadline and run execution errors use HTTP 200", async () => {
    const run = store.createRun({ definitionId: "test", name: "test", scope: "user", input: {} });
    let elapsed = 0;
    const outcome = await waitForPublicRun(store, run.id, 100_000, { now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    expect(elapsed).toBe(60_000);
    expect(outcome.timedOut).toBe(true);
    writeFileSync(join(directory, "root/shared/definitions/broken.json"), JSON.stringify({ name: "broken", steps: [{ name: "Missing function", type: "code", function: "does.not.exist" }] }));
    const response = await call(signedRequest("/api/pipelines/definitions/broken/runs", "POST", {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "error", terminal: true, error: expect.any(String) });
  });

  test("idempotent parallel retries produce one durable owner-private run", async () => {
    const requests = await Promise.all([1, 2].map(() => call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", { mode: "poll", idempotencyKey: "same", input: { a: 1, b: 2 } }))));
    const bodies = await Promise.all(requests.map(r => r.json()));
    expect(bodies[0].runId).toBe(bodies[1].runId);
    expect(store.listRuns({ ownerNpub: owner })).toHaveLength(1);
    const reordered = await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", { mode: "wait", idempotencyKey: "same", input: { b: 2, a: 1 } }));
    expect((await reordered.json()).runId).toBe(bodies[0].runId);
    expect((await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", { idempotencyKey: "same", input: { a: 3 } }))).status).toBe(409);
    const secondOwner = await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", { mode: "poll", idempotencyKey: "same", input: { a: 1 } }, outsiderSecret));
    expect((await secondOwner.json()).runId).not.toBe(bodies[0].runId);
    for (const suffix of ["", "/steps", "/delivery", "/cancel", "/resume-from-failure"]) {
      expect((await call(signedRequest(bodies[0].pollingUrl + suffix, suffix.includes("cancel") || suffix.includes("resume") ? "POST" : "GET", suffix.includes("cancel") || suffix.includes("resume") ? {} : undefined, outsiderSecret))).status).toBe(404);
    }
    const list = await call(signedRequest("/api/pipelines/runs?includeDefinitionMeta=0", "GET", undefined, outsiderSecret));
    expect((await list.json()).runs.map((r: { id: string }) => r.id)).not.toContain(bodies[0].runId);
    const reopenedStore = new PipelineStore(store.path);
    expect(reopenedStore.publicCalls.find(owner, "shared:quick", "same")?.runId ?? reopenedStore.publicCalls.find(owner, store.getRun(bodies[0].runId)!.definitionId, "same")?.runId).toBe(bodies[0].runId);
  });

  test("public step reads and cancellation never reveal internal callback credentials", async () => {
    await slowDefinition();
    const started = await call(signedRequest("/api/pipelines/definitions/slow/runs", "POST", { mode: "poll" }));
    const accepted = await started.json();
    const step = store.listSteps(accepted.runId)[0]!;
    store.setStepCallbackToken(step.id, "internal-callback-credential");
    store.addCallback({ stepId: step.id, accepted: false, payload: { token: "internal-callback-credential" } });
    for (const path of [accepted.pollingUrl + "?includePayload=1", accepted.pollingUrl + "/steps?includePayload=1", accepted.pollingUrl + `/steps/${step.id}`]) {
      const read = await call(signedRequest(path, "GET"));
      expect(read.status).toBe(200);
      expect(await read.text()).not.toContain("internal-callback-credential");
    }
    const cancelled = await call(signedRequest(accepted.pollingUrl + "/cancel", "POST", {}));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.text()).not.toContain("internal-callback-credential");
  });

  test("NIP-98 exact URL, method, body, replay and current approval gates remain enforced", async () => {
    const valid = signedRequest("/api/pipelines/definitions/quick/runs?async=1", "POST", {});
    const original = valid.clone();
    const changedUrl = new Request(valid.url.replace("async=1", "async=0"), valid.clone());
    expect((await call(changedUrl)).status).toBe(401);
    const changedBody = new Request(valid.url, { method: "POST", headers: valid.headers, body: '{"tampered":true}' });
    expect((await call(changedBody)).status).toBe(401);
    expect((await call(new Request(valid.url, { method: "GET", headers: valid.headers }))).status).toBe(401);
    expect((await call(valid)).status).toBe(202);
    expect((await call(original)).status).toBe(401);
    expect((await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", {}, generateSecretKey()))).status).toBe(403);
  });

  test("browser allowlist supports signed polling, rejects cookies and unsafe preflights", async () => {
    const url = "https://autopilot.example/api/pipelines/definitions/quick/runs";
    const preflight = await call(new Request(url, { method: "OPTIONS", headers: { Origin: "https://site.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization, Content-Type, Idempotency-Key" } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://site.example");
    expect(preflight.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    expect((await call(new Request(url, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }))).status).toBe(403);
    expect((await call(new Request(url, { method: "OPTIONS", headers: { Origin: "https://site.example", "Access-Control-Request-Method": "DELETE" } }))).status).toBe(403);
    const cookieAuth = { ...anonymous, npub: owner, session: {} } as RequestAuthContext;
    expect((await call(new Request(url, { method: "POST", body: "{}", headers: { Origin: "https://site.example" } }), cookieAuth)).status).toBe(401);
    const started = await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", { mode: "poll" }, secret, { Origin: "https://site.example" }));
    expect(started.status).toBe(202);
    expect(started.headers.get("Access-Control-Allow-Origin")).toBe("https://site.example");
    const poll = await call(signedRequest((await started.json()).pollingUrl, "GET", undefined, secret, { Origin: "https://site.example" }));
    expect(poll.status).toBe(200);
    expect(poll.headers.get("Access-Control-Allow-Origin")).toBe("https://site.example");
  });

  test("same-origin browser requests behind a proxy use the configured public origin", async () => {
    const signed = signedRequest("/api/pipelines/definitions/quick/runs", "POST", { mode: "poll" }, secret, { Origin: "https://autopilot.example" });
    const internal = new Request(signed.url.replace("https://autopilot.example", "http://127.0.0.1:3600"), signed);
    const response = await handlePipelineHttp(internal, new URL(internal.url), anonymous, ctx,
      (req, url, initial) => resolveNip98AuthContext(req, url, initial, {
        verifyNip98AuthHeader: async (request, requestUrl) => verifyNip98Request({ request, requestUrl, configuredBaseUrl: "https://autopilot.example", replayCache: replay }),
      }), "", "https://autopilot.example");
    expect(response?.status).toBe(202);
    expect(response?.headers.has("Access-Control-Allow-Origin")).toBe(false);
    const opaque = new Request("https://autopilot.example/api/pipelines/definitions", { headers: { Origin: "null" } });
    expect((await handlePipelineHttp(opaque, new URL(opaque.url), anonymous, ctx, async () => anonymous, "null,*"))?.status).toBe(403);
  });

  test("webhook mode registers one delivery, can be inspected and never gates polling", async () => {
    ctx.resultWebhooks = new ResultWebhookService(store, getPublicKey(secret), event => finalizeEvent(event, secret), async () => 503);
    const body = { mode: "webhook", idempotencyKey: "webhook-call", input: { summary: "hello" }, webhook: { url: "https://8.8.8.8/result" } };
    const response = await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", body));
    const accepted = await response.json();
    expect(response.status).toBe(202);
    expect((await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", body))).status).toBe(200);
    expect((await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", { ...body, webhook: { url: "https://1.1.1.1/result" } }))).status).toBe(409);
    const deliveryResponse = await call(signedRequest(accepted.deliveryUrl, "GET"));
    const delivery = (await deliveryResponse.json()).delivery;
    expect(delivery).toMatchObject({ runId: accepted.runId, status: "pending", attempts: 0 });
    expect(delivery).not.toHaveProperty("payload");
    await ctx.resultWebhooks.tick();
    expect(store.publicCalls.getDelivery(accepted.runId)?.attempts).toBe(1);
    const poll = await call(signedRequest(accepted.pollingUrl, "GET"));
    expect(await poll.json()).toMatchObject({ runId: accepted.runId, status: "ok", result: { summary: "hello" } });
    const signer = await call(signedRequest("/api/pipelines/webhook-signer", "GET"));
    expect(await signer.json()).toEqual({ pubkey: getPublicKey(secret), scheme: "NIP-98" });
  });

  test("invalid starts create no run; private webhook destinations are rejected", async () => {
    ctx.resultWebhooks = new ResultWebhookService(store, getPublicKey(secret), event => finalizeEvent(event, secret));
    for (const body of [{ mode: "invalid" }, { waitSeconds: 61 }, { input: [] }, { idempotencyKey: " " }, { mode: "webhook", webhook: { url: "https://127.0.0.1/result" } }, { mode: "webhook", webhook: { url: "http://public.example/result" } }]) {
      expect((await call(signedRequest("/api/pipelines/definitions/quick/runs", "POST", body))).status).toBe(400);
    }
    expect(store.listRuns({ ownerNpub: owner })).toHaveLength(0);
  });
});


test("public calls transactionally pin executable block expansion and definition history", async () => {
  writeFileSync(join(directory, "root/shared/definitions/block.json"), JSON.stringify({ name: "block", steps: [{ id: "accept", name: "accept", type: "block", block: "flightdeck.threadInvocation" }] }));
  const response = await call(signedRequest("/api/pipelines/definitions/block/runs", "POST", { input: {
    workspaceId: "11111111-1111-4111-8111-111111111111", threadId: "22222222-2222-4222-8222-222222222222", frmNpub: "npub1synthetic", prompt: "synthetic" } }));
  const result = await response.json(); expect(response.status).toBe(200); expect(result.status).toBe("ok");
  const snapshot = store.composition.snapshot(result.runId)!; expect(snapshot).not.toBeNull();
  expect(snapshot.definition.spec.steps[0]!.type).toBe("block"); expect(snapshot.context.blockExpansions?.accept?.steps).toHaveLength(1);
  expect(store.listSteps(result.runId).map(step => step.logicalKey)).toEqual(["accept", "accept/accept / normalise-thread-invocation"]);
});


test("public owner provider pin stays redacted after credential removal and reopen", async () => {
  const { viewerSnapshot } = await import("./pipeline-viewer-dto");
  const provider = "synthetic-retired-public-provider";
  ctx.sessionApiContext = { getStoredInstanceSetting: (key: string) => key === "pipelines.classifier_openrouter_api_key" ? provider : null } as never;
  writeFileSync(join(directory, "root/shared/definitions/retired.json"), JSON.stringify({ name: "retired", description: provider, steps: [] }));
  const response = await call(signedRequest("/api/pipelines/definitions/retired/runs", "POST", { input: {} }));
  const result = await response.json(); expect(result.status).toBe("ok");
  store = new PipelineStore(store.path);
  const snapshot = viewerSnapshot(result.runId, store, "service");
  expect(JSON.stringify(snapshot)).not.toContain(provider); expect(snapshot.definition.availability).toBe("redacted");
});
