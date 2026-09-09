#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

if (process.env.WINGMAN_ISOLATED_TEST_RUNTIME !== "1") {
  throw new Error("Deterministic ACP requires WINGMAN_ISOLATED_TEST_RUNTIME=1");
}

const sessions = new Set<string>();
function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  } else if (method === "session/new") {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    send({ jsonrpc: "2.0", id, result: { sessionId } });
  } else if (method === "session/prompt" && sessions.has(params.sessionId)) {
    const text = params.prompt.filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text).join("\n");
    const digest = createHash("sha256").update(text).digest("hex");
    // Fingerprint the authoritative prompt without echoing its private content.
    // The real turn bridge publishes this completed response with its signer.
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Isolated release test reply. Prompt SHA-256: ${digest}` },
    } } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else if (method !== "session/cancel" && id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported isolated ACP request" } });
  }
});
