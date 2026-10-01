import type { PipelineApiContext } from "./pipeline-api-routes";
import { getPipelineDefinition } from "./pipeline-loader";
import { resumeDeclarativePipeline, resumeErroredDeclarativePipeline } from "./pipeline-runner";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { builtinPipelineFunctions } from "./functions";
import { PipelineStore, type PipelineRunRecord } from "./pipeline-store";

export async function resumeStoredPipelineRun(
  ctx: PipelineApiContext,
  runId: string,
  callbackOrigin: string,
): Promise<void> {
  const run = ctx.store.getRun(runId);
  if (!run || run.status !== "running") return;
  const ownerAlias = run.ownerAlias;
  const snapshot = ctx.store.composition.snapshot(run.id);
  const definition = snapshot?.definition ?? await getPipelineDefinition(run.definitionId, ownerAlias);
  if (!definition) {
    ctx.store.completeRun(run.id, "error", run.current, `Pipeline definition not found: ${run.definitionId}`);
    return;
  }
  const registry = await ctx.loadRegistryForRun?.({ run, definition })
    ?? (await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions)).registry;
  const invocationContext = snapshot?.context ?? readFlightDeckInvocationContext(ctx.store, run.id);
  await resumeDeclarativePipeline({
    store: ctx.store,
    sessionApiContext: ctx.sessionApiContext,
    definition,
    registry,
    input: run.input,
    ownerNpub: run.ownerNpub,
    ownerAlias,
    callbackOrigin,
    initiatingAgentProfileId: invocationContext.initiatingAgentProfileId,
    initiatingAgentNpub: invocationContext.initiatingAgentNpub,
  }, run.id);
  const parent = ctx.store.composition.parent(run.id);
  if (parent) await resumeStoredPipelineRun(ctx, parent.parentRunId, callbackOrigin);
}

function readFlightDeckInvocationContext(store: PipelineStore, runId: string): {
  initiatingAgentProfileId: string | null;
  initiatingAgentNpub: string | null;
} {
  const event = store.listEvents(runId).find((entry) => entry.type === "flightdeck_invocation_context");
  if (!event || typeof event.data_json !== "string") {
    return { initiatingAgentProfileId: null, initiatingAgentNpub: null };
  }
  try {
    const data = JSON.parse(event.data_json) as Record<string, unknown>;
    return {
      initiatingAgentProfileId: typeof data.initiatingAgentProfileId === "string" ? data.initiatingAgentProfileId : null,
      initiatingAgentNpub: typeof data.initiatingAgentNpub === "string" ? data.initiatingAgentNpub : null,
    };
  } catch {
    return { initiatingAgentProfileId: null, initiatingAgentNpub: null };
  }
}

export async function resumeStoredErroredPipelineRun(
  ctx: PipelineApiContext,
  runId: string,
  callbackOrigin: string,
): Promise<PipelineRunRecord | null> {
  const run = ctx.store.getRun(runId);
  if (!run || run.status !== "error") return run;
  const ownerAlias = run.ownerAlias;
  const snapshot = ctx.store.composition.snapshot(run.id);
  const definition = snapshot?.definition ?? await getPipelineDefinition(run.definitionId, ownerAlias);
  if (!definition) {
    const reopened = ctx.store.reopenErroredRun(run.id);
    if (!reopened || reopened.status !== "running") return reopened;
    return ctx.store.completeRun(run.id, "error", run.current, `Pipeline definition not found: ${run.definitionId}`);
  }
  const registry = await ctx.loadRegistryForRun?.({ run, definition })
    ?? (await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions)).registry;
  return await resumeErroredDeclarativePipeline({
    store: ctx.store,
    sessionApiContext: ctx.sessionApiContext,
    definition,
    registry,
    input: run.input,
    ownerNpub: run.ownerNpub,
    ownerAlias,
    callbackOrigin,
    ...(snapshot?.context ?? readFlightDeckInvocationContext(ctx.store, run.id)),
  }, run.id);
}

export async function resumeRunningPipelineRuns(
  ctx: PipelineApiContext,
  callbackOrigin: string,
): Promise<void> {
  for (const run of ctx.store.listRunningRuns()) {
    if (!ctx.store.composition.parent(run.id)) await resumeStoredPipelineRun(ctx, run.id, callbackOrigin);
  }
}
