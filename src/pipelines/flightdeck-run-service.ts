import type { SessionApiContext } from "../server/session-api-routes";
import { loadPipelineFunctionRegistry } from "./function-loader";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { startDeclarativePipeline } from "./pipeline-runner";
import { builtinPipelineFunctions } from "./functions";
import { resolveFlightDeckPipelineInvocation, type FlightDeckPipelineInvocation } from "./flightdeck-invocation";
import { PipelineStore } from "./pipeline-store";

export async function startFlightDeckPipelineRun(input: {
  store: PipelineStore; sessionApiContext: SessionApiContext; definition: PipelineDefinitionRecord;
  invocation: FlightDeckPipelineInvocation; ownerNpub: string; ownerAlias: string; callbackOrigin: string;
  initiatingAgentNpub?: string | null; sourceMessageId?: string | null;
}) {
  const resolved = await resolveFlightDeckPipelineInvocation(input.invocation, input.ownerNpub);
  const functions = await loadPipelineFunctionRegistry(input.ownerAlias, builtinPipelineFunctions);
  const run = startDeclarativePipeline({ store: input.store, sessionApiContext: input.sessionApiContext,
    definition: input.definition, registry: functions.registry,
    input: { ...(input.definition.spec.input ?? {}), ...resolved.input }, ownerNpub: input.ownerNpub,
    ownerAlias: input.ownerAlias, callbackOrigin: input.callbackOrigin });
  input.store.addEvent({ runId: run.id, level: "info", type: "flightdeck_invocation_context",
    message: "Trusted Flight Deck invocation context", data: { initiatingAgentNpub: input.initiatingAgentNpub ?? null,
      sourceMessageId: input.sourceMessageId ?? null, workspaceId: resolved.input.workspaceId, threadId: resolved.input.threadId } });
  return { run, input: resolved.input, resolution: resolved.resolution };
}
