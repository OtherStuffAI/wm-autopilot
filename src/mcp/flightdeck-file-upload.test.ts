import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { parseSessionFileUpload, uploadSessionFileToChannel } from './flightdeck-file-upload';

function identity(handler: (request: Request) => Promise<Response> | Response) {
  const secret = generateSecretKey();
  const requests: Array<{ method: string; path: string; body: any; signed: boolean }> = [];
  const botIdentity: any = {
    botNpub: nip19.npubEncode(getPublicKey(secret)), botPubkeyHex: getPublicKey(secret), botSecret: secret,
    towerTransport: { prepare: async (url: string) => url, fetch: async (url: string | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      const text = init?.body ? String(init.body) : '';
      requests.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null,
        signed: Boolean(request.headers.get('authorization')?.startsWith('Nostr ')) });
      return handler(request);
    } },
  };
  return { botIdentity, requests };
}

const base = { backendBaseUrl: 'https://tower.example', workspaceId: 'ws-1', channelId: 'channel-1', appNpub: 'npub1app', subscriptionId: 'sub-1' };

describe('session file upload', () => {
  test('validates the file name, base64 and size before any request', () => {
    const ok = Buffer.from('hello').toString('base64');
    expect(parseSessionFileUpload({ fileName: '../etc/passwd', contentType: 'text/plain', base64Data: ok })).toMatchObject({ status: 400 });
    expect(parseSessionFileUpload({ fileName: 'a.txt', contentType: 'text/plain', base64Data: 'not base64!' })).toMatchObject({ status: 400 });
    expect(parseSessionFileUpload({ fileName: 'a.txt', contentType: 'text/plain', base64Data: '' })).toMatchObject({ status: 400 });
    expect(parseSessionFileUpload({ fileName: 'a.txt', contentType: 'text/plain', base64Data: Buffer.alloc(40).toString('base64') }, 32)).toMatchObject({ status: 413 });
    const parsed = parseSessionFileUpload({ fileName: 'report.md', contentType: 'bogus', base64Data: ok });
    if ('error' in parsed) throw new Error(parsed.error);
    expect([parsed.fileName, parsed.contentType, Buffer.from(parsed.content).toString()]).toEqual(['report.md', 'application/octet-stream', 'hello']);
  });

  test('prepare -> PUT -> complete -> channel file link, every request signed by the bot', async () => {
    const { botIdentity, requests } = identity((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/storage/prepare')) return Response.json({ object_id: 'obj-1' });
      if (path === '/api/v4/storage/obj-1' && request.method === 'PUT') return Response.json({ ok: true });
      if (path === '/api/v4/storage/obj-1/complete') return Response.json({ object_id: 'obj-1', completed_at: 'now' });
      if (path.endsWith('/channels/channel-1/files')) return Response.json({ file: { id: 'file-1' } }, { status: 201 });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const result = await uploadSessionFileToChannel({ ...base, botIdentity, fileName: 'report.md', contentType: 'text/markdown', content: new TextEncoder().encode('# hi') });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/v4/flightdeck-pg/workspaces/ws-1/storage/prepare', 'PUT /api/v4/storage/obj-1',
      'POST /api/v4/storage/obj-1/complete', 'POST /api/v4/flightdeck-pg/workspaces/ws-1/channels/channel-1/files',
    ]);
    expect(requests.every((r) => r.signed)).toBe(true);
    expect(requests[3]!.body).toEqual({ storage_object_id: 'obj-1', display_name: 'report.md' });
    expect(result).toMatchObject({ storage_object_id: 'obj-1', size_bytes: 4, file: { file: { id: 'file-1' } } });
  });

  test('an ownership/binding refusal from Tower surfaces as an error and nothing is linked', async () => {
    const { botIdentity, requests } = identity((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/storage/prepare')) return Response.json({ object_id: 'obj-1' });
      if (request.method === 'PUT') return Response.json({ ok: true });
      if (path.endsWith('/complete')) return Response.json({ error: 'not your object', code: 'forbidden' }, { status: 403 });
      return Response.json({ file: { id: 'should-not-link' } });
    });
    await expect(uploadSessionFileToChannel({ ...base, botIdentity, fileName: 'x.bin', contentType: 'application/octet-stream', content: new Uint8Array([1]) })).rejects.toThrow('not your object');
    expect(requests.map((r) => r.path.split('/').at(-1))).toEqual(['prepare', 'obj-1', 'complete']);
    expect(requests.some((r) => r.path.endsWith('/files'))).toBe(false);
  });

  test('a strict-inbox upload names its live origin and surfaces only the receipt Tower minted', async () => {
    const receipt = { entity_type: 'file', entity_id: 'file-1', receipt_row_version: 1, origin_notification_id: 'n-1', body_sha256_hex: null };
    const { botIdentity, requests } = identity((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/storage/prepare')) return Response.json({ object_id: 'obj-1' });
      if (request.method === 'PUT') return Response.json({ ok: true });
      if (path.endsWith('/complete')) return Response.json({ object_id: 'obj-1' });
      return Response.json({ file: { id: 'file-1' }, work_receipt: receipt }, { status: 201 });
    });
    const result = await uploadSessionFileToChannel({ ...base, botIdentity, fileName: 'out.md', contentType: 'text/markdown',
      content: new TextEncoder().encode('# out'), originNotificationId: 'n-1' });
    expect(requests[3]!.body).toEqual({ storage_object_id: 'obj-1', display_name: 'out.md', origin_notification_id: 'n-1' });
    expect(result.work_receipt).toEqual(receipt);
    // Without an origin (legacy sessions) the request is unchanged and no receipt is surfaced.
    const legacy = identity((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/storage/prepare')) return Response.json({ object_id: 'obj-2' });
      if (request.method === 'PUT') return Response.json({ ok: true });
      if (path.endsWith('/complete')) return Response.json({ object_id: 'obj-2' });
      return Response.json({ file: { id: 'file-2' } }, { status: 201 });
    });
    const plain = await uploadSessionFileToChannel({ ...base, botIdentity: legacy.botIdentity, fileName: 'a.md', contentType: 'text/markdown', content: new TextEncoder().encode('a') });
    expect(legacy.requests[3]!.body).toEqual({ storage_object_id: 'obj-2', display_name: 'a.md' });
    expect('work_receipt' in plain).toBe(false);
  });
});

describe('strict-inbox document and task creates name the origin', () => {
  test('origin_notification_id is sent only when given', async () => {
    const { createFlightDeckPgChannelDocument, createFlightDeckPgChannelTask } = await import('../agent-chat/tower-client');
    const { botIdentity, requests } = identity((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/storage/prepare')) return Response.json({ object_id: 'obj-d' });
      if (request.method === 'PUT') return Response.json({ ok: true });
      if (path.endsWith('/complete')) return Response.json({ object_id: 'obj-d' });
      if (path.endsWith('/docs')) return Response.json({ doc: { id: 'doc-1' }, work_receipt: { entity_type: 'doc', entity_id: 'doc-1' } }, { status: 201 });
      if (path.endsWith('/tasks')) return Response.json({ task: { id: 'task-1' } }, { status: 201 });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const doc = await createFlightDeckPgChannelDocument({ ...base, botIdentity, title: 'Notes', body: '# n', originNotificationId: 'n-1' });
    await createFlightDeckPgChannelTask({ ...base, botIdentity, title: 'Follow up', originNotificationId: 'n-1' });
    await createFlightDeckPgChannelTask({ ...base, botIdentity, title: 'Legacy' });
    const bodies = requests.filter((r) => r.path.endsWith('/docs') || r.path.endsWith('/tasks')).map((r) => r.body.origin_notification_id ?? null);
    expect(bodies).toEqual(['n-1', 'n-1', null]);
    expect((doc as any).work_receipt).toEqual({ entity_type: 'doc', entity_id: 'doc-1' });
  });
});
