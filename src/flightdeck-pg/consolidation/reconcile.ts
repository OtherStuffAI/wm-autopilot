import { record, signature, type RecordData } from "./scan.ts";

export interface ReconcileClient {
  showTask(workspace: string, task: string): Promise<unknown>;
  listTaskComments(workspace: string, task: string, limit?: number): Promise<unknown>;
  commentTask(workspace: string, task: string, body: string): Promise<unknown>;
  createTask(workspace: string, channel: string, input: { title: string; description: string; state: string }): Promise<unknown>;
}
export interface WriteIntent { body: string; attempted: boolean; task_id?: string; verified?: boolean; }
function assertTask(task: RecordData, workspace: string, channel: string): void {
  if (task.workspace_id !== workspace || task.channel_id !== channel || typeof task.id !== "string") throw new Error("Task outside approved destination");
}
/** Comments preserve descriptions, owners and active/review/done state. */
export async function linkExistingTask(client: ReconcileClient, input: {
  workspace: string; channel: string; task: string; body: string;
}, intent: WriteIntent, persist: (intent: WriteIntent) => Promise<void>): Promise<"linked" | "unchanged" | "uncertain"> {
  if (intent.body !== input.body || (intent.task_id && intent.task_id !== input.task)) throw new Error("Write intent changed");
  const fresh = record(record(await client.showTask(input.workspace, input.task)).task);
  assertTask(fresh, input.workspace, input.channel);
  const comments = async () => {
    const page = record(await client.listTaskComments(input.workspace, input.task, 200));
    if (!Array.isArray(page.comments) || page.next_cursor || page.has_more === true || page.comments.length >= 200) throw new Error("Comment reconciliation incomplete");
    return page.comments.map(record);
  };
  if ((await comments()).some(c => c.body === input.body)) return "unchanged";
  if (intent.attempted) return "uncertain";
  // Read again after comments: another investigator may have changed this task.
  const current = record(record(await client.showTask(input.workspace, input.task)).task);
  assertTask(current, input.workspace, input.channel);
  if (current.row_version !== fresh.row_version) throw new Error("Task changed; reconcile fresh task/comments before writing");
  intent.attempted = true;
  intent.task_id = input.task;
  await persist(intent);
  try { await client.commentTask(input.workspace, input.task, input.body); }
  catch { /* Readback is required even if the response was lost. */ }
  if (!(await comments()).some(c => c.body === input.body)) return "uncertain";
  intent.verified = true;
  await persist(intent);
  return "linked";
}
/** Stable description marker survives amended evidence; no server idempotency claim. */
export async function reconcileProposal(client: ReconcileClient, input: {
  workspace: string; channel: string; title: string; body: string; key: string;
}, intent: WriteIntent, readCompleteTasks: () => Promise<RecordData[]>, persist: (intent: WriteIntent) => Promise<void>): Promise<RecordData | null> {
  if (!input.key) throw new Error("Missing stable proposal key");
  const marker = `Consolidation reference: ${signature(input.key)}`;
  const description = `${input.body}\n\n${marker}`;
  const find = async () => {
    const tasks = await readCompleteTasks();
    const matches = tasks.filter(t => t.workspace_id === input.workspace && t.channel_id === input.channel && ((typeof t.description === "string" && t.description.includes(marker)) || t.id === intent.task_id));
    if (matches.length > 1) throw new Error("Multiple matching proposals require review");
    return matches[0];
  };
  const existing = await find();
  if (existing) { intent.task_id = String(existing.id); intent.verified = true; await persist(intent); return existing; }
  if (intent.attempted) return null;
  if (intent.body !== input.body) throw new Error("Proposal intent changed");
  intent.attempted = true;
  await persist(intent);
  try { await client.createTask(input.workspace, input.channel, { title: input.title, description, state: "backlog" }); }
  catch { /* Never blind-retry a create whose result is unknown. */ }
  const created = await find();
  if (!created) return null;
  assertTask(created, input.workspace, input.channel);
  intent.task_id = String(created.id);
  intent.verified = true;
  await persist(intent);
  return created;
}
