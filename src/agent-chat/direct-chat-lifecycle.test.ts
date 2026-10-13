import { expect, test } from "bun:test";
import { isDirectChatSessionProtected } from "./direct-chat-lifecycle";

test("an awaiting accepted turn protects its own session even after activity becomes idle", () => {
  const interceptStore = { listAll: () => [{ sessionId: "manager", routingKey: "route", state: "idle", pendingMessageCount: 0 }] };
  const turnStore = { getPending: () => ({ sessionId: "manager", state: "awaiting_reply" }) };
  expect(isDirectChatSessionProtected("manager", interceptStore as never, turnStore as never)).toBe(true);
  turnStore.getPending = () => ({ sessionId: "replacement", state: "awaiting_reply" });
  expect(isDirectChatSessionProtected("manager", interceptStore as never, turnStore as never)).toBe(false);
});
