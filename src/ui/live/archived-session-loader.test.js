import { expect, test } from "bun:test";
import { loadSelectedArchivedSession, archivedSessionStatusLabel } from "./archived-session-loader.js";

test("out-of-order archive loads cannot overlay another selected conversation", async () => {
  let selected = "A";
  let state = {};
  const responses = new Map();
  const deps = { getSelectedSessionId: () => selected, getState: () => state,
    setState: next => { state = next; }, render: () => {},
    fetchHistory: id => new Promise(resolve => responses.set(id, resolve)) };
  const a = loadSelectedArchivedSession("A", deps);
  selected = "B";
  const b = loadSelectedArchivedSession("B", deps);
  responses.get("B")({ status: "archived", session: { id: "B" }, messages: [{ content: "B" }] });
  await b;
  responses.get("A")({ status: "archived", session: { id: "A" }, messages: [{ content: "A" }] });
  await a;
  expect(state.session.id).toBe("B");
  expect(state.messages).toEqual([{ content: "B" }]);
});

test("a load that completes after navigation to a live session is ignored", async () => {
  let selected = "A";
  let state = {};
  let resolve;
  const pending = loadSelectedArchivedSession("A", { getSelectedSessionId: () => selected,
    getState: () => state, setState: next => { state = next; }, render: () => {},
    fetchHistory: () => new Promise(r => { resolve = r; }) });
  selected = "live";
  resolve({ status: "archived", session: { id: "A" } });
  await pending;
  expect(state.session).toBeNull();
});

test("archive labels distinguish an interrupted Continue from a terminal final", () => {
  const messages = [{ role: "user", content: "previous" }, { role: "agent", content: "old final" },
    { role: "user", content: "new request" }, { role: "agent-error", content: "server_overloaded" },
    { role: "user", content: "Continue" }, { role: "agent-tools", content: "waiting for worker" }];
  expect(archivedSessionStatusLabel("archived", messages)).toBe("ARCHIVED · INTERRUPTED");
  messages.push({ role: "agent", content: "verified final" });
  expect(archivedSessionStatusLabel("archived", messages)).toBe("ARCHIVED");
});


test("returning to the same archive ignores the earlier request for that id", async () => {
  let selected = "A";
  let state = {};
  const responses = [];
  const deps = { getSelectedSessionId: () => selected, getState: () => state,
    setState: next => { state = next; }, render: () => {},
    fetchHistory: () => new Promise(resolve => responses.push(resolve)) };
  const oldA = loadSelectedArchivedSession("A", deps);
  selected = "B";
  const b = loadSelectedArchivedSession("B", deps);
  selected = "A";
  const newA = loadSelectedArchivedSession("A", deps);
  responses[2]({ status: "archived", session: { id: "A", name: "fresh" } });
  await newA;
  responses[0]({ status: "archived", session: { id: "A", name: "stale" } });
  responses[1]({ status: "archived", session: { id: "B" } });
  await Promise.all([oldA, b]);
  expect(state.session.name).toBe("fresh");
});
