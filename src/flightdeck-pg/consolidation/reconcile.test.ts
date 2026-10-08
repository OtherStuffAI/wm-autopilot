import { expect, test } from "bun:test";
import { linkExistingTask, reconcileProposal, type WriteIntent, type ReconcileClient } from "./reconcile.ts";

const task = { id: "old", workspace_id: "w", channel_id: "a", row_version: 3, state: "review", assigned_to_npub: "human" };
function client(): ReconcileClient {
  return { showTask: async () => ({ task }), listTaskComments: async () => ({ comments: [], next_cursor: null }),
    commentTask: async () => ({}), createTask: async () => ({}) };
}
test("older matching task gets one durable link without changing review or ownership; uncertain response readback succeeds", async () => {
  const c = client();
  let writes = 0;
  const comments: Array<{ body: string }> = [];
  c.listTaskComments = async () => ({ comments, next_cursor: null });
  c.commentTask = async (_w, _t, body) => { writes++; comments.push({ body }); throw new Error("response lost"); };
  const input = { workspace: "w", channel: "a", task: "old", body: "Specific batch already routed; future implementation requires Pete." };
  const intent: WriteIntent = { body: input.body, attempted: false };
  expect(await linkExistingTask(c, input, intent, async () => {})).toBe("linked");
  expect(await linkExistingTask(c, input, intent, async () => {})).toBe("unchanged");
  expect(writes).toBe(1);
  expect(task.state).toBe("review");
  expect(task.assigned_to_npub).toBe("human");
});
test("changed task between reads, incomplete comments and cross-workspace record prevent link writes", async () => {
  for (const mode of ["changed", "comments", "workspace"]) {
    const c = client();
    let reads = 0;
    let writes = 0;
    c.showTask = async () => ({ task: { ...task, row_version: mode === "changed" ? ++reads : 3, workspace_id: mode === "workspace" ? "other" : "w" } });
    c.listTaskComments = async () => ({ comments: [], next_cursor: mode === "comments" ? "more" : null });
    c.commentTask = async () => { writes++; return {}; };
    await expect(linkExistingTask(c, { workspace: "w", channel: "a", task: "old", body: "link" }, { body: "link", attempted: false }, async () => {})).rejects.toThrow();
    expect(writes).toBe(0);
  }
});
test("uncertain create readback reuses existing task; missing readback never retries creation", async () => {
  for (const visible of [true, false]) {
    const c = client();
    let creates = 0;
    const tasks: Array<Record<string, unknown>> = [];
    c.createTask = async (_w, _c, input) => { creates++; if (visible) tasks.push({ ...task, description: input.description }); throw new Error("lost response"); };
    const input = { workspace: "w", channel: "a", title: "bounded proposal", key: "stable-incident-boundary", body: "evidence plus proposal authority" };
    const intent = { body: input.body, attempted: false };
    const first = await reconcileProposal(c, input, intent, async () => tasks, async () => {});
    const second = await reconcileProposal(c, input, intent, async () => tasks, async () => {});
    expect(Boolean(first)).toBe(visible);
    expect(Boolean(second)).toBe(visible);
    expect(creates).toBe(1);
  }
});
test("stable proposal reference reuses an amended proposal and persisted ID survives removed marker", async () => {
  const c = client();
  let creates = 0;
  const tasks: Array<Record<string, unknown>> = [];
  c.createTask = async (_w, _c, i) => { creates++; tasks.push({ ...task, description: i.description }); return {}; };
  const input = { workspace: "w", channel: "a", title: "proposal", key: "same-boundary", body: "initial evidence" };
  const intent: WriteIntent = { body: input.body, attempted: false };
  await reconcileProposal(c, input, intent, async () => tasks, async () => {});
  tasks[0]!.description += "\nupdated evidence";
  await reconcileProposal(c, { ...input, body: "amended proposal" }, { body: "amended proposal", attempted: false }, async () => tasks, async () => {});
  tasks[0]!.description = "human replaced description";
  await reconcileProposal(c, { ...input, body: "amended proposal" }, intent, async () => tasks, async () => {});
  expect(creates).toBe(1);
});
