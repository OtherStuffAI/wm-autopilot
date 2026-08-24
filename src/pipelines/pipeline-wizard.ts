import type { SessionSnapshot } from "../agents/process-manager";
import { deliverSessionAgentMessage } from "../server/session-agent-message";
import { waitForSessionPromptReadiness } from "../server/session-readiness";
import type { SessionApiContext } from "../server/session-api-routes";

interface PipelineWizardInput {
  sessionApiContext: SessionApiContext;
  ownerNpub: string | null;
  ownerAlias: string;
  prompt: string;
  targetPath: string;
  sourcePath?: string | null;
  mode: "create" | "edit";
}

export async function startPipelineWizardSession(input: PipelineWizardInput): Promise<{
  session: Pick<SessionSnapshot, "id" | "name" | "agent" | "port" | "workingDirectory">;
  targetPath: string;
  sourcePath: string | null;
}> {
  const sessionCtx = input.sessionApiContext;
  const session = await sessionCtx.manager.createSession(
    "codex",
    process.cwd(),
    input.mode === "edit" ? "Pipeline edit wizard" : "Pipeline creation wizard",
    null,
    undefined,
    input.ownerNpub ?? undefined,
    {
      AGENT: true,
      role: "pipeline-wizard",
      goal: input.mode === "edit" ? "Create a new version of a pipeline declaration" : "Create a new pipeline declaration",
      nextAction: "stop",
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
    content: buildWizardPrompt(input),
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
    targetPath: input.targetPath,
    sourcePath: input.sourcePath ?? null,
  };
}

async function recordLiveSession(ctx: SessionApiContext, session: SessionSnapshot): Promise<void> {
  ctx.messageStore.recordSession({
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    name: session.name,
    npub: session.npub,
    port: session.port,
    pid: session.pid,
    workingDirectory: session.workingDirectory,
    command: session.command,
    runtimeStatus: session.agentRuntimeStatus ?? null,
    origin: session.origin ?? null,
    pm2Name: session.pm2Name,
    tmuxSession: session.tmuxSession,
    tmuxWindow: session.tmuxWindow,
    targetFile: session.targetFile,
    metadata: session.metadata,
  });
  await ctx.syncSessionMessages(session.id, true);
}

function buildWizardPrompt(input: PipelineWizardInput): string {
  const docsPath = `${process.cwd()}/docs/declarative-pipelines.md`;
  const declarativePath = `${process.cwd()}/src/pipelines/declarative.ts`;
  const functionsPath = `${process.cwd()}/src/pipelines/functions.ts`;
  const loaderPath = `${process.cwd()}/src/pipelines/pipeline-loader.ts`;
  const sourceInstructions = input.sourcePath
    ? `You are editing an existing declaration. Read this source file first:\n${input.sourcePath}\n\nWrite the revised declaration to this new version file. Do not overwrite the source file:\n${input.targetPath}`
    : `Write the new declaration to this exact file path:\n${input.targetPath}`;

  return `You are a Wingmen pipeline declaration wizard.

User request:
${input.prompt}

${sourceInstructions}

Pipeline declaration rules:
- The output file must be valid JSON.
- The root object must have "name", optional "description", optional "version", optional "supersedes", optional "input", and "steps".
- Every step must take an object and finish with an object.
- Use existing code step functions from ${functionsPath} when possible.
- Agent steps are allowed when human judgment or unstructured interpretation is needed.
- Agent step results must be assigned into the pipeline object, then parsed by a later code step when useful.
- Prefer clear step names and add "description" fields to steps so the UI can explain the flow.
- Keep file paths absolute when an agent step needs a directory.

Reference material:
- Declarative pipeline docs: ${docsPath}
- Declarative type and selector helpers: ${declarativePath}
- Built-in pipeline functions: ${functionsPath}
- Loader/versioning conventions: ${loaderPath}

Before you finish:
- Ensure the target directory exists.
- Write exactly one JSON declaration file at the target path.
- Parse the file with JSON.parse or an equivalent command to verify it is valid JSON.
- Do not modify unrelated files.
- When the file is written and validated, set your session next action to stop if the local tooling supports it.`;
}
