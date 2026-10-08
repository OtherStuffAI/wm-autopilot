import type { AgentAdapter } from "./agent-adapter";
import { writeServerLog } from "../logging/server-logger";

/** Native turns can run for minutes; recording the user prompt is the submission boundary. */
export async function submitAdapterPrompt(adapter: AgentAdapter, content: string, type = "user"): Promise<void> {
  let accepted = false;
  let resolveAccepted!: () => void;
  const acceptance = new Promise<void>((resolve) => { resolveAccepted = resolve; });
  const unsubscribe = adapter.subscribeToEvents?.((event) => {
    if (event.type === "message" && event.message.role === "user" && event.message.content === content) {
      accepted = true;
      resolveAccepted();
    }
  });
  try {
    const completion = Promise.resolve().then(() => adapter.sendMessage(content, type)).catch((error) => {
      if (!accepted) throw error;
      writeServerLog("ERROR", "Agent turn failed after prompt submission", error);
    });
    await Promise.race([acceptance, completion]);
  } finally {
    unsubscribe?.();
  }
}
