import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentInboxOriginStore, setAgentInboxOriginStoresForTests } from '../agent-chat/agent-inbox-origins';
import { AgentInboxReceiptStore } from '../agent-chat/agent-inbox-receipts';
import { AgentInboxStore } from '../agent-chat/agent-inbox-store';
import { routeInboxHelperCall, type InboxHelperCall } from './agent-inbox-helper-route';

const dirs: string[] = [];
afterEach(() => {
  setAgentInboxOriginStoresForTests(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const MARKER = Buffer.from('PLAN-CONTENT-MARKER').toString('base64');
const docResult = (rowVersion: number, sha = SHA) => ({
  doc: { id: 'doc-9', title: 'Plan', row_version: rowVersion, channel_id: 'channel-1', storage_object_id: `obj-${rowVersion}` },
  canonical_version: { version_id: `doc-9:${rowVersion}`, row_version: rowVersion, body_sha256_hex: sha, storage_object_id: `obj-${rowVersion}` },
  body: { encoding: 'base64', base64_data: MARKER },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-receipts-'));
  dirs.push(dir);
  const file = join(dir, 'db.sqlite');
  const inbox = new AgentInboxStore(file);
  const origins = new AgentInboxOriginStore(file);
  const receipts = new AgentInboxReceiptStore(file);
  setAgentInboxOriginStoresForTests({ inbox, origins });
  inbox.setMode('sub-1', 'inbox_required', 'c');
  inbox.update('sub-1', { towerSubscriptionId: 'tower-sub', floorAt: '2026-11-02T00:00:00.000Z' });
  const notify = (id: string, seq: number, source: Record<string, unknown>, outcome = 'handled') => {
    inbox.beginAttempt('sub-1', id, seq, { id, seq, state: 'active', kind: 'chat_mention', occurred_at: '2026-11-03T01:00:00.000Z',
      source: { type: 'message', id: `m-${id}`, channel_id: 'channel-1', thread_id: 'thread-1', task_id: null, doc_id: null, ...source } } as any);
    inbox.markHandled('sub-1', id, seq, outcome, null);
  };
  notify('n-1', 1, {});
  notify('n-2', 2, { thread_id: 'thread-2' });
  origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
  const actions: string[] = [];
  let actionResponse: unknown = { ok: true };
  let docState = docResult(1);
  let taskState: Record<string, unknown> = { id: 'task-9', row_version: 1 };
  let fileState: Record<string, unknown> = { id: 'file-9', row_version: 1, current_version_id: 'fv-1' };
  let towerError: unknown = null;
  const deps = {
    receipts,
    fetchDocument: async () => { if (towerError) throw towerError; return docState as any; },
    fetchTask: async () => ({ task: taskState }) as any,
    fetchFile: async () => fileState,
  };
  const call = (action: string, patch: Partial<InboxHelperCall> & { ids?: Partial<InboxHelperCall['ids']> } = {}): Promise<Response> => routeInboxHelperCall({
    action, body: {}, owner: { sessionId: 'session-1', subscriptionId: 'sub-1' },
    target: { subscriptionId: 'sub-1', backendConnectionId: null, backendBaseUrl: 'https://tower.test', workspaceId: 'ws-1', appNpub: 'npub1app', botIdentity: { botNpub: 'npub1bot' } as any },
    runAction: async () => { actions.push(action); return Response.json(actionResponse); },
    runScoped: async () => { actions.push(`${action}:scoped`); return Response.json({ ok: true }); },
    ...patch,
    ids: { channelId: 'channel-1', threadId: 'thread-1', taskId: null, documentId: null, ...(patch.ids ?? {}) },
  }, deps);
  return {
    inbox, origins, receipts, actions, call, notify,
    set: (patch: { response?: unknown; doc?: ReturnType<typeof docResult>; task?: Record<string, unknown>; file?: Record<string, unknown>; error?: unknown }) => {
      if ('response' in patch) actionResponse = patch.response;
      if (patch.doc) docState = patch.doc;
      if (patch.task) taskState = patch.task;
      if (patch.file) fileState = patch.file;
      if ('error' in patch) towerError = patch.error;
    },
  };
}
const code = async (response: Response) => [response.status, ((await response.json()) as any).code ?? 'ok'];
const docReceipt = (patch: Record<string, unknown> = {}) => ({ entity_type: 'doc', entity_id: 'doc-9', receipt_row_version: 1, origin_notification_id: 'n-1', body_sha256_hex: SHA, ...patch });

describe('strict-inbox work receipts: recording', () => {
  test('keeps only the receipt Tower minted for the created entity and the origin that was sent', async () => {
    const f = fixture();
    for (const receipt of [docReceipt({ entity_id: 'doc-other' }), docReceipt({ origin_notification_id: 'n-2' }), docReceipt({ entity_type: 'task' }), docReceipt({ receipt_row_version: 0 }), null]) {
      f.set({ response: { ok: true, result: { doc: { id: 'doc-9' } }, ...(receipt ? { work_receipt: receipt } : {}) } });
      await f.call('doc_create');
      expect(f.receipts.get('sub-1', 'doc', 'doc-9')).toBeNull();
    }
    f.set({ response: { ok: true, result: { doc: { id: 'doc-9' } }, work_receipt: docReceipt() } });
    await f.call('doc_create');
    expect(f.receipts.get('sub-1', 'doc', 'doc-9')).toMatchObject({ originNotificationId: 'n-1', rowVersion: 1, bodySha256Hex: SHA });
    f.set({ response: { ok: true, result: { task: { id: 'task-9' } }, work_receipt: { entity_type: 'task', entity_id: 'task-9', receipt_row_version: 1, origin_notification_id: 'n-1', body_sha256_hex: null } } });
    await f.call('task_create');
    f.set({ response: { ok: true, file: { file: { id: 'file-9' } }, work_receipt: { entity_type: 'file', entity_id: 'file-9', receipt_row_version: 1, origin_notification_id: 'n-1', version_id: 'fv-1' } } });
    await f.call('file_upload');
    expect([f.receipts.get('sub-1', 'task', 'task-9')?.rowVersion, f.receipts.get('sub-1', 'file', 'file-9')?.versionId]).toEqual([1, 'fv-1']);
  });
});

describe('strict-inbox work receipts: follow-ups on the bot\'s own output', () => {
  async function withDoc() {
    const f = fixture();
    f.set({ response: { ok: true, result: { doc: { id: 'doc-9' } }, work_receipt: docReceipt() } });
    await f.call('doc_create');
    return f;
  }

  test('reads the receipted version only; a human edit gives 409 with no content', async () => {
    const f = await withDoc();
    const ok = await f.call('doc_get', { ids: { documentId: 'doc-9' } });
    expect(await ok.json()).toMatchObject({ ok: true, receipted: true, body: { base64_data: MARKER }, captured_base: { row_version: 1, base_body_sha256_hex: SHA } });
    for (const doc of [docResult(2), docResult(1, OTHER_SHA)]) {
      f.set({ doc });
      const response = await f.call('doc_get', { ids: { documentId: 'doc-9' } });
      const text = await response.text();
      expect([response.status, JSON.parse(text).code]).toEqual([409, 'agent_inbox_work_output_changed']);
      expect(text).not.toContain(MARKER);
    }
    f.set({ doc: docResult(1), error: Object.assign(new Error('work_output_changed'), { status: 409, code: 'work_output_changed' }) });
    expect(await code(await f.call('doc_get', { ids: { documentId: 'doc-9' } }))).toEqual([409, 'agent_inbox_work_output_changed']);
  });

  test('comments, attachments and other documents are never served through a receipt', async () => {
    const f = await withDoc();
    expect(await code(await f.call('doc_comments', { ids: { documentId: 'doc-9' } }))).toEqual([403, 'agent_inbox_no_bound_notification']);
    expect(await code(await f.call('doc_reply', { ids: { documentId: 'doc-9' } }))).toEqual([403, 'agent_inbox_write_unbound']);
    expect(await code(await f.call('doc_get', { ids: { documentId: 'doc-other' } }))).toEqual([403, 'agent_inbox_no_bound_notification']);
    expect(f.actions).toEqual(['doc_create']);
  });

  test('only sessions that acted for the receipt origin, while it is live, may use it', async () => {
    const f = await withDoc();
    expect(await code(await f.call('doc_get', { ids: { documentId: 'doc-9' }, owner: { sessionId: 'stranger', subscriptionId: 'sub-1' } })))
      .toEqual([403, 'agent_inbox_receipt_not_owned']);
    f.origins.recordTurn('session-3', { subscriptionId: 'sub-1', notificationId: 'n-2' });
    expect(await code(await f.call('doc_get', { ids: { documentId: 'doc-9' }, owner: { sessionId: 'session-3', subscriptionId: 'sub-1' } })))
      .toEqual([403, 'agent_inbox_receipt_not_owned']);
    // The same session on a later turn may follow up on output it created earlier, while that origin is live.
    f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-2' });
    expect((await f.call('doc_get', { ids: { documentId: 'doc-9' } })).status).toBe(200);
    f.inbox.markHandled('sub-1', 'n-1', 1, 'failed_permanent', null);
    expect(await code(await f.call('doc_get', { ids: { documentId: 'doc-9' } }))).toEqual([403, 'agent_inbox_receipt_not_owned']);
  });

  test('a manager follows up on a worker\'s output created under the snapshotted origin (fan-in)', async () => {
    const f = fixture();
    f.origins.recordWorker('worker-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
    f.set({ response: { ok: true, result: { doc: { id: 'doc-9' } }, work_receipt: docReceipt() } });
    await f.call('doc_create', { owner: { sessionId: 'worker-1', subscriptionId: 'sub-1', worker: true } });
    expect((await f.call('doc_get', { ids: { documentId: 'doc-9' } })).status).toBe(200);
  });

  test('an own update follows Tower\'s advanced receipt; without one the receipt is dropped and later reads fail closed', async () => {
    const f = await withDoc();
    f.set({ response: { ok: true, result: { doc: { id: 'doc-9' }, work_receipt: docReceipt({ receipt_row_version: 2, body_sha256_hex: OTHER_SHA }) } } });
    expect((await f.call('doc_update', { ids: { documentId: 'doc-9' } })).status).toBe(200);
    expect(f.receipts.get('sub-1', 'doc', 'doc-9')).toMatchObject({ rowVersion: 2, bodySha256Hex: OTHER_SHA });
    f.set({ doc: docResult(2, OTHER_SHA), response: { ok: true, result: { doc: { id: 'doc-9' } } } });
    expect((await f.call('doc_update', { ids: { documentId: 'doc-9' } })).status).toBe(200);
    expect(f.receipts.get('sub-1', 'doc', 'doc-9')).toBeNull();
    expect(await code(await f.call('doc_get', { ids: { documentId: 'doc-9' } }))).toEqual([403, 'agent_inbox_no_bound_notification']);
  });

  test('an update or task comment on changed output is refused before anything is written', async () => {
    const f = fixture();
    f.set({ response: { ok: true, result: { task: { id: 'task-9' } }, work_receipt: { entity_type: 'task', entity_id: 'task-9', receipt_row_version: 1, origin_notification_id: 'n-1' } } });
    await f.call('task_create');
    f.set({ task: { id: 'task-9', row_version: 2 } });
    for (const action of ['task_state', 'task_comment', 'task_get']) {
      expect([action, ...(await code(await f.call(action, { ids: { taskId: 'task-9' } })))]).toEqual([action, 409, 'agent_inbox_work_output_changed']);
    }
    expect(await code(await f.call('task_comments', { ids: { taskId: 'task-9' } }))).toEqual([403, 'agent_inbox_no_bound_notification']);
    expect(f.actions).toEqual(['task_create']);
    f.set({ task: { id: 'task-9', row_version: 1 } });
    expect((await f.call('task_comment', { ids: { taskId: 'task-9' } })).status).toBe(200);
    expect(f.actions).toEqual(['task_create', 'task_comment']);
  });

  test('file metadata only at the receipted file version', async () => {
    const f = fixture();
    expect(await code(await f.call('file_get', { body: { fileId: 'file-9' } }))).toEqual([403, 'agent_inbox_no_bound_notification']);
    f.set({ response: { ok: true, file: { file: { id: 'file-9' } }, work_receipt: { entity_type: 'file', entity_id: 'file-9', receipt_row_version: 1, origin_notification_id: 'n-1', version_id: 'fv-1' } } });
    await f.call('file_upload');
    expect(await (await f.call('file_get', { body: { fileId: 'file-9' } })).json()).toMatchObject({ ok: true, receipted: true, file: { id: 'file-9' } });
    f.set({ file: { id: 'file-9', row_version: 1, current_version_id: 'fv-2' } });
    expect(await code(await f.call('file_get', { body: { fileId: 'file-9' } }))).toEqual([409, 'agent_inbox_work_output_changed']);
  });
});
