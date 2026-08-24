import type { SessionSnapshot } from "../agents/process-manager";
import { deliverSessionAgentMessage } from "../server/session-agent-message";
import { waitForSessionPromptReadiness } from "../server/session-readiness";
import type { SessionApiContext } from "../server/session-api-routes";

interface FunctionWizardInput {
  sessionApiContext: SessionApiContext;
  ownerNpub: string | null;
  ownerAlias: string;
  prompt: string;
  targetPath: string;
}

export async function startPipelineFunctionWizardSession(input: FunctionWizardInput): Promise<{
  session: Pick<SessionSnapshot, "id" | "name" | "agent" | "port" | "workingDirectory">;
  targetPath: string;
}> {
  const sessionCtx = input.sessionApiContext;
  const session = await sessionCtx.manager.createSession(
    "codex",
    process.cwd(),
    "Pipeline function wizard",
    null,
    undefined,
    input.ownerNpub ?? undefined,
    {
      AGENT: true,
      role: "pipeline-function-wizard",
      goal: "Create a new user-defined pipeline function",
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
    content: buildFunctionWizardPrompt(input),
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

function buildFunctionWizardPrompt(input: FunctionWizardInput): string {
  const docsPath = `${process.cwd()}/docs/declarative-pipelines.md`;
  const functionsPath = `${process.cwd()}/src/pipelines/functions.ts`;
  const loaderPath = `${process.cwd()}/src/pipelines/function-loader.ts`;

  return `You are a Wingmen pipeline function wizard.

User request:
${input.prompt}

Write the new user-defined pipeline function to this exact file path:
${input.targetPath}

Function rules:
- The output file must be TypeScript.
- Export const name as a stable function name, preferably in the "user.*" namespace.
- Export const description as a short human-readable description.
- Export const version as a number.
- Default-export an async or sync function named run.
- The function must accept one JSON object and return one JSON object.
- Do not return arrays or primitives at the top level.
- Do not perform destructive filesystem, network, or process actions unless the user explicitly requested that behavior.
- Keep dependencies to platform APIs already available in this repo unless you verify the dependency exists.
- Prefer deterministic TypeScript logic. Agent judgement should stay in agent steps, not code steps.

Reference material:
- Declarative pipeline docs: ${docsPath}
- Built-in function examples: ${functionsPath}
- User function loader rules: ${loaderPath}

Before you finish:
- Ensure the target directory exists.
- Write exactly one TypeScript function file at the target path.
- Run a syntax/type check such as: bun --check ${input.targetPath}
- Do not modify unrelated files.
- When the file is written and validated, set your session next action to stop if the local tooling supports it.`;
}
