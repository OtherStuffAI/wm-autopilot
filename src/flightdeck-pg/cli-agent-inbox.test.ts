import { nip19 } from "nostr-tools";
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
  const towerAuth: Array<string | null> = [];
  const signed: string[] = [];
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
    if (url.pathname === '/api/mcp/capabilities/nip98') {
      const body = await request.clone().json() as { url: string; method: string };
      signed.push(`${body.method} ${body.url}`);
      return Response.json({ token: 'Nostr broker-signed', signedBy: 'npub1inboxbot' });
    }
    towerRequests.push(`${request.method} ${url.pathname}`);
    towerAuth.push(request.headers.get('authorization'));
    // Tower is the authority: the fixture refuses one foreign record the way the ACL does.
    if (url.pathname.includes('/tasks/task-foreign')) return Response.json({ error: 'Task unavailable', code: 'task_unavailable' }, { status: 404 });
    if (url.pathname.includes('/channels/channel-closed/')) return Response.json({ error: 'Forbidden', code: 'permission_denied' }, { status: 403 });
    return Response.json({ ok: true, messages: [{ id: 'm-1', body: 'from tower' }], next_cursor: null, effective_transcript: true, task: { id: 'task-2', title: 'tower task' },
      comments: [], tasks: [], channels: [] });
  };
  globalThis.fetch = fetchImpl as typeof fetch;
  return { fetchImpl: fetchImpl as typeof fetch, helperActions, towerRequests, towerAuth, signed };
}

describe('flightdeck CLI in a strict-inbox agent session', () => {
  test('reads outside the notified thread go to Tower signed by the session bot, not to bound context', async () => {
    const r = router({});
    const thread = await runFlightDeckPgCli(['thread', 'read', 'thread-other', '--channel', 'channel-2', '--json'], { fetchImpl: r.fetchImpl });
    expect([thread.exitCode, thread.stderr ?? '']).toEqual([0, '']);
    expect(JSON.parse(thread.stdout!).messages[0].body).toBe('from tower');
    const task = await runFlightDeckPgCli(['task', 'show', 'task-2', '--json'], { fetchImpl: r.fetchImpl });
    expect([task.exitCode, task.stderr ?? '']).toEqual([0, '']);
    for (const argv of [['doc', 'comments', 'doc-9'], ['tasks', 'list', '--channel', 'channel-2']]) {
      const result = await runFlightDeckPgCli([...argv, '--json'], { fetchImpl: r.fetchImpl });
      expect([argv.join(' '), result.exitCode, result.stderr ?? '']).toEqual([argv.join(' '), 0, '']);
    }
    expect(r.helperActions.filter((a) => a !== 'context')).toEqual([]);
    expect(r.towerRequests).toContainEqual(expect.stringContaining('GET /api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-2/'));
    expect(r.towerRequests).toContain('GET /api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-2');
    expect(r.towerRequests.some((line) => line.includes('/docs/doc-9/comments'))).toBe(true);
    // Every Tower request carries the broker signature for that exact request; the session never holds a key.
    expect(r.towerAuth.every((auth) => auth === 'Nostr broker-signed')).toBe(true);
    expect(r.signed.length).toBe(r.towerRequests.length);
    expect(r.signed.every((line) => line.startsWith('GET http://tower.test/api/v4/flightdeck-pg/workspaces/workspace-1/'))).toBe(true);
  });

  test('Tower ACL refusals reach the caller unchanged; nothing is answered locally', async () => {
    const r = router({});
    const foreign = await runFlightDeckPgCli(['task', 'show', 'task-foreign', '--json'], { fetchImpl: r.fetchImpl });
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr).toContain('Task unavailable');
    const closed = await runFlightDeckPgCli(['thread', 'read', 'thread-x', '--channel', 'channel-closed', '--json'], { fetchImpl: r.fetchImpl });
    expect(closed.exitCode).toBe(1);
    expect(closed.stderr).toMatch(/permission_denied|Forbidden/);
    expect(r.helperActions.filter((a) => a !== 'context')).toEqual([]);
  });

  test('task state goes through the helper; a write to another workspace uses the ordinary signed client', async () => {
    const r = router({ task_state: { ok: true, result: { task: { id: 'task-1', state: 'review' } } } });
    const state = await runFlightDeckPgCli(['task', 'state', 'task-1', '--state', 'review', '--json'], { fetchImpl: r.fetchImpl });
    expect(state.exitCode).toBe(0);
    expect(r.helperActions.filter((a) => a !== 'context')).toEqual(['task_state']);
    const elsewhere = await runFlightDeckPgCli(['task', 'comment', 'task-7', '--workspace', 'workspace-2', '--body', 'hi', '--json'], { fetchImpl: r.fetchImpl });
    expect([elsewhere.exitCode, elsewhere.stderr ?? '']).toEqual([0, '']);
    expect(r.helperActions.filter((a) => a !== 'context')).toEqual(['task_state']);
    expect(r.towerRequests).toContain('POST /api/v4/flightdeck-pg/workspaces/workspace-2/tasks/task-7/comments');
  });

  test('writes (chat reply, task comment, doc reply, doc create, file upload) go through the session helper, never generic transport', async () => {
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
    const targetNpub = nip19.npubEncode('2'.repeat(64));
    const mention = JSON.stringify([{ type: 'agent', npub: targetNpub, label: 'Brick' }]);
    const runs = [
      ['chat', 'reply', '--channel', 'channel-1', '--thread', 'thread-1', '--body', 'hello', '--mentions-json', mention],
      ['task', 'comment', 'task-1', '--body', 'noted'],
      ['doc', 'reply', 'doc-1', '--body', 'agreed', '--comment', 'root-1', '--mentions-json', mention],
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
    expect(writes[0]).toMatchObject({ channelId: 'channel-1', threadId: 'thread-1', body: `hello\n\n@[Brick](mention:agent:${targetNpub})`, mentions: [{ type: 'agent', npub: targetNpub, label: 'Brick' }] });
    expect(writes[2]).toMatchObject({ documentId: 'doc-1', commentId: 'root-1', body: `agreed\n\n@[Brick](mention:agent:${targetNpub})`, mentions: [{ type: 'agent', npub: targetNpub, label: 'Brick' }] });
    expect(writes[3]).toMatchObject({ channelId: 'channel-1', title: 'Notes', body: '# Notes' });
    expect(helperBodies.some((body) => body.action === 'transport_prepare')).toBe(false);
    expect(r.towerRequests).toEqual([]);
  });

  test('cross-workspace comments retain mentions through ordinary broker-signed client', async () => {
    const r = router({});
    const payloads: Record<string, unknown>[] = [];
    const fetchImpl = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("tower.test") && request.method === "POST") payloads.push(await request.clone().json());
      return r.fetchImpl(request);
    }) as typeof fetch;
    globalThis.fetch = fetchImpl;
    const npub = nip19.npubEncode("2".repeat(64));
    for (const area of ["task", "doc"]) {
      const result = await runFlightDeckPgCli([area, area === "task" ? "comment" : "reply", "id", "--workspace", "workspace-2", "--body", "hello", "--mentions-json", JSON.stringify([{ type: "agent", npub, label: "Peer" }])], { fetchImpl });
      expect(result.exitCode).toBe(0);
    }
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) expect(payload).toMatchObject({ body: `hello\n\n@[Peer](mention:agent:${npub})`, mentions: [{ type: "agent", npub, label: "Peer" }] });
    expect(r.helperActions.filter(action => action !== "context")).toEqual([]);
    expect(r.towerAuth).toEqual(["Nostr broker-signed", "Nostr broker-signed"]);
  });

  test('new strict-inbox thread uses helper provenance and explicit createThread', async () => {
    const r = router({ chat_reply: { ok: true } });
    const writes: Record<string, unknown>[] = [];
    const fetchImpl = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("/api/mcp/wingman/flightdeck")) writes.push(await request.clone().json());
      return r.fetchImpl(request);
    }) as typeof fetch;
    const result = await runFlightDeckPgCli(["thread", "create", "--channel", "channel-1", "--body", "New topic"], { fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(writes.find(body => body.action === "chat_reply")).toMatchObject({ channelId: "channel-1", createThread: true, body: "New topic" });
    expect(r.towerRequests).toEqual([]);
  });

  test('task create goes through the session helper with the requested channel; never generic transport', async () => {
    const helperBodies: Array<Record<string, unknown>> = [];
    const r = router({ task_create: { ok: true, result: { task: { id: 'task-9' } } } });
    const capture = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/api/mcp/wingman/flightdeck') helperBodies.push(await request.clone().json());
      return r.fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = capture;
    const created = await runFlightDeckPgCli(['task', 'create', '--title', 'Follow up', '--body', 'Details', '--priority', 'rock', '--json'], { fetchImpl: capture });
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout!).result.task.id).toBe('task-9');
    expect(helperBodies.find((body) => body.action === 'task_create')).toMatchObject({
      action: 'task_create', channelId: 'channel-1', title: 'Follow up', description: 'Details', priority: 'rock', threadId: null,
    });
    expect(r.towerRequests).toEqual([]);
  });
});
