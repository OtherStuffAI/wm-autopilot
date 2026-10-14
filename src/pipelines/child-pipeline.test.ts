import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeclarativeStep, FunctionRegistry } from "./declarative";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { PipelineStore } from "./pipeline-store";
import { runDeclarativePipeline, resumeDeclarativePipeline, acceptAgentCallback } from "./pipeline-runner";
import { resumeStoredPipelineRun, resumeRunningPipelineRuns } from "./stored-run-resume";
import { cancelPipelineTree, resolveChildDefinition, validateChildPipelineSteps, MAX_CHILD_PIPELINE_DEPTH } from "./child-pipeline";
import { canAccessPipelineRun } from "./pipeline-route-helpers";
import { responseSteps } from "./public-call-contract";
import { runtimeFunctionHash } from "./pipeline-function-pins";
import { cleanupChildRunnerFixture, observeChildRunnerLifecycle } from "./child-runner-test-lifecycle";

let dir: string;
let store: PipelineStore;
let priorRoot: string | undefined;
let childLifecycle: ReturnType<typeof observeChildRunnerLifecycle>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "child-pipeline-")); store = new PipelineStore(join(dir, "runs.sqlite")); priorRoot = process.env.WINGMEN_PIPELINES_ROOT; process.env.WINGMEN_PIPELINES_ROOT = join(dir, "definitions"); childLifecycle = observeChildRunnerLifecycle(); });
afterEach(async () => {
  await cleanupChildRunnerFixture(childLifecycle, () => {
    if (priorRoot === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
    else process.env.WINGMEN_PIPELINES_ROOT = priorRoot;
  }, () => rmSync(dir, { recursive: true, force: true }));
});

function definition(name: string, steps: DeclarativeStep[], version = 1): PipelineDefinitionRecord {
  return { id: `${name}-${version}`, name, slug: `${name}.v${version}`, scope: "user", ownerAlias: "owner", path: join(dir, `${name}.v${version}.json`), spec: { name, version, steps } };
}
function call(target = "child", options: Partial<Extract<DeclarativeStep, { type: "pipeline" }>> = {}): DeclarativeStep {
  return { name: "child-call", type: "pipeline", pipeline: target, input: { pick: { value: "$.source" } }, assign: "$.answer", ...options };
}
const echo: DeclarativeStep = { name: "echo", type: "code", function: "echo" };
function runner(parent: PipelineDefinitionRecord, definitions: PipelineDefinitionRecord[], registry: FunctionRegistry = { echo: input => ({ doubled: Number(input.value) * 2 }) }) {
  return { store, definition: parent, registry, input: { source: 7 }, ownerNpub: "npub1owner", ownerAlias: "owner", callbackOrigin: "http://localhost", sessionApiContext: {} as never,
    resolveChildDefinition: async (target: string, version: string | number | undefined) => {
      const result = definitions.find(item => item.name === target && (version === undefined || String(item.spec.version) === String(version)));
      if (!result) throw new Error("missing target or version");
      return result;
    } };
}

test("maps input and result, persists links, exact version/hash and inherited identity", async () => {
  const child = definition("child", [echo], 2);
  const parent = definition("parent", [call("child", { version: 2 })]);
  const run = await runDeclarativePipeline({ ...runner(parent, [child]), initiatingAgentProfileId: "piper", initiatingAgentNpub: "npub1piper" });
  expect(run.status).toBe("ok"); expect(run.result).toEqual({ source: 7, answer: { doubled: 14 } });
  const link = store.composition.children(run.id)[0]!;
  const savedChild = store.getRun(link.childRunId)!;
  expect(savedChild.input).toEqual({ value: 7 }); expect(savedChild.ownerNpub).toBe(run.ownerNpub);
  expect(store.composition.parent(savedChild.id)).toEqual(link);
  expect(store.composition.snapshot(savedChild.id)).toMatchObject({ definition: child, context: { initiatingAgentProfileId: "piper", initiatingAgentNpub: "npub1piper" } });
  expect(store.composition.snapshot(savedChild.id)!.hash).toHaveLength(64);
  expect(responseSteps(store, run.id)[0]!.childRunId).toBe(savedChild.id);
});

test("resolves only owner-visible exact versions; rejects paths, disabled, missing and ambiguous targets", async () => {
  const base = join(process.env.WINGMEN_PIPELINES_ROOT!, "users", "owner", "definitions");
  const other = join(process.env.WINGMEN_PIPELINES_ROOT!, "users", "other", "definitions");
  mkdirSync(base, { recursive: true }); mkdirSync(other, { recursive: true });
  for (const version of [1, 2]) writeFileSync(join(base, `child.v${version}.json`), JSON.stringify({ name: "child", version, steps: [echo] }));
  writeFileSync(join(other, "private.json"), JSON.stringify({ name: "private", steps: [echo] }));
  writeFileSync(join(base, "disabled.json"), JSON.stringify({ name: "disabled", enabled: false, steps: [echo] }));
  expect((await resolveChildDefinition("child", undefined, "owner")).spec.version).toBe(2);
  expect((await resolveChildDefinition("child", 1, "owner")).spec.version).toBe(1);
  for (const [name, version] of [["child", 3], ["private", undefined], ["disabled", undefined], ["missing", undefined]]) {
    await expect(resolveChildDefinition(String(name), version as number | undefined, "owner")).rejects.toThrow("missing, invisible or ambiguous");
  }
  for (const target of ["../private", "/tmp/private.json"]) expect(() => validateChildPipelineSteps(definition("p", [call(target)]).spec)).toThrow("never a path");
  const run = await runDeclarativePipeline(runner(definition("p", [call("child", { version: 3 })]), [definition("child", [echo])]));
  expect(run.status).toBe("error"); expect(store.composition.children(run.id)).toHaveLength(0);
});

test("child failure fails parent by default or records an explicit error", async () => {
  for (const failurePolicy of ["fail", "record_error"] as const) {
    const run = await runDeclarativePipeline(runner(definition("p", [call("child", { failurePolicy })]), [definition("child", [echo])], { echo: () => { throw new Error("deliberate failure"); } }));
    expect(run.status).toBe(failurePolicy === "fail" ? "error" : "ok");
    if (failurePolicy === "record_error") expect(run.result!.answer).toMatchObject({ status: "error", error: expect.stringContaining("deliberate failure") });
    else expect(run.error).toContain("deliberate failure");
  }
});

test("rejects mismatched owner/version before dispatch", async () => {
  const child = { ...definition("child", [echo]), ownerAlias: "other" };
  const run = await runDeclarativePipeline(runner(definition("p", [call()]), [child]));
  expect(run.error).toContain("owner mismatch"); expect(store.composition.children(run.id)).toHaveLength(0);
  const mismatched = await runDeclarativePipeline({ ...runner(definition("p", [call("child", { version: 2 })]), []), resolveChildDefinition: async () => definition("child", [echo], 1) });
  expect(mismatched.error).toContain("version mismatch");
});

test("cycles and depth are bounded across nested callers; nested cursors are rejected", async () => {
  const a = definition("a", [call("b")]); const b = definition("b", [call("a")]);
  const run = await runDeclarativePipeline(runner(a, [a, b]));
  expect(run.error).toContain("cycle"); expect(store.composition.tree(run.id)).toHaveLength(2);
  const chain = Array.from({ length: MAX_CHILD_PIPELINE_DEPTH + 2 }, (_, i) => definition(`d${i}`, [call(`d${i + 1}`)]));
  const deep = await runDeclarativePipeline(runner(chain[0]!, chain));
  expect(deep.error).toContain("depth limit"); expect(store.composition.tree(deep.id)).toHaveLength(MAX_CHILD_PIPELINE_DEPTH + 1);
  expect(() => validateChildPipelineSteps(definition("p", [{ name: "loop", type: "loop", steps: [call()] }]).spec)).toThrow("top-level");
});

test("timeout cancels live descendants and prevents late continuation", async () => {
  let resolve!: (value: Record<string, unknown>) => void;
  const wait = new Promise<Record<string, unknown>>(done => { resolve = done; });
  let continued = false;
  const child = definition("child", [echo, { name: "after", type: "code", function: "after" }]);
  const input = runner(definition("p", [call("child", { timeoutMs: 30 })]), [child], { echo: () => wait, after: () => { continued = true; return {}; } });
  const run = await runDeclarativePipeline(input);
  expect(run.status).toBe("error"); expect(run.error).toContain("timeout");
  const childId = store.composition.children(run.id)[0]!.childRunId;
  expect(store.getRun(childId)!.status).toBe("cancelled");
  resolve({ late: true }); await childLifecycle.drain();
  expect(continued).toBe(false); expect(store.getRun(childId)!.status).toBe("cancelled");
  store.completeRun(run.id, "ok", {}); expect(store.getRun(run.id)!.status).toBe("error");
});

test("parent cancellation stops agent work across descendants and rejects late callbacks", async () => {
  const p = store.createRun({ definitionId: "p", name: "p", scope: "user", input: {} });
  const parentStep = store.createStep({ runId: p.id, stepIndex: 0, name: "child", kind: "pipeline", input: {} });
  const c = store.createRun({ definitionId: "c", name: "c", scope: "shared", input: {} });
  store.composition.link({ parentRunId: p.id, parentStepId: parentStep.id, childRunId: c.id, deadline: Date.now() + 1000 });
  const agent = store.createStep({ runId: c.id, stepIndex: 0, name: "agent", kind: "agent", input: {}, callbackToken: "token" });
  store.setStepSession(agent.id, "session-fixture");
  const stopped: string[] = [];
  await cancelPipelineTree(store, { manager: { updateSessionMetadata() {}, async stopSession(id: string) { stopped.push(id); return true; } }, scheduleSessionArchive() {} } as never, p.id, "test stop");
  expect(stopped).toEqual(["session-fixture"]); expect(store.getRun(c.id)!.status).toBe("cancelled");
  expect((await acceptAgentCallback({ store, runId: c.id, stepId: agent.id, token: "token", payload: { runId: c.id, stepId: agent.id, status: "ok", result: {} } })).status).toBe(409);
});

function storedWait() {
  const parentDef = definition("parent", [call()]);
  const childDef = definition("child", [{ name: "agent", type: "agent", prompt: "fixture", assign: "$.judgment" }, { name: "finish", type: "code", function: "echo" }]);
  const p = store.createRun({ definitionId: parentDef.id, name: "parent", ownerNpub: "npub1owner", ownerAlias: "owner", scope: "user", input: { source: 7 } });
  store.composition.pin(p.id, parentDef, { initiatingAgentProfileId: "piper", initiatingAgentNpub: "npub1piper" });
  const ps = store.createStep({ runId: p.id, stepIndex: 0, name: "child-call", kind: "pipeline", input: { value: 7 } }); store.setRunActiveStep(p.id, ps.id);
  const c = store.createRun({ definitionId: childDef.id, name: "child", ownerNpub: p.ownerNpub, ownerAlias: p.ownerAlias, scope: "user", input: { value: 7 } });
  store.composition.pin(c.id, childDef, { initiatingAgentProfileId: "piper", initiatingAgentNpub: "npub1piper" });
  store.composition.link({ parentRunId: p.id, parentStepId: ps.id, childRunId: c.id, deadline: Date.now() + 5000 });
  const cs = store.createStep({ runId: c.id, stepIndex: 0, name: "agent", kind: "agent", input: {}, callbackToken: "token" }); store.setRunActiveStep(c.id, cs.id);
  return { p, c, cs, parentDef, childDef };
}

test("disk recovery resumes waiting child callback then parent once using pinned definitions", async () => {
  const { p, c, cs, parentDef, childDef } = storedWait();
  // Change both on-disk definitions before re-opening the SQLite store.
  writeFileSync(parentDef.path, JSON.stringify({ name: "parent", steps: [] }));
  writeFileSync(childDef.path, JSON.stringify({ name: "child", steps: [] }));
  store = new PipelineStore(join(dir, "runs.sqlite"));
  let executions = 0;
  const ctx = { store, sessionApiContext: {} as never, loadRegistryForRun: async () => ({ echo: (input: Record<string, unknown>) => { executions++; return { result: input.judgment }; } }) } as never;
  const callback = { store, runId: c.id, stepId: cs.id, token: "token", payload: { runId: c.id, stepId: cs.id, status: "ok", result: { exact: true } } };
  expect((await acceptAgentCallback(callback)).status).toBe(200);
  expect((await acceptAgentCallback(callback)).status).toBe(409);
  await resumeStoredPipelineRun(ctx, c.id, "http://localhost");
  await resumeRunningPipelineRuns(ctx, "http://localhost");
  expect(store.getRun(p.id)!.result).toEqual({ source: 7, answer: { result: { exact: true } } });
  expect(store.getRun(p.id)!.status).toBe("ok"); expect(executions).toBe(1);
  expect(store.listSteps(p.id)).toHaveLength(1); expect(store.listSteps(c.id)).toHaveLength(2);
});

test("a live resumed agent child waits for callback, retains session and parent wait", async () => {
  const { p, c, cs, parentDef } = storedWait(); store.setStepSession(cs.id, "live-session");
  let live = true; let creates = 0; let stops = 0;
  const ctx = { manager: { getSession: () => live ? { id: "live-session", status: "running", agentRuntimeStatus: "stable" } : null,
    getAdapter: () => null, createSession: async () => { creates++; throw new Error("do not recreate"); }, updateSessionMetadata() {}, stopSession: async () => { stops++; live = false; return true; } },
    messageStore: { listSessionMessages: () => [] }, syncSessionMessages: async () => {}, scheduleSessionArchive() {} };
  const input = { ...runner(parentDef, []), sessionApiContext: ctx as never };
  const pending = resumeDeclarativePipeline(input, p.id);
  await Bun.sleep(40); expect(store.getRun(p.id)!.status).toBe("running");
  await acceptAgentCallback({ store, runId: c.id, stepId: cs.id, token: "token", payload: { runId: c.id, stepId: cs.id, status: "ok", result: { exact: true } } });
  expect((await pending)!.status).toBe("ok"); expect(creates).toBe(0); expect(stops).toBe(1);
});

test("recovery rejects changed hot function implementation instead of silently changing behavior", async () => {
  const child = definition("child", [echo]); const input = runner(child, []);
  Object.defineProperty(input.registry.echo!, runtimeFunctionHash, { value: "old" });
  const run = store.createRun({ definitionId: child.id, name: child.name, ownerNpub: input.ownerNpub, ownerAlias: input.ownerAlias, scope: child.scope, input: { value: 2 } });
  store.composition.pin(run.id, child, { functionHashes: { echo: "old" } });
  const changed = Object.assign(() => ({ changed: true }), { [runtimeFunctionHash]: "new" });
  const resumed = await resumeDeclarativePipeline({ ...input, registry: { echo: changed } }, run.id);
  expect(resumed!.status).toBe("error"); expect(resumed!.error).toContain("Pinned pipeline function changed");
});

test("a shared child inherits private parent access", async () => {
  const child = { ...definition("child", [echo]), scope: "shared" as const, ownerAlias: null };
  const run = await runDeclarativePipeline(runner(definition("parent", [call()]), [child]));
  const c = store.getRun(store.composition.children(run.id)[0]!.childRunId)!;
  expect(canAccessPipelineRun(c, "npub1stranger", { store, sharedInstanceAccess: true } as never)).toBe(false);
  expect(canAccessPipelineRun(c, "npub1owner", { store } as never)).toBe(true);
});

test("record_error includes missing targets and expired deadlines cancel before relaunch", async () => {
  const run = await runDeclarativePipeline(runner(definition("p", [call("absent", { failurePolicy: "record_error" })]), []));
  expect(run.status).toBe("ok"); expect(run.result!.answer).toMatchObject({ status: "error", childRunId: null });
  const { p, c, cs, parentDef } = storedWait();
  store.setStepSession(cs.id, "expired-session");
  // Reproduce a persisted wall-clock deadline that passed while the process was down.
  const link = store.composition.child(store.getRun(p.id)!.activeStepId!)!;
  const db = new (await import("bun:sqlite")).Database(store.path);
  db.query("UPDATE pipeline_child_runs SET deadline = ? WHERE parent_step_id = ?").run(Date.now() - 1, link.parentStepId); db.close();
  let launched = false; let stopped = false;
  const ctx = { manager: { getSession: () => null, createSession: async () => { launched = true; throw new Error("unexpected"); }, updateSessionMetadata() {}, stopSession: async () => { stopped = true; return true; } }, scheduleSessionArchive() {} };
  const resumed = await resumeDeclarativePipeline({ ...runner(parentDef, []), sessionApiContext: ctx as never }, p.id);
  expect(resumed!.error).toContain("timeout"); expect(store.getRun(c.id)!.status).toBe("cancelled"); expect(stopped).toBe(true); expect(launched).toBe(false);
});

test("parent cancellation during a live wait prevents parent and child continuation", async () => {
  let rootId = ""; let resolve!: (value: Record<string, unknown>) => void; let continued = false;
  const wait = new Promise<Record<string, unknown>>(done => { resolve = done; });
  const child = definition("child", [echo, { name: "late", type: "code", function: "late" }]);
  const pending = runDeclarativePipeline({ ...runner(definition("p", [call()]), [child], { echo: () => wait, late: () => { continued = true; return {}; } }), onRunCreated: run => { rootId = run.id; } });
  while (!store.composition.children(rootId).length) await Bun.sleep(5);
  store.cancelRun(rootId);
  expect((await pending).status).toBe("cancelled");
  resolve({ late: true }); await childLifecycle.drain();
  expect(continued).toBe(false); expect(store.getRun(rootId)!.status).toBe("cancelled");
});

test("trusted reply route cannot change in a child; invocation signer context is inherited", async () => {
  const route = { workspaceId: "workspace", threadId: "thread", frmNpub: "npub1requester" };
  const child = definition("child", [{ name: "reply", type: "code", function: "flightdeck.returnToThread", input: { value: { ...route, frmNpub: "npub1attacker", message: "bad" } } }]);
  let delivered = false;
  const run = await runDeclarativePipeline({ ...runner(definition("parent", [call()]), [child], { "flightdeck.returnToThread": () => { delivered = true; return {}; } }), input: route,
    initiatingAgentNpub: "npub1piper", onRunCreated: parent => store.addEvent({ runId: parent.id, level: "info", type: "flightdeck_invocation_context", data: { ...route, initiatingAgentNpub: "npub1piper" } }) });
  expect(run.error).toContain("frmNpub differs"); expect(delivered).toBe(false);
});

test("an isolated process exits during a real child agent wait and a new runner recovers the durable composition", async () => {
  const repo = import.meta.dir;
  const source = `
import { PipelineStore } from ${JSON.stringify(join(repo, "pipeline-store.ts"))};
import { runDeclarativePipeline } from ${JSON.stringify(join(repo, "pipeline-runner.ts"))};
const store = new PipelineStore(${JSON.stringify(store.path)});
const make = (name, steps) => ({ id: name, name, slug: name, path: name + ".json", scope: "user", ownerAlias: "owner", spec: { name, steps } });
const child = make("process-child", [{ name: "agent", type: "agent", prompt: "fixture", assign: "$.judgment" }, { name: "finish", type: "code", function: "finish" }]);
const parent = make("process-parent", [{ name: "child", type: "pipeline", pipeline: "process-child", input: { pick: { value: "$.source" } }, assign: "$.answer" }]);
const session = { id: "fake-process-agent", agent: "goose", status: "running", port: 1, workingDirectory: "/tmp", command: [], logs: [], startedAt: new Date().toISOString() };
const adapter = { fetchStatus: async () => "stable", getPromptReadiness: async () => ({ state: "ready", reason: "fixture", observedAt: Date.now(), retryAfterMs: 1 }), deliversPromptsDirectly: () => true, waitForReady: async () => {}, sendMessage: async () => { process.exit(0); } };
await runDeclarativePipeline({ store, definition: parent, registry: { finish: input => input }, input: { source: 7, agent: { profileId: "original", botNpub: "npub1original" } }, ownerNpub: "npub1owner", ownerAlias: "owner", callbackOrigin: "http://localhost", initiatingAgentProfileId: "piper", initiatingAgentNpub: "npub1piper", defaultAgent: "goose", resolveChildDefinition: async () => child,
 sessionApiContext: { manager: { createSession: async (...args) => { if (args[6].agentChatBotNpub !== "npub1piper" || args[5] !== "npub1owner") throw new Error("lost authority"); return session; }, getSession: () => session, getAdapter: () => adapter }, isAgentType: value => value === "goose", messageStore: { recordSession() {}, listSessionMessages: () => [] }, syncSessionMessages: async () => {} }
});
process.exit(2);
`;
  const path = join(dir, "isolated-wait.ts"); writeFileSync(path, source);
  const proc = Bun.spawn([process.execPath, path], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  store = new PipelineStore(store.path);
  const p = store.listRunningRuns().find(run => run.name === "process-parent")!;
  const link = store.composition.children(p.id)[0]!;
  const c = store.getRun(link.childRunId)!; const agent = store.getStep(c.activeStepId!)!;
  expect(agent.wingmanSessionId).toBe("fake-process-agent"); expect(p.status).toBe("running");
  await acceptAgentCallback({ store, runId: c.id, stepId: agent.id, token: agent.callbackToken, payload: { runId: c.id, stepId: agent.id, status: "ok", result: { exact: true } } });
  await resumeRunningPipelineRuns({ store, sessionApiContext: { manager: { getSession: () => null }, messageStore: { listSessionMessages: () => [] } } as never, loadRegistryForRun: async () => ({ finish: input => ({ judgment: input.judgment }) }) } as never, "http://localhost");
  expect(store.getRun(p.id)!.status).toBe("ok"); expect(store.getRun(p.id)!.result!.answer).toEqual({ judgment: { exact: true } });
  expect(store.composition.children(p.id)).toHaveLength(1); expect(store.listSteps(c.id)).toHaveLength(2);
}, 10_000);


test("cancellation also stops agents whose callbacks arrived during completion grace", async () => {
  const { p, c, cs } = storedWait();
  store.setStepSession(cs.id, "grace-session");
  store.completeStep({ id: cs.id, status: "ok", result: { done: true }, output: { done: true } });
  let stopped = false;
  await cancelPipelineTree(store, { manager: { updateSessionMetadata() {}, stopSession: async () => { stopped = true; return true; } }, scheduleSessionArchive() {} } as never, p.id, "stop during grace");
  expect(stopped).toBe(true); expect(store.getRun(c.id)!.status).toBe("cancelled");
});

test("recovered successful callback finalizes a surviving agent before completing the child", async () => {
  const { p, c, cs, parentDef } = storedWait(); store.setStepSession(cs.id, "surviving-agent");
  await acceptAgentCallback({ store, runId: c.id, stepId: cs.id, token: "token", payload: { runId: c.id, stepId: cs.id, status: "ok", result: {} } });
  let stopped = false;
  const ctx = { manager: { getSession: () => stopped ? null : { status: "running", agentRuntimeStatus: "stable" }, getAdapter: () => null,
    updateSessionMetadata() {}, stopSession: async () => { stopped = true; return true; } }, messageStore: { listSessionMessages: () => [] }, syncSessionMessages: async () => {}, scheduleSessionArchive() {} };
  const run = await resumeDeclarativePipeline({ ...runner(parentDef, []), sessionApiContext: ctx as never }, p.id);
  expect(run!.status).toBe("ok"); expect(stopped).toBe(true);
});


test("late synchronous completion enforces deadline for fail and record_error", async () => {
  for (const failurePolicy of ["fail", "record_error"] as const) {
    const run = await runDeclarativePipeline(runner(definition("p", [call("child", { timeoutMs: 5, failurePolicy })]), [definition("child", [echo])], {
      echo: () => { const until = Date.now() + 30; while (Date.now() < until) {} return { late: true }; },
    }));
    expect(run.status).toBe(failurePolicy === "fail" ? "error" : "ok");
    if (failurePolicy === "record_error") expect(run.result!.answer).toMatchObject({ status: "timeout", error: "Child pipeline timeout" });
    else expect(run.error).toContain("timeout");
  }
});

test.each(["async", "sync"] as const)("expired %s child cannot dispatch code, agent or child steps", async mode => {
  for (const next of [
    { name: "side-effect", type: "code", function: "sideEffect" },
    { name: "agent-effect", type: "agent", prompt: "Must not dispatch" },
    { ...call("grandchild"), name: "nested-effect" },
  ] as DeclarativeStep[]) {
    let called = false;
    const run = await runDeclarativePipeline(runner(
      definition("p", [call("child", { timeoutMs: 5 })]),
      [definition("child", [echo, next]), definition("grandchild", [echo])],
      {
        echo: async () => {
          if (mode === "async") await Bun.sleep(15);
          else { const until = Date.now() + 15; while (Date.now() < until) {} }
          return { late: true };
        },
        sideEffect: () => { called = true; return {}; },
      },
    ));
    expect(called).toBe(false);
    expect(run.status).toBe("error");
    expect(run.error).toContain("timeout");
    const childId = store.composition.children(run.id)[0]!.childRunId;
    expect(store.listSteps(childId).map(step => step.name)).toEqual(["echo"]);
    expect(store.composition.children(childId)).toHaveLength(0);
    expect(store.getRun(childId)!.result).not.toEqual({ late: true });
  }
});

test("outer ancestor deadline limits a grandchild with a longer local timeout", async () => {
  let called = false;
  const run = await runDeclarativePipeline(runner(
    definition("p", [call("child", { timeoutMs: 10 })]),
    [definition("child", [call("grandchild", { timeoutMs: 1000 })]),
      definition("grandchild", [echo, { name: "side-effect", type: "code", function: "sideEffect" }])],
    {
      echo: async () => { await Bun.sleep(15); return { late: true }; },
      sideEffect: () => { called = true; return {}; },
    },
  ));
  expect(called).toBe(false);
  expect(run.status).toBe("error");
  expect(run.error).toContain("timeout");
  const childId = store.composition.children(run.id)[0]!.childRunId;
  const grandchildId = store.composition.children(childId)[0]!.childRunId;
  expect(store.getRun(grandchildId)!.status).toBe("error");
  expect(store.getRun(grandchildId)!.error).toBe("Child pipeline timeout");
  expect(store.listSteps(grandchildId).map(step => step.name)).toEqual(["echo"]);
});

test("fixture cleanup awaits detached child and grandchild unwind after timeout", async () => {
  let release!: (value: Record<string, unknown>) => void;
  const gate = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
  let unwound = false; let continued = false; let cleaned = false;
  const pending = runDeclarativePipeline(runner(
    definition("p", [call("child", { timeoutMs: 10 })]),
    [definition("child", [call("grandchild", { timeoutMs: 1000 })]),
      definition("grandchild", [echo, { name: "late", type: "code", function: "late" }])],
    { echo: async () => {
      try { return await gate; }
      finally { expect(existsSync(store.path)).toBe(true); unwound = true; }
    }, late: () => { continued = true; return {}; } },
  ));
  let cleanup: Promise<void> | undefined;
  try {
    const parent = await pending;
    expect(parent.status).toBe("error"); expect(parent.error).toContain("timeout");
    expect(unwound).toBe(false); expect(childLifecycle.pendingCount).toBeGreaterThan(0);
    cleanup = childLifecycle.drain().then(() => {
      expect(unwound).toBe(true); expect(continued).toBe(false);
      expect(store.getRun(parent.id)!.status).toBe("error");
      rmSync(dir, { recursive: true, force: true }); cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false); expect(existsSync(store.path)).toBe(true);
  } finally { release({ late: true }); }
  await cleanup;
  expect(childLifecycle.pendingCount).toBe(0); expect(cleaned).toBe(true);
});

test("recovery accepts on-time completion even when parent resumes after deadline", async () => {
  const { p, c, parentDef } = storedWait();
  store.completeRun(c.id, "ok", { onTime: true });
  const completedAt = Date.parse(store.getRun(c.id)!.completedAt!);
  const link = store.composition.children(p.id)[0]!;
  const db = new (await import("bun:sqlite")).Database(store.path);
  db.query("UPDATE pipeline_child_runs SET deadline = ? WHERE parent_step_id = ?").run(completedAt + 1, link.parentStepId); db.close();
  await Bun.sleep(5);
  const resumed = await resumeDeclarativePipeline(runner(parentDef, []), p.id);
  expect(resumed!.status).toBe("ok"); expect(resumed!.result!.answer).toEqual({ onTime: true });
});
