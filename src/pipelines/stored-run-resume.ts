import type { PipelineApiContext } from "./pipeline-api-routes";
import { blockMissingPipelineHistory, MISSING_PIPELINE_HISTORY_REASON } from "./pipeline-history-resume";
import { resumeDeclarativePipeline, resumeErroredDeclarativePipeline } from "./pipeline-runner";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { builtinPipelineFunctions } from "./functions";
import type { PipelineRunRecord } from "./pipeline-store";

export async function resumeStoredPipelineRun(
  ctx: PipelineApiContext,
  runId: string,
  callbackOrigin: string,
): Promise<void> {
  const run = ctx.store.getRun(runId);
  if (!run || run.status !== "running") return;
  const ownerAlias = run.ownerAlias;
  const snapshot = ctx.store.composition.snapshot(run.id);
  if (!snapshot) { blockMissingPipelineHistory(ctx.store, run); return; }
  const definition = snapshot.definition;
  const registry = await ctx.loadRegistryForRun?.({ run, definition })
    ?? (await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions)).registry;
  const invocationContext = snapshot.context;
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

export async function resumeStoredErroredPipelineRun(
  ctx: PipelineApiContext,
  runId: string,
  callbackOrigin: string,
): Promise<PipelineRunRecord | null> {
  const run = ctx.store.getRun(runId);
  if (!run || run.status !== "error") return run;
  const ownerAlias = run.ownerAlias;
  const snapshot = ctx.store.composition.snapshot(run.id);
  if (!snapshot) throw new Error(MISSING_PIPELINE_HISTORY_REASON);
  const definition = snapshot.definition;
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
    ...snapshot.context,
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
