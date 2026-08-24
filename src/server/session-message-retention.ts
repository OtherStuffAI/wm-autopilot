import type { AgentAdapter, PromptReadiness } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";

export interface RetainedSessionPrompt {
  prompt: unknown;
  readiness: PromptReadiness;
}

interface RetainBusyDirectPromptInput {
  session: SessionSnapshot;
  adapter: AgentAdapter | null;
  content: string;
  getReadiness?: (session: SessionSnapshot) => Promise<PromptReadiness>;
  addPrompt: (sessionId: string, input: { content: string }) => unknown;
  maybeAutoDispatch: (session: SessionSnapshot) => void;
}

export async function retainBusyDirectAdapterPrompt(
  input: RetainBusyDirectPromptInput,
): Promise<RetainedSessionPrompt | null> {
  if (!input.adapter?.deliversPromptsDirectly?.()) return null;

  const readiness = input.getReadiness
    ? await input.getReadiness(input.session)
    : await input.adapter.getPromptReadiness?.(250);
  if (!readiness || readiness.state === "ready" || readiness.state === "unreachable") return null;

  return retainDirectAdapterPrompt(input, readiness);
}

export function retainDirectAdapterPrompt(
  input: RetainBusyDirectPromptInput,
  readiness: PromptReadiness,
): RetainedSessionPrompt {
  const prompt = input.addPrompt(input.session.id, { content: input.content });
  if (!prompt) {
    throw new Error("Failed to retain prompt in the session queue");
  }
  input.maybeAutoDispatch(input.session);
  return { prompt, readiness };
}
