import type { PipelineStore, JsonObject } from './pipeline-store.ts';
import type { SessionSnapshot } from '../agents/process-manager.ts';
import { loadPipelineFunctionRegistry } from './function-loader.ts';
import { assertPipelineFunctionPins } from './pipeline-function-pins.ts';
import { completedTurnBindingId } from '../sessions/completed-turn-runtime.ts';

const activeInvocations=new Set<string>();

/** Tools are installed by the immutable pipeline, never named by participant input. */
export async function invokeNativeProjectTool(store: PipelineStore, session: SessionSnapshot,
  tool: string, args: JsonObject, load = loadPipelineFunctionRegistry): Promise<JsonObject> {
  const turn = store.completedTurns.activeForSession(session.id);
  if (!turn || session.metadata?.role !== 'completed-turn' || session.metadata?.nativeProjectTools!==true || session.metadata?.bindingId !== completedTurnBindingId(turn.owner,turn.conversationKey) ||
    session.npub !== turn.owner || session.workingDirectory !== JSON.parse(turn.requestJson).directory) throw Error('native_tool_turn_denied');
  const native=session.metadata.nativeAgentSession;
  if(!native||native.agent!=='codex'||native.workingDirectory!==session.workingDirectory||!native.sessionId||(turn.nativeSessionId&&turn.nativeSessionId!==native.sessionId))throw Error('native_tool_lineage_denied');
  const run = store.getRun(turn.runId), step = store.getStep(turn.stepId), snapshot = store.composition.snapshot(turn.runId);
  const tools = step?.metadata?.agentTools as Record<string,string> | undefined;
  const definitionStep=step&&snapshot?.definition.spec.steps[step.stepIndex];
  if (!run || run.status !== 'running' || run.ownerNpub !== turn.owner || run.activeStepId !== turn.stepId || step?.status !== 'running' ||
    !snapshot || definitionStep?.type!=='code' || definitionStep.function!=='session.completedTurn' || JSON.stringify(definitionStep.agentTools)!==JSON.stringify(tools) ||
    !tools || !Object.hasOwn(tools,tool) || !snapshot.context.functionHashes?.[tools[tool]!]) throw Error('native_tool_grant_denied');
  const invocationKey=JSON.stringify([store.path,turn.receiptId,tool]);
  if(activeInvocations.has(invocationKey))throw Error('native_tool_in_progress');
  activeInvocations.add(invocationKey);
  try {
    const {registry} = await load(run.ownerAlias,{});
    assertPipelineFunctionPins(snapshot.context.functionHashes,registry);
    const handler = registry[tools[tool]!];
    if (!handler) throw Error('native_tool_unavailable');
    const currentRun=store.getRun(turn.runId);
    if(store.completedTurns.activeForSession(session.id)?.receiptId!==turn.receiptId||currentRun?.status!=='running'||currentRun.activeStepId!==turn.stepId)throw Error('native_tool_lease_changed');
    // Native correlation and saved run input are broker-owned. No caller paths,
    // project IDs, run IDs, generation or authority can override them.
    const result = await handler({args, input:run.input, nativeReceipt:{receiptId:turn.receiptId,requestId:turn.requestId,
      projectId:turn.projectId,conversationKey:turn.conversationKey,runId:turn.runId,stepId:turn.stepId,sessionId:turn.sessionId,
      executionId:turn.executionId,nativeSessionId:session.metadata?.nativeAgentSession?.sessionId,sequence:turn.sequence,invocationRunId:turn.runId,invocationStepId:turn.stepId}});
    store.addEvent({runId:turn.runId,stepId:turn.stepId,level:'info',type:'native_project_tool',message:`Agent called ${tool}`,
      data:{tool,receiptId:turn.receiptId}});
    return result as JsonObject;
  }finally{activeInvocations.delete(invocationKey);}
}
