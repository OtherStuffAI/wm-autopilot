import { expect, test } from "bun:test";
import { handleSessionHistory } from "./session-history-response";

test("live history exposes saved messages without invoking upstream sync", async () => {
  const saved = [{ role: "assistant", content: "stored answer" }];
  const session = { id: "fixture", status: "running" };
  const context = {
    messageStore: { listSessionMessages: () => saved },
    serializeSession: () => session,
    syncSessionMessages: () => { throw new Error("History must not refresh upstream"); },
  };
  const response = await handleSessionHistory("fixture", session as never, "viewer", false, context as never);
  expect(await response.json()).toEqual({ id: "fixture", status: "live", session, messages: saved });
});
