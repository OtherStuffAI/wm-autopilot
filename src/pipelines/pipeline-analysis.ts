import type { AgentType } from "../config";
import type { SessionSnapshot } from "../agents/process-manager";
import { deliverSessionAgentMessage } from "../server/session-agent-message";
import { waitForSessionPromptReadiness } from "../server/session-readiness";
import type { SessionApiContext } from "../server/session-api-routes";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import type { PipelineRunRecord, PipelineStepSummary } from "./pipeline-store";
import { recordLiveSession } from "./pipeline-wizard";

interface PipelineAnalysisSessionInput {
  sessionApiContext: SessionApiContext;
  agent: AgentType;
  ownerNpub: string | null;
  run: PipelineRunRecord;
  definition: PipelineDefinitionRecord | null;
  steps: PipelineStepSummary[];
  callbackOrigin: string;
}

interface PipelineAnalysisPromptInput {
  run: PipelineRunRecord;
  definition: PipelineDefinitionRecord | null;
  steps: PipelineStepSummary[];
  callbackOrigin: string;
}

export async function startPipelineAnalysisSession(input: PipelineAnalysisSessionInput): Promise<{
  session: Pick<SessionSnapshot, "id" | "name" | "agent" | "port" | "workingDirectory">;
}> {
  const sessionCtx = input.sessionApiContext;
  const session = await sessionCtx.manager.createSession(
    input.agent,
    process.cwd(),
    `Analyse pipeline ${input.run.name}`.slice(0, 120),
    {
      type: "pipeline-analysis",
      id: input.run.id,
      url: `/pipelines/runs/${input.run.id}`,
      label: input.run.name,
    },
    undefined,
    input.ownerNpub ?? undefined,
    {
      AGENT: true,
      role: "pipeline-analysis",
      goal: "Analyse a pipeline run and its declaration",
      nextAction: "reflect",
      pipelineRunId: input.run.id,
      pipelineDefinitionId: input.run.definitionId,
      pipelineDefinitionPath: input.definition?.path ?? input.run.definitionPath ?? null,
    },
  );
  await recordLiveSession(sessionCtx, session);
  await waitForSessionPromptReadiness({
    getSession: (sessionId) => sessionCtx.manager.getSession(sessionId) ?? null,
    getAdapter: (sessionId) => sessionCtx.manager.getAdapter(sessionId),
    sessionId: session.id,
    host: sessionCtx.agentHost,
    timeoutMs: 120_000,
    pollIntervalMs: 250,
  });

  const delivered = await deliverSessionAgentMessage({
    agentHost: sessionCtx.agentHost,
    buildAgentUrl: sessionCtx.buildAgentUrl,
    agent: session.agent,
    port: session.port,
    content: buildPipelineAnalysisPrompt(input),
    type: "user",
    pm2Name: session.pm2Name,
    adapter: sessionCtx.manager.getAdapter(session.id),
  });
  if (!delivered.ok) {
    throw new Error(delivered.message);
  }

  return {
    session: {
      id: session.id,
      name: session.name,
      agent: session.agent,
      port: session.port,
      workingDirectory: session.workingDirectory,
    },
  };
}

export function buildPipelineAnalysisPrompt(input: PipelineAnalysisPromptInput): string {
  const docsPath = `${process.cwd()}/docs/declarative-pipelines.md`;
  const apiPath = `${process.cwd()}/src/pipelines/pipeline-api-routes.ts`;
  const runnerPath = `${process.cwd()}/src/pipelines/pipeline-runner.ts`;
  const definitionPath = input.definition?.path ?? input.run.definitionPath ?? "(definition path unavailable)";
  const definitionRef = input.definition
    ? `${input.definition.id} (${input.definition.slug})`
    : input.run.definitionId;
  const relatedRunsRef = `${input.callbackOrigin}/api/pipelines/runs`;
  const runDetailRef = `${input.callbackOrigin}/api/pipelines/runs/${encodeURIComponent(input.run.id)}?includePayload=1`;
  const definitionApiRef = `${input.callbackOrigin}/api/pipelines/definitions/${encodeURIComponent(input.run.definitionId)}`;
  const steps = input.steps.map((step) => ({
    id: step.id,
    index: step.stepIndex,
    name: step.name,
    kind: step.kind,
    status: step.status,
    agentSessionId: step.wingmanSessionId,
    error: step.error,
  }));

  return `Analyse this Wingmen pipeline run and its declaration.

Pipeline run:
${JSON.stringify({
  id: input.run.id,
  name: input.run.name,
  status: input.run.status,
  definitionId: input.run.definitionId,
  definitionPath: input.run.definitionPath,
  ownerAlias: input.run.ownerAlias,
  scope: input.run.scope,
  cursorIndex: input.run.cursorIndex,
  activeStepId: input.run.activeStepId,
  error: input.run.error,
  startedAt: input.run.startedAt,
  completedAt: input.run.completedAt,
}, null, 2)}

Pipeline definition reference:
- Definition: ${definitionRef}
- File: ${definitionPath}
- API: ${definitionApiRef}

Run references:
- Current run details: ${runDetailRef}
- Other runs from this pipeline: GET ${relatedRunsRef} and filter for definitionId="${input.run.definitionId}" or definitionSlug="${input.definition?.slug ?? input.run.definitionId}"
- Browser view: ${input.callbackOrigin}/pipelines/runs/${input.run.id}

Recorded steps:
${JSON.stringify(steps, null, 2)}

Local implementation references:
- Pipeline docs: ${docsPath}
- Pipeline API routes: ${apiPath}
- Pipeline runner: ${runnerPath}

Please inspect the run payloads, the declaration, related runs from the same pipeline, and the implementation references above. Identify likely causes, risky definition patterns, missing display metadata, brittle assumptions, and concrete code or declaration changes that would make this pipeline easier to operate. Do not make changes unless the operator asks you to implement them.`;
}
