import { describe, expect, mock, test } from "bun:test";

import type { AdapterSessionContext } from "./agent-adapter";

// A manually-driven async stream of Codex ThreadEvents so the test can inspect
// adapter state between individual streaming updates.
function createControlledStream() {
  const queue: unknown[] = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let done = false;

  const events = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return {
    events,
    emit(event: unknown) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end() {
      done = true;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: undefined, done: true });
      }
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

import { CodexAdapter, extractCodexErrorMessage } from "./codex-adapter";

describe("extractCodexErrorMessage", () => {
  test("unwraps codex JSON error envelopes", () => {
    const raw = JSON.stringify({
      detail: "The 'gpt-5.5' model requires a newer version of Codex.",
    });
    expect(extractCodexErrorMessage(raw)).toBe(
      "The 'gpt-5.5' model requires a newer version of Codex.",
    );
  });

  test("falls back to the message field when no detail is present", () => {
    expect(extractCodexErrorMessage(JSON.stringify({ message: "boom" }))).toBe("boom");
  });

  test("returns plain strings unchanged", () => {
    expect(extractCodexErrorMessage("something went wrong")).toBe("something went wrong");
  });

  test("returns a default for empty input", () => {
    expect(extractCodexErrorMessage("")).toBe("Codex turn failed");
    expect(extractCodexErrorMessage(null)).toBe("Codex turn failed");
  });

  test("returns malformed JSON verbatim", () => {
    expect(extractCodexErrorMessage("{not json")).toBe("{not json");
  });
});

describe("CodexAdapter.fetchMessages in-flight assistant", () => {
  function baseContext(): AdapterSessionContext {
    return {
      id: "session-1",
      port: 3700,
      agent: "codex",
      host: "127.0.0.1",
      workingDirectory: "/tmp",
      env: {},
    };
  }

  test("exposes the streaming assistant mid-turn and a single copy after completion", async () => {
    const stream = createControlledStream();
    const thread = {
      id: "thread-1",
      runStreamed: mock(async () => ({ events: stream.events })),
    };

    mock.module("@openai/codex-sdk", () => ({
      Codex: class {
        startThread() {
          return thread;
        }
        resumeThread() {
          return thread;
        }
      },
    }));

    const adapter = new CodexAdapter(baseContext());
    await adapter.waitForReady({ timeoutMs: 1000, pollIntervalMs: 10 });

    const turn = adapter.sendMessage("hi");
    await flush();

    // User message is recorded immediately; assistant has not streamed yet.
    expect(await adapter.fetchMessages()).toEqual([
      { role: "user", content: "hi", createdAt: expect.any(String) },
    ]);

    stream.emit({ type: "item.updated", item: { id: "a1", type: "agent_message", text: "Hel" } });
    await flush();

    // The in-flight assistant bubble must be visible to snapshot consumers.
    let snapshot = await adapter.fetchMessages();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[1]).toMatchObject({ role: "assistant", content: "Hel" });

    stream.emit({ type: "item.updated", item: { id: "a1", type: "agent_message", text: "Hello" } });
    await flush();

    snapshot = await adapter.fetchMessages();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[1]).toMatchObject({ role: "assistant", content: "Hello" });

    stream.emit({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "Hello" } });
    stream.emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    stream.end();
    await turn;

    // After completion there is exactly one assistant message — no duplicate
    // from the committed history plus a lingering pending bubble.
    const final = await adapter.fetchMessages();
    expect(final).toHaveLength(2);
    expect(final[1]).toMatchObject({ role: "assistant", content: "Hello" });
  });

  test("publishes the last completed agent message without earlier commentary", async () => {
    const stream = createControlledStream();
    const thread = {
      id: "thread-2",
      runStreamed: mock(async () => ({ events: stream.events })),
    };
    mock.module("@openai/codex-sdk", () => ({
      Codex: class {
        startThread() { return thread; }
        resumeThread() { return thread; }
      },
    }));

    const adapter = new CodexAdapter(baseContext());
    await adapter.waitForReady({ timeoutMs: 1000, pollIntervalMs: 10 });
    const turn = adapter.sendMessage("What do you think?");
    await flush();

    stream.emit({ type: "item.completed", item: { id: "commentary-1", type: "agent_message", text: "I’ll check." } });
    await flush();
    expect((await adapter.fetchMessages()).at(-1)?.content).toBe("I’ll check.");

    stream.emit({ type: "item.completed", item: { id: "commentary-2", type: "agent_message", text: "I found the details." } });
    stream.emit({ type: "item.updated", item: { id: "final", type: "agent_message", text: "My answer" } });
    await flush();
    expect((await adapter.fetchMessages()).at(-1)?.content).toBe("My answer");

    stream.emit({ type: "item.completed", item: { id: "final", type: "agent_message", text: "My answer." } });
    stream.emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    stream.end();
    await turn;

    expect(await adapter.fetchMessages()).toEqual([
      { role: "user", content: "What do you think?", createdAt: expect.any(String) },
      { role: "assistant", content: "My answer.", createdAt: expect.any(String) },
    ]);
  });
});


test("completed message rejects final text without native turn completion", async () => {
  const stream = createControlledStream();
  const thread = { id: "completion-thread", runStreamed: mock(async () => ({ events: stream.events })) };
  mock.module("@openai/codex-sdk", () => ({ Codex: class { startThread() { return thread; } } }));
  const adapter = new CodexAdapter({ id: "completion-session", port: 3700, agent: "codex", host: "127.0.0.1", workingDirectory: "/tmp", env: {} });
  await adapter.waitForReady({ timeoutMs: 1000, pollIntervalMs: 10 });
  const turn = adapter.sendCompletedMessage("input");
  await flush();
  stream.emit({ type: "item.completed", item: { id: "final", type: "agent_message", text: "Premature text" } });
  stream.end();
  await expect(turn).rejects.toThrow("Native completed assistant output missing");
});

test("completed message returns only final text after native completion", async () => {
  const stream = createControlledStream();
  const thread = { id: "completion-thread", runStreamed: mock(async () => ({ events: stream.events })) };
  mock.module("@openai/codex-sdk", () => ({ Codex: class { startThread() { return thread; } } }));
  const adapter = new CodexAdapter({ id: "completion-session", port: 3700, agent: "codex", host: "127.0.0.1", workingDirectory: "/tmp", env: {} });
  await adapter.waitForReady({ timeoutMs: 1000, pollIntervalMs: 10 });
  const turn = adapter.sendCompletedMessage("input");
  await flush();
  stream.emit({ type: "item.completed", item: { id: "commentary", type: "agent_message", text: "Thinking" } });
  stream.emit({ type: "item.completed", item: { id: "final", type: "agent_message", text: "Completed text" } });
  stream.emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  stream.end();
  expect(await turn).toBe("Completed text");
});
