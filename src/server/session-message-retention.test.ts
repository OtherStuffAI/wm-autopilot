import { describe, expect, mock, test } from "bun:test";

import type { AgentAdapter } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import { retainBusyDirectAdapterPrompt } from "./session-message-retention";

const session = {
  id: "session-1",
  status: "running",
} as SessionSnapshot;

function directAdapter(state: "ready" | "busy" | "starting" | "unreachable"): AgentAdapter {
  return {
    deliversPromptsDirectly: () => true,
    getPromptReadiness: async () => ({ state, reason: `test-${state}`, retryAfterMs: 250, observedAt: Date.now() }),
  } as AgentAdapter;
}

describe("busy direct adapter prompt retention", () => {
  test("retains a busy follow-up before attempting direct delivery", async () => {
    const addPrompt = mock(() => ({ id: "prompt-1", content: "Follow up" }));
    const maybeAutoDispatch = mock(() => undefined);

    const retained = await retainBusyDirectAdapterPrompt({
      session,
      adapter: directAdapter("busy"),
      content: "Follow up",
      addPrompt,
      maybeAutoDispatch,
    });

    expect(retained).toMatchObject({
      prompt: { id: "prompt-1", content: "Follow up" },
      readiness: { state: "busy" },
    });
    expect(addPrompt).toHaveBeenCalledWith("session-1", { content: "Follow up" });
    expect(maybeAutoDispatch).toHaveBeenCalledWith(session);
  });

  test("leaves ready and genuinely unreachable adapters on the direct error path", async () => {
    const addPrompt = mock(() => ({ id: "unexpected" }));
    for (const state of ["ready", "unreachable"] as const) {
      expect(await retainBusyDirectAdapterPrompt({
        session,
        adapter: directAdapter(state),
        content: "Prompt",
        addPrompt,
        maybeAutoDispatch: () => undefined,
      })).toBeNull();
    }
    expect(addPrompt).not.toHaveBeenCalled();
  });
});
