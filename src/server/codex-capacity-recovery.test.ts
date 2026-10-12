import { expect, test } from "bun:test";
import { CodexCapacityRecovery, CODEX_CAPACITY_RETRY_MS } from "./codex-capacity-recovery";
import type { StoredMessage } from "../storage/message-store";

function fixture() {
  let running = true;
  let queued = false;
  let sent = 0;
  const timers: Array<() => void> = [];
  const messages: StoredMessage[] = [{ id: "error", sessionId: "s", role: "assistant", createdAt: "2026-10-12",
    content: "**Codex could not complete this turn.**\nSelected model is at capacity.\nError code: `server_overloaded`" }];
  const recovery = new CodexCapacityRecovery({
    isRunningCodex: () => running,
    hasQueuedPrompt: () => queued,
    readMessages: () => messages,
    queueContinue: () => { sent += 1; },
    schedule: (callback, delay) => {
      expect(delay).toBe(CODEX_CAPACITY_RETRY_MS);
      timers.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  });
  return { recovery, messages, timers, sent: () => sent, stop: () => { running = false; }, queue: () => { queued = true; } };
}

test("capacity errors schedule one continue after 21 seconds; a new error schedules another", () => {
  const f = fixture();
  expect(CODEX_CAPACITY_RETRY_MS).toBe(21000);
  f.recovery.observe("s", f.messages);
  f.recovery.observe("s", f.messages);
  expect(f.timers).toHaveLength(1);
  f.timers[0]!();
  expect(f.sent()).toBe(1);
  f.messages[0]!.id = "next-error";
  f.recovery.observe("s", f.messages);
  expect(f.timers).toHaveLength(2);
});

for (const reason of ["stopped", "queued", "new-message", "success"] as const) {
  test(`does not continue after ${reason}`, () => {
    const f = fixture();
    f.recovery.observe("s", f.messages);
    if (reason === "stopped") f.stop();
    if (reason === "queued") f.queue();
    if (reason === "new-message" || reason === "success") f.messages.push({ ...f.messages[0]!, id: "new", role: reason === "success" ? "assistant" : "user", content: "continue" });
    f.timers[0]!();
    expect(f.sent()).toBe(0);
  });
}

test("ordinary errors do not schedule recovery", () => {
  const f = fixture();
  f.messages[0]!.content = "Codex could not complete this turn. Authentication failed";
  f.recovery.observe("s", f.messages);
  expect(f.timers).toHaveLength(0);
});
