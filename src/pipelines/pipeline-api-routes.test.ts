import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { SessionApiContext } from "../server/session-api-routes";
import { handlePipelineApi, type PipelineApiContext } from "./pipeline-api-routes";
import { PipelineStore } from "./pipeline-store";

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
