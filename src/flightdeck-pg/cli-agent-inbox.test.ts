import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runFlightDeckPgCli } from './cli';

const ENV_KEYS = ['SESSION_ID', 'WINGMAN_URL', 'WINGMAN_CAPABILITY', 'WINGMAN_BROKER_URL', 'BOT_NPUB', 'BOT_PUBKEY_HEX', 'TOWER_URL', 'FLIGHTDECK_TOWER_URL', 'FLIGHTDECK_APP_NPUB'] as const;
let savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, Bun.env[key]]));
  for (const key of ENV_KEYS) delete Bun.env[key];
  Bun.env.SESSION_ID = 'session-inbox';
  Bun.env.WINGMAN_URL = 'http://wingman.test';
  Bun.env.WINGMAN_CAPABILITY = 'opaque-capability';
  Bun.env.BOT_NPUB = 'npub1inboxbot';
  Bun.env.BOT_PUBKEY_HEX = 'ef'.repeat(32);
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete Bun.env[key];
    else Bun.env[key] = savedEnv[key];
  }
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function router(helperResponses: Record<string, unknown>) {
  const helperActions: string[] = [];
  const towerRequests: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/mcp/wingman/flightdeck') {
      const body = await request.clone().json() as { action?: string };
      helperActions.push(String(body.action));
      if (body.action === 'context') {
        return Response.json({
          workspace: { workspaceId: 'workspace-1', backendBaseUrl: 'http://tower.test', sourceAppNpub: 'npub1app' },
          chat: { channelId: 'channel-1', threadId: 'thread-1' },
          routing: { channelId: 'channel-1', threadId: 'thread-1', bindingType: 'task', bindingId: 'task-1' },
          agentInbox: { mode: 'inbox_required' },
        });
      }
      return Response.json(helperResponses[String(body.action)] ?? { error: 'unexpected helper action' }, { status: helperResponses[String(body.action)] ? 200 : 500 });
    }
    if (url.pathname === '/api/mcp/capabilities/nip98') return Response.json({ token: 'Nostr broker-signed', signedBy: 'npub1inboxbot' });
    towerRequests.push(`${request.method} ${url.pathname}`);
    return Response.json({ error: 'raw Tower read must not happen' }, { status: 599 });
  };
  globalThis.fetch = fetchImpl as typeof fetch;
  return { fetchImpl: fetchImpl as typeof fetch, helperActions, towerRequests };
}

describe('flightdeck CLI in a strict-inbox agent session', () => {
  test('thread read and task show are served by the Autopilot helper from bound context; no raw Tower read', async () => {
    const r = router({
      thread_read: { ok: true, messages: [{ id: 'm-1', body: 'bound' }], next_cursor: null, bounded: true },
      task_get: { ok: true, task: { id: 'task-1', title: 'bound task' }, bounded: true },
    });
    const thread = await runFlightDeckPgCli(['thread', 'read', '--json'], { fetchImpl: r.fetchImpl });
    expect(thread.exitCode).toBe(0);
    expect(JSON.parse(thread.stdout!).messages[0].body).toBe('bound');
    const task = await runFlightDeckPgCli(['task', 'show', '--json'], { fetchImpl: r.fetchImpl });
    expect(JSON.parse(task.stdout!).task.title).toBe('bound task');
    expect(r.helperActions.filter((a) => a !== 'context')).toEqual(['thread_read', 'task_get']);
    expect(r.towerRequests).toEqual([]);
  });

  test('broad reads (channels, tasks, members, events, files) are refused client-side with a clear code', async () => {
    const r = router({});
    for (const argv of [['channels', 'list', '--scope', 's-1'], ['tasks', 'list'], ['members', 'list'], ['events', 'poll'], ['files', 'list'], ['threads', 'list']]) {
      const result = await runFlightDeckPgCli([...argv, '--json'], { fetchImpl: r.fetchImpl });
      expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), 1]);
      expect(result.stderr).toContain('agent_inbox_unbound_action');
    }
    expect(r.towerRequests).toEqual([]);
  });

  test('doc download writes the bound document body; task state goes through the scoped helper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-cli-'));
    dirs.push(dir);
    const r = router({
      doc_get: { ok: true, doc: { id: 'doc-1' }, body_text: '# Bound doc', notification_id: 'n-1', bounded: true },
      task_state: { ok: true, result: { task: { id: 'task-1', state: 'review' } } },
      attachment_get: { ok: true, base64_data: Buffer.from('BYTES').toString('base64'), size_bytes: 5, content_type: 'text/plain' },
    });
    const bin = join(dir, 'file.bin');
    const out = join(dir, 'doc.md');
    const download = await runFlightDeckPgCli(['doc', 'download', 'doc-1', '--out', out, '--json'], { fetchImpl: r.fetchImpl });
    expect(download.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('# Bound doc');
    const state = await runFlightDeckPgCli(['task', 'state', 'task-1', '--state', 'review', '--json'], { fetchImpl: r.fetchImpl });
    expect(state.exitCode).toBe(0);
    const attachment = await runFlightDeckPgCli(['attachment', 'download', 'obj-1', '--out', bin, '--json'], { fetchImpl: r.fetchImpl });
    expect(attachment.exitCode).toBe(0);
    expect(readFileSync(bin, 'utf8')).toBe('BYTES');
    expect(r.helperActions.filter((a) => a !== 'context')).toEqual(['doc_get', 'task_state', 'attachment_get']);
    expect(r.towerRequests).toEqual([]);
  });

  test('writes (chat reply, task comment, doc reply, doc create, file upload) go through the bound helper, never generic transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-cli-'));
    dirs.push(dir);
    const bodyFile = join(dir, 'body.md');
    await Bun.write(bodyFile, '# Notes');
    const helperBodies: Array<Record<string, unknown>> = [];
    const r = router({
      chat_reply: { ok: true, result: { message: { id: 'msg-1' } } },
      task_comment: { ok: true, result: { comment: { id: 'c-1' } } },
      doc_reply: { ok: true, result: { comment: { id: 'dc-1' } } },
      doc_create: { ok: true, result: { doc: { id: 'doc-2' } } },
      file_upload: { ok: true, storage_object_id: 'obj-9' },
    });
    const capture = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/api/mcp/wingman/flightdeck') helperBodies.push(await request.clone().json());
      return r.fetchImpl(request);
    }) as typeof fetch;
    const mention = JSON.stringify([{ type: 'agent', npub: 'npub1target', label: 'Brick' }]);
    const runs = [
      ['chat', 'reply', '--channel', 'channel-1', '--thread', 'thread-1', '--body', 'hello', '--mentions-json', mention],
      ['task', 'comment', 'task-1', '--body', 'noted'],
      ['doc', 'reply', 'doc-1', '--body', 'agreed', '--comment', 'root-1'],
      ['doc', 'create', '--channel', 'channel-1', '--title', 'Notes', '--body-file', bodyFile],
      ['file', 'upload', '--channel', 'channel-1', '--path', bodyFile, '--content-type', 'text/markdown'],
    ];
    for (const argv of runs) {
      const result = await runFlightDeckPgCli([...argv, '--json'], { fetchImpl: capture });
      expect([argv.slice(0, 2).join(' '), result.exitCode, result.stderr ?? '']).toEqual([argv.slice(0, 2).join(' '), 0, '']);
    }
    const writes = helperBodies.filter((body) => body.action !== 'context');
    expect(writes.map((body) => body.action)).toEqual(['chat_reply', 'task_comment', 'doc_reply', 'doc_create', 'file_upload']);
    expect(writes[4]).toMatchObject({ channelId: 'channel-1', fileName: 'body.md', contentType: 'text/markdown', base64_data: Buffer.from('# Notes').toString('base64') });
    expect(writes[0]).toMatchObject({ channelId: 'channel-1', threadId: 'thread-1', body: 'hello', mentions: [{ type: 'agent', npub: 'npub1target', label: 'Brick' }] });
    expect(writes[2]).toMatchObject({ documentId: 'doc-1', commentId: 'root-1' });
    expect(writes[3]).toMatchObject({ channelId: 'channel-1', title: 'Notes', body: '# Notes' });
    expect(helperBodies.some((body) => body.action === 'transport_prepare')).toBe(false);
    expect(r.towerRequests).toEqual([]);
  });
});
