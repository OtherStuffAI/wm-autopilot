import { createHash } from "node:crypto";

export type RecordData = Record<string, unknown>;
export interface ApprovedChannel { id: string; name: string; scope_id: string; }
export interface ScanConfig { workspace_id: string; scope_id: string; channels: ApprovedChannel[]; }
export interface ScanClient {
  listChannels(workspace: string, scope: string, limit: number): Promise<unknown>;
  showChannel(workspace: string, channel: string): Promise<unknown>;
  listTasks(workspace: string, input: { channelId: string; limit: number; cursor?: string | null }): Promise<unknown>;
}
export interface ScanResult {
  config_signature: string;
  started_at: string;
  complete: boolean;
  continuation_complete?: boolean;
  channels_checked: number;
  pages_read: number;
  requests: number;
  tasks: RecordData[];
  gaps: Array<{ channel?: string; reason: string }>;
  progress: Record<string, { cursor: string | null; done: boolean; seen: string[] }>;
}
export function signature(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function record(value: unknown): RecordData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid record");
  return value as RecordData;
}
export function assertDispatchWorkspace(config: ScanConfig, context: RecordData): void {
  if (record(context.workspace).workspaceId !== config.workspace_id) throw new Error("Configured workspace does not match dispatch workspace");
}
function rows(value: unknown): RecordData[] {
  if (!Array.isArray(value)) throw new Error("Invalid record collection");
  return value.map(record);
}
class ScanPersistenceError extends Error {}

function status(error: unknown): number {
  const e = error as { status?: number; statusCode?: number };
  return e?.status ?? e?.statusCode ?? 0;
}

/** Sequential, read-only scan. Opaque Tower cursors retain timestamp tie precision. */
export async function scanTasks(client: ScanClient, config: ScanConfig, options: {
  pageSize?: number; maxPages?: number; maxRequests?: number; resume?: ScanResult;
  save?: (result: ScanResult) => Promise<void>;
} = {}): Promise<ScanResult> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 50;
  const maxRequests = options.maxRequests ?? 80;
  if (![pageSize, maxPages, maxRequests].every(Number.isInteger) || pageSize < 1 || pageSize > 200
    || maxPages < 1 || maxPages > 100 || maxRequests < 1 || maxRequests > 200) throw new Error("Invalid scan budget");
  if (!config.workspace_id || !config.scope_id || !config.channels.length
    || new Set(config.channels.map(c => c.id)).size !== config.channels.length
    || config.channels.some(c => !c.id || !c.name || c.scope_id !== config.scope_id)) throw new Error("Invalid approved channel map");
  const configSignature = signature(config);
  if (options.resume && (options.resume.config_signature !== configSignature
    || !Array.isArray(options.resume.tasks) || options.resume.tasks.some(t => t.workspace_id !== config.workspace_id
      || typeof t.id !== "string" || !config.channels.some(c => c.id === t.channel_id))
    || Object.entries(options.resume.progress).some(([id, p]) => !config.channels.some(c => c.id === id)
      || typeof p.done !== "boolean" || !Array.isArray(p.seen)
      || !(p.cursor === null || typeof p.cursor === "string")))) throw new Error("Invalid resume or map changed");
  const result: ScanResult = options.resume ? structuredClone(options.resume) : {
    config_signature: configSignature, started_at: new Date().toISOString(), complete: false,
    channels_checked: 0, pages_read: 0, requests: 0, tasks: [], gaps: [], progress: {},
  };
  result.complete = false;
  delete result.continuation_complete;
  result.gaps = [];
  result.requests = 0;
  result.channels_checked = 0;
  let pagesThisRun = 0;
  let accessBlocks = 0;
  const request = async (fn: () => Promise<unknown>): Promise<RecordData> => {
    if (result.requests >= maxRequests) throw new Error("request_budget");
    result.requests += 1;
    return record(await fn());
  };
  const save = async () => {
    try { await options.save?.(structuredClone(result)); }
    catch { throw new ScanPersistenceError("scan_persistence_failed"); }
  };
  try {
    const enumeration = await request(() => client.listChannels(config.workspace_id, config.scope_id, 200));
    const channels = rows(enumeration.channels);
    // This route is known to truncate at 200 even when next_cursor is null.
    if (channels.length >= 200 || enumeration.next_cursor || enumeration.has_more === true) throw new Error("channel_enumeration_partial");
    if (channels.length !== config.channels.length || channels.some(c => !config.channels.some(a => a.id === c.id
      && a.name === c.name && c.workspace_id === config.workspace_id && c.scope_id === config.scope_id))) throw new Error("approved_map_changed_or_hidden");
    for (const approved of config.channels) {
      try {
        const shown = await request(() => client.showChannel(config.workspace_id, approved.id));
        const channel = record(shown.channel);
        if (channel.id !== approved.id || channel.name !== approved.name || channel.workspace_id !== config.workspace_id
          || channel.scope_id !== config.scope_id) throw new Error("channel_scope_mismatch");
        result.channels_checked += 1;
        const progress = result.progress[approved.id] ??= { cursor: null, done: false, seen: [] };
        while (!progress.done) {
          if (pagesThisRun >= maxPages) throw new Error("page_budget");
          const page = await request(() => client.listTasks(config.workspace_id, { channelId: approved.id, limit: pageSize, cursor: progress.cursor }));
          const tasks = rows(page.tasks);
          const next = page.next_cursor;
          if (page.channel_id !== approved.id || tasks.length > pageSize
            || tasks.some(t => typeof t.id !== "string" || t.workspace_id !== config.workspace_id || t.channel_id !== approved.id)) throw new Error("task_scope_mismatch");
          if (!(next === null || (typeof next === "string" && next.length > 0))
            || typeof page.has_more !== "boolean" || page.has_more !== (next !== null)
            || (next !== null && (!tasks.length || progress.seen.includes(next)))) throw new Error("invalid_or_repeated_cursor");
          const collected = new Map(result.tasks.map(t => [t.id, t]));
          for (const task of tasks) {
            const prior = collected.get(task.id);
            if (prior && (prior.workspace_id !== task.workspace_id || prior.channel_id !== task.channel_id)) throw new Error("task_identity_mismatch");
            if (!prior || Number(task.row_version) >= Number(prior.row_version)) collected.set(task.id, task);
          }
          result.tasks = [...collected.values()];
          progress.cursor = next as string | null;
          progress.done = next === null;
          if (typeof next === "string") progress.seen.push(next);
          result.pages_read += 1;
          pagesThisRun += 1;
          await save(); // Only advance the resume cursor after the whole page is durable.
        }
      } catch (error) {
        if (error instanceof ScanPersistenceError) throw error;
        const code = status(error);
        const reason = code === 401 || code === 403 ? "access_denied" : code === 429 ? "rate_limit" : code === 400 ? "invalid_cursor" :
          error instanceof Error && /^(request_budget|page_budget|channel_scope_mismatch|task_scope_mismatch|task_identity_mismatch|invalid_or_repeated_cursor)$/.test(error.message) ? error.message : "request_failed";
        result.gaps.push({ channel: approved.id, reason });
        if (reason === "access_denied") {
          // Revoked records must not be reused or exposed from a prior resume.
          result.tasks = result.tasks.filter(t => t.channel_id !== approved.id);
          delete result.progress[approved.id];
          accessBlocks += 1;
        }
        await save();
        if (accessBlocks >= 2 || reason === "rate_limit" || reason.endsWith("budget")) break;
      }
    }
  } catch (error) {
    if (error instanceof ScanPersistenceError) throw error;
    const reason = error instanceof Error && /^(channel_enumeration_partial|approved_map_changed_or_hidden|request_budget)$/.test(error.message) ? error.message : "channel_enumeration_failed";
    // An unverified/hidden map cannot reuse cached private records.
    result.tasks = [];
    result.progress = {};
    result.gaps.push({ reason });
  }
  result.complete = result.gaps.length === 0 && config.channels.every(c => result.progress[c.id]?.done);
  if (options.resume && result.complete) {
    // Continuation proves traversal of old pages, not current completeness. New or
    // changed tasks can have moved ahead of a saved cursor or completed channel.
    result.continuation_complete = true;
    result.complete = false;
    result.gaps.push({ reason: "resumed_scan_requires_fresh_pass" });
  }
  await save();
  return result;
}
export function scanSummary(scan: ScanResult) {
  return { complete: scan.complete, channels: scan.channels_checked, pages: scan.pages_read, tasks: scan.tasks.length,
    requests: scan.requests, gaps: scan.gaps.map(g => g.reason) };
}
