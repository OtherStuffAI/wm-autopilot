import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePiSessionMessages, PiAdapter } from "./pi-adapter";
import { parsePiSessionMessagesWithProgress } from "./pi-session-messages";

async function waitForCondition(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function buildFakePiRpcScript(): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const args = process.argv.slice(2);
const sessionDirIndex = args.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? args[sessionDirIndex + 1] : process.cwd();
const sessionFile = path.join(sessionDir, "session.jsonl");
let timestampCounter = 0;

function nextTimestamp() {
  const value = new Date(Date.UTC(2026, 3, 16, 8, 0, timestampCounter)).toISOString();
  timestampCounter += 1;
  return value;
}

function writeJson(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

function ensureSessionFile() {
  fs.mkdirSync(sessionDir, { recursive: true });
  if (!fs.existsSync(sessionFile)) {
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\\n");
  }
}

function readExistingEntries() {
  ensureSessionFile();
  return fs.readFileSync(sessionFile, "utf8")
    .split("\\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendMessage(message, timestamp) {
  ensureSessionFile();
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({ type: "message", timestamp, message }) + "\\n",
  );
}

function buildReply(prompt) {
  const entries = readExistingEntries();
  const previousPrompt = entries
    .filter((entry) => entry.type === "message" && entry.message && entry.message.role === "user")
    .map((entry) => entry.message.content?.[0]?.text ?? "")
    .at(-1);
  if (prompt.includes("previous requested reply")) {
    return previousPrompt ?? "unknown";
  }
  return prompt.replace("Reply with exactly: ", "");
}

function emitPromptLifecycle(id, prompt) {
  const userTimestamp = nextTimestamp();
  const assistantTimestamp = nextTimestamp();
  const reply = buildReply(prompt);
  const partial = reply.slice(0, Math.max(1, Math.min(3, reply.length)));
  const userMessage = {
    role: "user",
    timestamp: userTimestamp,
    content: [{ type: "text", text: prompt }],
  };
  const assistantPartialMessage = {
    role: "assistant",
    timestamp: assistantTimestamp,
    content: [{ type: "text", text: partial }],
  };
  const assistantMessage = {
    role: "assistant",
    timestamp: assistantTimestamp,
    content: [{ type: "text", text: reply }],
  };

  appendMessage(userMessage, userTimestamp);
  appendMessage(assistantMessage, assistantTimestamp);

  writeJson({ id, type: "response", command: "prompt", success: true });
  writeJson({ type: "agent_start" });
  writeJson({ type: "turn_start" });
  writeJson({ type: "message_start", message: userMessage });
  writeJson({ type: "message_end", message: userMessage });
  writeJson({ type: "message_start", message: { role: "assistant", timestamp: assistantTimestamp, content: [] } });
  writeJson({ type: "message_update", message: assistantPartialMessage });

  setTimeout(() => {
    writeJson({ type: "message_end", message: assistantMessage });
    writeJson({ type: "turn_end", messages: [userMessage, assistantMessage] });
    writeJson({ type: "agent_end", messages: [userMessage, assistantMessage] });
  }, 30);
}

ensureSessionFile();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let command;
  try {
    command = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (command.type === "prompt") {
    emitPromptLifecycle(command.id, command.message || "");
    return;
  }

  if (command.type === "abort") {
    writeJson({ id: command.id, type: "response", command: "abort", success: true });
    return;
  }

  writeJson({ id: command.id, type: "response", command: command.type || "unknown", success: false, error: "Unsupported command" });
});
`;
}

describe("parsePiSessionMessages", () => {
  test("extracts user and assistant text messages from session jsonl", () => {
    const content = [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-15T13:10:14.631Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Reply with alpha" }],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-15T13:10:21.116Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "alpha" },
          ],
        },
      }),
    ].join("\n");

    expect(parsePiSessionMessages(content)).toEqual([
      {
        role: "user",
        content: "Reply with alpha",
        createdAt: "2026-04-15T13:10:14.631Z",
      },
      {
        role: "assistant",
        content: "alpha",
        createdAt: "2026-04-15T13:10:21.116Z",
      },
    ]);
  });
});

describe("parsePiSessionMessagesWithProgress", () => {
  test("surfaces tool calls as actual conversation entries while pi is mid-turn", () => {
    const content = [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-16T05:10:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Inspect the repo" }],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-16T05:10:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: "ls -la" },
            },
          ],
        },
      }),
    ].join("\n");

    expect(parsePiSessionMessagesWithProgress(content)).toEqual([
      {
        role: "user",
        content: "Inspect the repo",
        createdAt: "2026-04-16T05:10:00.000Z",
      },
      {
        role: "assistant",
        content: "bash\nls -la",
        createdAt: "2026-04-16T05:10:01.000Z",
      },
    ]);
  });
});

describe("PiAdapter", () => {
  let scratchDir = "";
  const originalHome = process.env.HOME;

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
      scratchDir = "";
    }
  });

  test("uses pi session-dir continuation to preserve context across sends", async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "wingmen-pi-adapter-"));
    process.env.HOME = scratchDir;

    const piAgentDir = join(scratchDir, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(piAgentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.3-codex" }),
    );
    await writeFile(join(piAgentDir, "auth.json"), JSON.stringify({ "openai-codex": { token: "test" } }));

    const fakePiPath = join(scratchDir, "fake-pi.js");
    await writeFile(fakePiPath, buildFakePiRpcScript());
    await chmod(fakePiPath, 0o755);

    const adapter = new PiAdapter({
      id: "session-123",
      port: 3703,
      agent: "pi",
      host: "127.0.0.1",
      workingDirectory: scratchDir,
      env: { PI_CLI: fakePiPath },
    });

    await adapter.sendMessage("Reply with exactly: alpha");
    await adapter.sendMessage("What was my previous requested reply? Answer with one word.");

    await expect(adapter.fetchMessages()).resolves.toEqual([
      {
        role: "user",
        content: "Reply with exactly: alpha",
        createdAt: "2026-04-16T08:00:00.000Z",
      },
      {
        role: "assistant",
        content: "alpha",
        createdAt: "2026-04-16T08:00:01.000Z",
      },
      {
        role: "user",
        content: "What was my previous requested reply? Answer with one word.",
        createdAt: "2026-04-16T08:00:02.000Z",
      },
      {
        role: "assistant",
        content: "Reply with exactly: alpha",
        createdAt: "2026-04-16T08:00:03.000Z",
      },
    ]);

    await adapter.dispose();
  });

  test("streams partial assistant content before the turn finishes", async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "wingmen-pi-streaming-"));
    process.env.HOME = scratchDir;

    const fakePiPath = join(scratchDir, "fake-pi.js");
    await writeFile(fakePiPath, buildFakePiRpcScript());
    await chmod(fakePiPath, 0o755);

    const adapter = new PiAdapter({
      id: "session-stream",
      port: 3703,
      agent: "pi",
      host: "127.0.0.1",
      workingDirectory: scratchDir,
      env: { PI_CLI: fakePiPath },
    });

    const observedEvents: Array<{ type: string; content?: string; status?: string | null }> = [];
    const unsubscribe = adapter.subscribeToEvents((event) => {
      if (event.type === "message") {
        observedEvents.push({ type: "message", content: event.message.content });
        return;
      }
      observedEvents.push({ type: "status", status: event.status });
    });

    const sendPromise = adapter.sendMessage("Reply with exactly: hello");
    try {
      await waitForCondition(() => {
        return observedEvents.some((event) => event.type === "status" && event.status === "running")
          && observedEvents.some((event) => event.type === "message" && event.content === "hel");
      });

      expect(observedEvents.some((event) => event.type === "status" && event.status === "running")).toBe(true);
      expect(observedEvents.some((event) => event.type === "message" && event.content === "hel")).toBe(true);

      await sendPromise;

      expect(observedEvents.some((event) => event.type === "message" && event.content === "hello")).toBe(true);
      expect(observedEvents.some((event) => event.type === "status" && event.status === "stable")).toBe(true);
    } finally {
      unsubscribe();
      await adapter.dispose();
    }
  });

  test("returns a stable startup message before the first real pi turn", async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "wingmen-pi-startup-"));
    process.env.HOME = scratchDir;

    const adapter = new PiAdapter({
      id: "session-startup",
      port: 3703,
      agent: "pi",
      host: "127.0.0.1",
      workingDirectory: scratchDir,
    });

    await expect(adapter.fetchMessages()).resolves.toEqual([
      {
        role: "assistant",
        content: "Pi session started. Send a message to begin.",
        createdAt: "1970-01-01T00:00:00.000Z",
      },
    ]);

    await adapter.dispose();
  });

  test("includes tool results as actual visible content", () => {
    const content = [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-16T05:10:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Inspect the repo" }],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-16T05:10:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "src/main.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-16T05:10:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "const answer = 42;" }],
        },
      }),
    ].join("\n");

    expect(parsePiSessionMessages(content)).toEqual([
      {
        role: "user",
        content: "Inspect the repo",
        createdAt: "2026-04-16T05:10:00.000Z",
      },
      {
        role: "assistant",
        content: "read\nsrc/main.ts",
        createdAt: "2026-04-16T05:10:01.000Z",
      },
      {
        role: "assistant",
        content: "read: src/main.ts\n\nconst answer = 42;",
        createdAt: "2026-04-16T05:10:02.000Z",
      },
    ]);
  });
});
