import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { SessionApiContext } from "../server/session-api-routes";
import { handlePipelineApi, type PipelineApiContext } from "./pipeline-api-routes";
import { PipelineStore } from "./pipeline-store";
import { getPipelineDefinition } from "./pipeline-loader";
import { configureFlightDeckPipelineInvocation } from "./flightdeck-invocation";

let tempDir: string;
let previousPipelineRoot: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-pipeline-api-test-"));
  previousPipelineRoot = process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT = join(tempDir, "pipelines-root");
});

afterEach(() => {
  if (previousPipelineRoot === undefined) {
    delete process.env.WINGMEN_PIPELINES_ROOT;
  } else {
    process.env.WINGMEN_PIPELINES_ROOT = previousPipelineRoot;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

const makeStore = () => new PipelineStore(join(tempDir, "pipelines.sqlite"));

function makeAuth(npub: string): RequestAuthContext {
  return {
    npub,
    actorNpub: npub,
    signerNpub: npub,
    subjectNpub: npub,
    targetOwnerNpub: npub,
    delegatedOwnerNpub: null,
    delegateRelationshipId: null,
    delegateScopes: null,
    session: null,
  };
}

function makeContext(
  store: PipelineStore,
  sharedInstanceAccess: boolean,
  options: { stoppedSessions?: string[] } = {},
): PipelineApiContext {
  return {
    store,
    defaultAgent: "codex",
    sessionApiContext: {
      manager: {
        async stopSession(sessionId: string) {
          options.stoppedSessions?.push(sessionId);
          return true;
        },
      },
      scheduleSessionArchive() {},
    } as unknown as SessionApiContext,
    sharedInstanceAccess,
    ensureApiAccess: async () => null,
    AccessActions: {
      SessionsManage: AccessActions.SessionsManage,
    },
  };
}

async function handleGet(path: string, ctx: PipelineApiContext, viewerNpub = "npub1viewer"): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  return await handlePipelineApi(
    new Request(url),
    url,
    "GET",
    makeAuth(viewerNpub),
    ctx,
  ) ?? new Response(null, { status: 404 });
}

async function handlePost(path: string, ctx: PipelineApiContext, viewerNpub = "npub1viewer"): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  return await handlePipelineApi(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    url,
    "POST",
    makeAuth(viewerNpub),
    ctx,
  ) ?? new Response(null, { status: 404 });
}

async function handlePostJson(path: string, ctx: PipelineApiContext, body: Record<string, unknown>, viewerNpub = "npub1viewer"): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  return await handlePipelineApi(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    "POST",
    makeAuth(viewerNpub),
    ctx,
  ) ?? new Response(null, { status: 404 });
}

function writeSharedPipelineDefinition(slug: string, spec: Record<string, unknown>): void {
  const definitionsDir = join(process.env.WINGMEN_PIPELINES_ROOT!, "shared", "definitions");
  mkdirSync(definitionsDir, { recursive: true });
  writeFileSync(join(definitionsDir, `${slug}.json`), JSON.stringify(spec, null, 2));
}

async function waitForRunStatus(store: PipelineStore, runId: string, statuses: string[]): Promise<void> {
  const expected = new Set(statuses);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const status = store.getRun(runId)?.status;
    if (expected.has(String(status))) return;
    await Bun.sleep(10);
  }
}

describe("pipeline run API visibility", () => {
  test("learning run requires a session-bound Tower connection and rejects learner overrides", async () => {
    const store = makeStore();
    const ctx = makeContext(store, true);
    const path = '/api/pipelines/definitions/learning-plan/runs?async=1';
    const override = await handlePostJson(path, ctx, { input: { goal: 'moon-phases', idempotencyKey: 'one', learnerNpub: 'npub1other' } });
    expect(override.status).toBe(400);
    const missing = await handlePostJson(path, ctx, { input: { goal: 'moon-phases', idempotencyKey: 'one' } });
    expect(missing.status).toBe(403);
    expect((await missing.json() as { code: string }).code).toBe('learning_tower_binding_required');
    expect(store.listRuns({ ownerNpub: 'npub1viewer' })).toHaveLength(0);
  });
  test("keeps learning run history private even on shared instances", async () => {
    const store = makeStore();
    const run = store.createRun({ definitionId: 'learning-plan', name: 'learning-plan', ownerNpub: 'npub1learnerA', scope: 'shared', input: { goal: 'moon-phases' } });
    const ctx = makeContext(store, true);
    const list = await handleGet('/api/pipelines/runs?includeDefinitionMeta=0', ctx, 'npub1learnerB');
    expect((await list.json() as { runs: unknown[] }).runs).toHaveLength(0);
    expect((await handleGet(`/api/pipelines/runs/${run.id}`, ctx, 'npub1learnerB')).status).toBe(404);
    expect((await handleGet(`/api/pipelines/runs/${run.id}`, ctx, 'npub1learnerA')).status).toBe(200);
  });
  test("starts arbitrary selected pipelines through the same Flight Deck contract", async () => {
    const store = makeStore();
    const input = {
      workspaceId: "2e5caefd-dd65-45d2-b747-ee874e8e5fc9",
      threadId: "c87e026d-23c5-4fe9-b752-117f18cf4a10",
      frmNpub: "npub1requester",
      prompt: "Question",
    };
    configureFlightDeckPipelineInvocation({
      resolve: async (resolved) => ({
        workspaceId: resolved.workspaceId,
        threadId: resolved.threadId,
        channelId: "channel-1",
        senderNpub: "npub1managed",
      }),
      send: async () => ({ delivered: true }),
    });
    for (const slug of ["pipeline-a", "pipeline-b"]) {
      writeSharedPipelineDefinition(slug, { name: slug, input: { internalDefault: true }, steps: [] });
      const response = await handlePostJson(
        `/api/pipelines/definitions/${slug}/flightdeck-runs`,
        makeContext(store, true),
        input,
      );
      const body = await response.json() as { run: { input: Record<string, unknown> }; invocation: Record<string, unknown> };
      expect(response.status).toBe(202);
      expect(body.run.input).toEqual({ internalDefault: true, ...input });
      expect(body.invocation).toMatchObject({ channelId: "channel-1", senderNpub: "npub1managed", requesterNpub: input.frmNpub });
    }
  });

  test("rejects malformed Flight Deck run input before creating a run", async () => {
    const store = makeStore();
    writeSharedPipelineDefinition("pipeline-a", { name: "pipeline-a", steps: [] });
    const response = await handlePostJson(
      "/api/pipelines/definitions/pipeline-a/flightdeck-runs",
      makeContext(store, true),
      { workspaceId: "bad", threadId: "", frmNpub: "not-an-npub", prompt: "" },
    );
    expect(response.status).toBe(400);
    expect(store.listRuns({ ownerNpub: "npub1viewer" })).toHaveLength(0);
  });

  test("includes shared pipeline runs for other owners on shared instances", async () => {
    const store = makeStore();
    const ownRun = store.createRun({
      definitionId: "own-definition",
      name: "own private run",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "user",
      input: {},
    });
    const sharedRun = store.createRun({
      definitionId: "shared-definition",
      name: "shared dispatch run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "shared",
      input: {},
    });
    store.createRun({
      definitionId: "other-definition",
      name: "other private run",
      ownerNpub: "npub1other",
      ownerAlias: "other-alias",
      scope: "user",
      input: {},
    });

    const response = await handleGet("/api/pipelines/runs", makeContext(store, true));
    const body = await response.json() as { runs: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.runs.map((run) => run.id).sort()).toEqual([ownRun.id, sharedRun.id].sort());
  });

  test("keeps other-owner shared pipeline runs hidden when shared access is disabled", async () => {
    const store = makeStore();
    store.createRun({
      definitionId: "shared-definition",
      name: "shared dispatch run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "shared",
      input: {},
    });

    const response = await handleGet("/api/pipelines/runs", makeContext(store, false));
    const body = await response.json() as { runs: unknown[] };

    expect(response.status).toBe(200);
    expect(body.runs).toHaveLength(0);
  });

  test("can skip definition metadata when listing pipeline runs", async () => {
    const store = makeStore();
    const definitionPath = join(process.env.WINGMEN_PIPELINES_ROOT!, "shared", "definitions", "review-loop-v2.json");
    const run = store.createRun({
      definitionId: "review-loop",
      definitionPath,
      name: "review loop run",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "shared",
      input: {},
    });
    writeSharedPipelineDefinition("review-loop-v2", {
      name: "Review Loop",
      default: true,
      tags: ["review"],
      steps: [],
    });

    const response = await handleGet("/api/pipelines/runs?includeDefinitionMeta=0", makeContext(store, true));
    const body = await response.json() as { runs: Array<{ id: string; definitionSlug: string | null; definitionDefault: boolean; tags: string[] }> };
    const summary = body.runs.find((entry) => entry.id === run.id);

    expect(response.status).toBe(200);
    expect(summary?.definitionSlug).toBe("review-loop-v2");
    expect(summary?.definitionDefault).toBe(false);
    expect(summary?.tags).toEqual([]);
  });

  test("compacts completed run payloads for accessible owner runs", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "compact-definition",
      name: "compact me",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "user",
      input: {},
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "payload step",
      kind: "code",
      input: { value: "x".repeat(1024) },
    });
    store.completeStep({ id: step.id, status: "ok", result: { value: "y".repeat(1024) } });
    store.completeRun(run.id, "ok", { done: true });
    const otherRun = store.createRun({
      definitionId: "compact-definition",
      name: "compact me",
      ownerNpub: "npub1other",
      ownerAlias: "other-alias",
      scope: "user",
      input: {},
    });
    const otherStep = store.createStep({
      runId: otherRun.id,
      stepIndex: 0,
      name: "other payload step",
      kind: "code",
      input: { value: "z".repeat(1024) },
    });
    store.completeStep({ id: otherStep.id, status: "ok", result: { value: "z".repeat(1024) } });
    store.completeRun(otherRun.id, "ok", { done: true });

    const dryRunResponse = await handlePostJson(
      "/api/pipelines/runs/compact-completed",
      makeContext(store, true),
      { name: "compact me", dryRun: true },
    );
    const dryRunBody = await dryRunResponse.json() as { matchedRuns?: number; compactedSteps?: number; compactedEvents?: number };
    const response = await handlePostJson(
      "/api/pipelines/runs/compact-completed",
      makeContext(store, true),
      { name: "compact me" },
    );
    const body = await response.json() as { matchedRuns?: number; compactedSteps?: number; compactedEvents?: number };

    expect(dryRunResponse.status).toBe(200);
    expect(dryRunBody).toMatchObject({ matchedRuns: 1, compactedSteps: 1, compactedEvents: 2 });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ matchedRuns: 1, compactedSteps: 1, compactedEvents: 2 });
    expect(store.getStep(step.id)?.input).toEqual({});
    expect(store.getStep(otherStep.id)?.input).toEqual({ value: "z".repeat(1024) });
  });

  test("allows shared instance viewers to open shared run and step details", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "shared-definition",
      name: "shared dispatch run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "shared",
      input: { prompt: "dispatch" },
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "analyse-intent",
      kind: "agent",
      input: { value: 1 },
    });

    const runResponse = await handleGet(`/api/pipelines/runs/${encodeURIComponent(run.id)}`, makeContext(store, true));
    const stepsResponse = await handleGet(`/api/pipelines/runs/${encodeURIComponent(run.id)}/steps`, makeContext(store, true));
    const stepResponse = await handleGet(
      `/api/pipelines/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.id)}`,
      makeContext(store, true),
    );

    expect(runResponse.status).toBe(200);
    expect(stepsResponse.status).toBe(200);
    expect(stepResponse.status).toBe(200);
  });

  test("does not expose another owner's private run details on shared instances", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "private-definition",
      name: "other private run",
      ownerNpub: "npub1admin",
      ownerAlias: "admin-alias",
      scope: "user",
      input: {},
    });

    const response = await handleGet(`/api/pipelines/runs/${encodeURIComponent(run.id)}`, makeContext(store, true));

    expect(response.status).toBe(404);
  });

  test("reopens an accessible errored run for async resume", async () => {
    writeSharedPipelineDefinition("recoverable", {
      name: "recoverable",
      input: { value: 1 },
      steps: [
        {
          name: "resume-step",
          type: "code",
          function: "test.resume",
          assign: "$.resumed",
        },
      ],
    });
    const store = makeStore();
    const run = store.createRun({
      definitionId: "recoverable",
      name: "recoverable",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "shared",
      input: { value: 1 },
    });
    store.composition.pin(run.id, (await getPipelineDefinition("recoverable", "viewer-alias"))!, {});
    store.completeRun(run.id, "error", run.current, "temporary failure");
    const ctx = {
      ...makeContext(store, true),
      loadRegistryForRun: async () => ({
        async "test.resume"() {
          return { value: "ok" };
        },
      }),
    } satisfies PipelineApiContext;

    const response = await handlePost(`/api/pipelines/runs/${encodeURIComponent(run.id)}/resume-from-failure`, ctx);
    const body = await response.json() as { ok?: boolean; run?: { status?: string } };

    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(["running", "ok"]).toContain(body.run?.status);
    await waitForRunStatus(store, run.id, ["ok"]);
    expect(["running", "ok"]).toContain(store.getRun(run.id)?.status);
  });

  test("rejects manual resume for non-errored runs", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "running-definition",
      name: "running run",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "user",
      input: {},
    });

    const response = await handlePost(`/api/pipelines/runs/${encodeURIComponent(run.id)}/resume-from-failure`, makeContext(store, true));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("Only errored");
  });

  test("stops an accessible running pipeline run and linked step session", async () => {
    const store = makeStore();
    const stoppedSessions: string[] = [];
    const run = store.createRun({
      definitionId: "running-definition",
      name: "running run",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "user",
      input: {},
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "agent",
      kind: "agent",
      input: {},
    });
    store.setStepSession(step.id, "pipeline-session-1");
    store.setRunActiveStep(run.id, step.id);

    const response = await handlePost(
      `/api/pipelines/runs/${encodeURIComponent(run.id)}/cancel`,
      makeContext(store, true, { stoppedSessions }),
    );
    const body = await response.json() as { ok?: boolean; run?: { status?: string }; steps?: Array<{ status: string }> };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.run?.status).toBe("cancelled");
    expect(body.steps?.map((entry) => entry.status)).toEqual(["cancelled"]);
    expect(stoppedSessions).toEqual(["pipeline-session-1"]);
  });

  test("rejects stopping terminal pipeline runs", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "done-definition",
      name: "done run",
      ownerNpub: "npub1viewer",
      ownerAlias: "viewer-alias",
      scope: "user",
      input: {},
    });
    store.completeRun(run.id, "ok", {});

    const response = await handlePost(`/api/pipelines/runs/${encodeURIComponent(run.id)}/cancel`, makeContext(store, true));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("Only running");
  });
});

test("child run API exposes pinned composition, inherits access and propagates cancellation", async () => {
  const store = makeStore();
  const p = store.createRun({ definitionId: "parent", name: "parent", ownerNpub: "npub1viewer", ownerAlias: "viewer", scope: "user", input: {} });
  const ps = store.createStep({ runId: p.id, stepIndex: 0, name: "child", kind: "pipeline", input: {} });
  const c = store.createRun({ definitionId: "child", name: "child", ownerNpub: "npub1viewer", ownerAlias: "viewer", scope: "shared", input: {} });
  store.composition.pin(c.id, { id: "child", slug: "child", name: "child", scope: "shared", ownerAlias: null, path: "child.json", spec: { name: "child", version: 3, steps: [] } }, {});
  store.composition.link({ parentRunId: p.id, parentStepId: ps.id, childRunId: c.id, deadline: Date.now() + 1000 });
  const cs = store.createStep({ runId: c.id, stepIndex: 0, name: "agent", kind: "agent", input: {} }); store.setStepSession(cs.id, "nested-agent-session");
  const stoppedSessions: string[] = [];
  const ctx = makeContext(store, true, { stoppedSessions });
  expect((await handleGet(`/api/pipelines/runs/${c.id}`, ctx, "npub1stranger")).status).toBe(404);
  const detail = await (await handleGet(`/api/pipelines/runs/${c.id}`, ctx)).json();
  expect(detail.composition).toMatchObject({ definitionVersion: 3, parent: { parentRunId: p.id, parentStepId: ps.id } });
  expect(detail.composition.definitionHash).toHaveLength(64);
  const parent = await (await handleGet(`/api/pipelines/runs/${p.id}`, ctx)).json();
  expect(parent.steps[0].childRunId).toBe(c.id);
  expect((await handlePost(`/api/pipelines/runs/${p.id}/cancel`, ctx)).status).toBe(200);
  expect(store.getRun(c.id)!.status).toBe("cancelled"); expect(stoppedSessions).toEqual(["nested-agent-session"]);
});

test("child API redacts inherited public callback credentials and rejects revival after parent completion", async () => {
  const store = makeStore();
  const p = store.publicCalls.create({ owner: "npub1viewer", definitionId: "parent", key: null, fingerprint: "fixture", webhookUrl: null },
    () => store.createRun({ definitionId: "parent", name: "parent", ownerNpub: "npub1viewer", scope: "shared", input: {} }));
  const ps = store.createStep({ runId: p.id, stepIndex: 0, name: "child", kind: "pipeline", input: {} });
  const c = store.createRun({ definitionId: "child", name: "child", ownerNpub: "npub1viewer", scope: "shared", input: {} });
  store.composition.link({ parentRunId: p.id, parentStepId: ps.id, childRunId: c.id, deadline: Date.now() + 1000 });
  const cs = store.createStep({ runId: c.id, stepIndex: 0, name: "agent", kind: "agent", input: {}, callbackToken: "private-token" });
  store.addCallback({ stepId: cs.id, accepted: false, payload: { private: "private-token" } });
  const ctx = makeContext(store, true);
  const detail = await (await handleGet(`/api/pipelines/runs/${c.id}/steps/${cs.id}`, ctx)).json();
  expect(detail.step.callbackToken).toBeNull(); expect(detail.callbacks).toEqual([]);
  expect((await handleGet(`/api/pipelines/runs/${c.id}`, ctx, "npub1stranger")).status).toBe(404);
  store.completeRun(c.id, "error", {}, "failed"); store.completeRun(p.id, "ok", {});
  expect((await handlePost(`/api/pipelines/runs/${c.id}/resume-from-failure`, ctx)).status).toBe(409);
  expect(store.getRun(c.id)!.status).toBe("error");
});


test("manual resume rejects missing historical snapshot without reopening or loading current code", async () => {
  const store = makeStore(); const run = store.createRun({ name: "legacy", definitionId: "legacy", scope: "shared", ownerNpub: "npub1viewer", input: {} });
  store.completeRun(run.id, "error", {}, "old failure"); let loads = 0;
  const ctx = { ...makeContext(store, true), loadRegistryForRun: async () => { loads++; return {}; } };
  const response = await handlePost(`/api/pipelines/runs/${run.id}/resume-from-failure`, ctx);
  expect(response.status).toBe(409); expect((await response.json()).error).toContain("Historical pipeline definition snapshot was not captured");
  expect(loads).toBe(0); expect(store.getRun(run.id)!.status).toBe("error"); expect(store.listSteps(run.id)).toEqual([]);
});
