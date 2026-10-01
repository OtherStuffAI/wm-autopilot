import { inheritPipelineInvocation } from "./pipeline-run-authority";
import type { DeclarativePipeline, DeclarativeStep } from "./declarative";
import { assignOutput, selectInput } from "./declarative";
import { listPipelineDefinitions, selectLatestPipelineDefinitions, type PipelineDefinitionRecord } from "./pipeline-loader";
import { buildPipelineStepMetadata } from "./pipeline-step-metadata";
import type { PipelineStore, PipelineRunRecord, JsonObject } from "./pipeline-store";
import type { SessionApiContext } from "../server/session-api-routes";
import type { PipelineRunnerInput } from "./pipeline-runner";

export const MAX_CHILD_PIPELINE_DEPTH = 8;
const DEFAULT_CHILD_TIMEOUT_MS = 10 * 60_000;
type ChildStep = Extract<DeclarativeStep, { type: "pipeline" }>;

export function validateChildPipelineSteps(spec: DeclarativePipeline): void {
  function visit(steps: DeclarativeStep[], nested = false): void {
    for (const step of steps) {
      if (step.type === "pipeline") {
        if (nested) throw new Error("Pipeline steps must be top-level (durable cursor required)");
        if (typeof step.pipeline !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(step.pipeline)) throw new Error("Child pipeline target must be a name or definition ID, never a path");
        if (step.version !== undefined && !["string", "number"].includes(typeof step.version)) throw new Error("Invalid child pipeline version");
        if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 86_400_000)) throw new Error("Child timeoutMs must be 1..86400000");
        if (step.failurePolicy !== undefined && !["fail", "record_error"].includes(step.failurePolicy)) throw new Error("Invalid child failurePolicy");
      }
      if (step.type === "loop" && step.steps) visit(step.steps, true);
      if (step.type === "parallel") visit([step.step], true);
    }
  }
  visit(spec.steps);
}

export async function resolveChildDefinition(target: string, version: string | number | undefined, ownerAlias: string | null): Promise<PipelineDefinitionRecord> {
  const records = (await listPipelineDefinitions(ownerAlias)).filter(record => record.spec.enabled !== false
    && (record.scope === "shared" || record.ownerAlias === ownerAlias)
    && [record.id, record.name, record.slug].includes(target));
  const matches = version === undefined ? selectLatestPipelineDefinitions(records) : records.filter(record => String(record.spec.version) === String(version));
  // A user-owned family shadows a shared family only without ambiguity within the chosen scope.
  const owned = matches.filter(record => record.scope === "user");
  const eligible = owned.length ? owned : matches;
  if (eligible.length !== 1) throw new Error(`Child pipeline ${target}${version === undefined ? "" : ` version ${version}`} is missing, invisible or ambiguous`);
  return eligible[0]!;
}

function enforceAncestry(store: PipelineStore, parentId: string, definition: PipelineDefinitionRecord): void {
  let id: string | undefined = parentId;
  let depth = 0;
  while (id) {
    const run = store.getRun(id);
    if (!run) throw new Error("Missing child pipeline ancestor");
    const pinned = store.composition.snapshot(id)?.definition;
    if (run.definitionId === definition.id || pinned?.name === definition.name) throw new Error("Child pipeline cycle detected");
    depth++;
    if (depth > MAX_CHILD_PIPELINE_DEPTH) throw new Error("Child pipeline depth limit exceeded");
    id = store.composition.parent(id)?.parentRunId;
  }
}

export async function cancelPipelineTree(store: PipelineStore, ctx: SessionApiContext, id: string, reason: string): Promise<void> {
  const sessionIds = store.composition.tree(id).flatMap(runId => store.listSteps(runId))
    .flatMap(step => step.wingmanSessionId ? [step.wingmanSessionId] : []);
  store.cancelRun(id, reason);
  await Promise.all([...new Set(sessionIds)].map(async sessionId => {
    ctx.manager.updateSessionMetadata?.(sessionId, { nextAction: "stop" });
    const stopped = await ctx.manager.stopSession(sessionId);
    if (stopped) ctx.scheduleSessionArchive(sessionId, ctx.manager);
  }));
}

export async function executeChildPipeline(input: PipelineRunnerInput & {
  runId: string; step: ChildStep; current: JsonObject; nextStepIndex: () => number;
}, lifecycle: {
  start: (input: PipelineRunnerInput) => PipelineRunRecord;
  resume: (input: PipelineRunnerInput, id: string) => Promise<PipelineRunRecord | null>;
}): Promise<{ current: JsonObject }> {
  const { store, step, runId } = input;
  const parent = store.getRun(runId)!;
  const existing = parent.activeStepId ? store.getStep(parent.activeStepId) : null;
  const selected = selectInput(input.current, step.input);
  const record = existing ?? store.createStep({ runId, stepIndex: input.nextStepIndex(), name: step.name,
    kind: "pipeline", input: selected, metadata: buildPipelineStepMetadata(step) });
  store.setRunActiveStep(runId, record.id);
  if (record.status === "ok") return { current: record.result ?? input.current };
  let link = store.composition.child(record.id);
  try {
    if (!link) {
      const definition = await (input.resolveChildDefinition ?? resolveChildDefinition)(step.pipeline, step.version, input.ownerAlias);
      if (definition.scope === "user" && definition.ownerAlias !== input.ownerAlias) throw new Error("Child pipeline owner mismatch");
      if (step.version !== undefined && String(definition.spec.version) !== String(step.version)) throw new Error("Child pipeline version mismatch");
      enforceAncestry(store, runId, definition);
      if (store.getRun(runId)?.status !== "running") throw new Error("Parent is no longer running");
      lifecycle.start({ ...input, definition, input: selected, onRunCompleted: undefined,
        onRunCreated: child => {
          store.composition.link({ parentRunId: runId, parentStepId: record.id,
            childRunId: child.id, deadline: Date.now() + (step.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS) });
          inheritPipelineInvocation(store, runId, child.id);
        } });
      link = store.composition.child(record.id)!;
    } else {
      const child = store.getRun(link.childRunId);
      const snapshot = store.composition.snapshot(link.childRunId);
      if (!child || !snapshot) throw new Error("Missing pinned child run state");
      if (child.ownerNpub !== parent.ownerNpub || child.ownerAlias !== parent.ownerAlias) throw new Error("Child run authority mismatch");
      if (child.status === "running" && Date.now() < link.deadline) {
        void lifecycle.resume({ ...input, ...snapshot.context, definition: snapshot.definition,
          input: child.input, onRunCreated: undefined, onRunCompleted: undefined }, child.id);
      }
    }
    for (;;) {
      if (store.getRun(runId)?.status !== "running") {
        await cancelPipelineTree(store, input.sessionApiContext, link.childRunId, "Parent pipeline stopped");
        throw new Error("Parent pipeline stopped");
      }
      const child = store.getRun(link.childRunId);
      if (!child) throw new Error("Missing child run");
      let error: string | null = null;
      const completedAt = child.completedAt === null ? null : Date.parse(child.completedAt);
      if (child.status !== "running" && (completedAt === null || !Number.isFinite(completedAt))) {
        throw new Error("Missing child completion timestamp");
      }
      if ((completedAt !== null && completedAt >= link.deadline)
        || (child.status === "running" && Date.now() >= link.deadline)) {
        await cancelPipelineTree(store, input.sessionApiContext, child.id, "Child pipeline timeout");
        error = "Child pipeline timeout";
      } else if (child.status !== "running") {
        if (child.status === "ok") {
          const output = child.result ?? {};
          const current = assignOutput(input.current, output, step.assign);
          store.completeStep({ id: record.id, status: "ok", result: current, output });
          return { current };
        }
        error = `Child pipeline ${child.name} ${child.status}: ${child.error ?? "no result"}`;
      }
      if (error) throw new Error(error);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } catch (failure) {
    if (store.getRun(runId)?.status !== "running" || step.failurePolicy !== "record_error") throw failure;
    const error = failure instanceof Error ? failure.message : String(failure);
    const child = link ? store.getRun(link.childRunId) : null;
    const output = { status: error === "Child pipeline timeout" ? "timeout" : child?.status ?? "error",
      error, childRunId: child?.id ?? null, result: child?.result ?? null };
    const current = assignOutput(input.current, output, step.assign);
    store.completeStep({ id: record.id, status: "ok", result: current, output });
    return { current };
  }
}
