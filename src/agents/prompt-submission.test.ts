import { expect, test } from "bun:test";
import type { AgentAdapter, AdapterStreamEvent } from "./agent-adapter";
import { submitAdapterPrompt } from "./prompt-submission";

test("submission resolves at the user boundary while the native turn remains active", async () => {
  let listener!: (event: AdapterStreamEvent) => void;
  let complete!: () => void;
  let unsubscribed = false;
  let finished = false;
  const adapter = {
    subscribeToEvents(callback: typeof listener) { listener = callback; return () => { unsubscribed = true; }; },
    async sendMessage(content: string) {
      listener({ type: "message", message: { role: "user", content, createdAt: new Date().toISOString() } });
      await new Promise<void>((resolve) => { complete = resolve; });
      finished = true;
    },
  } as unknown as AgentAdapter;
  await submitAdapterPrompt(adapter, "Work");
  expect(finished).toBe(false);
  expect(unsubscribed).toBe(true);
  complete();
});

test("submission rejects failures before the user boundary and unsubscribes", async () => {
  let unsubscribed = false;
  const adapter = {
    subscribeToEvents() { return () => { unsubscribed = true; }; },
    async sendMessage() { throw new Error("not ready"); },
  } as unknown as AgentAdapter;
  await expect(submitAdapterPrompt(adapter, "Work")).rejects.toThrow("not ready");
  expect(unsubscribed).toBe(true);
});

test("transports without native events still await their send result", async () => {
  await expect(submitAdapterPrompt({ async sendMessage() { throw new Error("rejected"); } } as unknown as AgentAdapter, "Work")).rejects.toThrow("rejected");
});
