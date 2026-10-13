import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArchivedDirectChatFinalReader } from "./direct-chat-archive-response";
import { readCodexSessionMessagesFromFile } from "../agents/codex-session-messages";

const record = { sessionId: "archived", prompt: "accepted m1", sourceMessageIds: ["m1"] };

test("recovers an archived native final and rejects overload/Continue/worker wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "archived-direct-final-"));
  const path = join(root, "native.jsonl");
  try {
    const rows = [
      { type: "user_message", message: "previous request" },
      { type: "agent_message", phase: "final_answer", message: "Old final" },
      { type: "user_message", message: "accepted m1" },
      { type: "error", message: "server_overloaded" },
      { type: "user_message", message: "Continue" },
      { type: "agent_message", phase: "commentary", message: "Awaiting in-flight worker" },
    ];
    const write = async () => writeFile(path, rows.map((payload, index) => JSON.stringify({ type: "event_msg",
      timestamp: `2026-10-13T06:56:0${index}.000Z`, payload })).join("\n"));
    await write();
    const archive = { getArchivedSession: () => ({ agent: "codex", metadata: { agentTransport: "codex-sdk" } }),
      getArchivedMessages: () => [] };
    const read = createArchivedDirectChatFinalReader(archive as never, { getSession: () => undefined },
      () => readCodexSessionMessagesFromFile(path, { minimumRefreshIntervalMs: 0 }));
    expect(await read(record as never)).toBeNull();
    rows.push({ type: "agent_message", phase: "final_answer", message: "Verified final awaiting publication" });
    await write();
    expect(await read(record as never)).toMatchObject({ content: "Verified final awaiting publication" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an archived SDK streaming snapshot cannot manufacture a final", async () => {
  const archive = { getArchivedSession: () => ({ agent: "codex", metadata: { agentTransport: "codex-sdk" } }),
    getArchivedMessages: () => [{ role: "user", content: "accepted m1", createdAt: "2026-10-13T06:51:00Z" },
      { role: "assistant", content: "Incomplete streamed text", createdAt: "2026-10-13T06:52:00Z" }] };
  const read = createArchivedDirectChatFinalReader(archive as never, { getSession: () => undefined },
    async (_session, saved) => saved);
  expect(await read(record as never)).toBeNull();
});
