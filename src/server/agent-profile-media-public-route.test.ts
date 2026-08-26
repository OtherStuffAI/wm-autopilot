import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentProfileMediaStore, verifyAgentProfileMedia } from '../agent-chat/agent-profile-media-store';
import {
  buildAgentProfileMediaPublicUrl,
  handleAgentProfileMediaPublicRoute,
} from './agent-profile-media-public-route';

const roots: string[] = [];
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-profile-public-'));
  roots.push(root);
  const store = new AgentProfileMediaStore(join(root, 'media.db'));
  const media = store.put(verifyAgentProfileMedia(PNG, 'image/png'), {
    agentId: 'rick', botNpub: 'npub1rick', managerNpub: 'npub1manager',
  });
  return { store, media };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public agent profile media route', () => {
  test('serves immutable verified bytes for GET and headers only for HEAD', async () => {
    const f = fixture();
    const url = new URL(`https://wingman.acme.co/media/agent-profiles/${f.media.digest}`);
    const get = handleAgentProfileMediaPublicRoute(new Request(url), url, f.store)!;
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('content-length')).toBe(String(PNG.byteLength));
    expect(get.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Array.from(new Uint8Array(await get.arrayBuffer()))).toEqual(Array.from(PNG));

    const headRequest = new Request(url, { method: 'HEAD' });
    const head = handleAgentProfileMediaPublicRoute(headRequest, url, f.store)!;
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(PNG.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    f.store.close();
  });

  test('rejects unknown hashes, traversal-shaped paths, and mutation methods', () => {
    const f = fixture();
    const unknownUrl = new URL(`https://wingman.acme.co/media/agent-profiles/${'a'.repeat(64)}`);
    expect(handleAgentProfileMediaPublicRoute(new Request(unknownUrl), unknownUrl, f.store)?.status).toBe(404);
    const traversalUrl = new URL('https://wingman.acme.co/media/agent-profiles/%2e%2e%2fsecret');
    expect(handleAgentProfileMediaPublicRoute(new Request(traversalUrl), traversalUrl, f.store)?.status).toBe(404);
    const post = new Request(unknownUrl, { method: 'POST' });
    expect(handleAgentProfileMediaPublicRoute(post, unknownUrl, f.store)?.status).toBe(405);
    f.store.close();
  });

  test('requires an explicitly configured external base URL', () => {
    const digest = 'b'.repeat(64);
    expect(() => buildAgentProfileMediaPublicUrl({ baseUrl: 'http://localhost:3600', baseUrlConfigured: false, digest })).toThrow('Set an external');
    expect(() => buildAgentProfileMediaPublicUrl({ baseUrl: 'http://127.0.0.1:3600', baseUrlConfigured: true, digest })).toThrow('external HTTP');
    expect(() => buildAgentProfileMediaPublicUrl({ baseUrl: 'https://wingman.example.invalid', baseUrlConfigured: true, digest })).toThrow('external HTTP');
    expect(buildAgentProfileMediaPublicUrl({ baseUrl: 'https://wingman.acme.co', baseUrlConfigured: true, digest }))
      .toBe(`https://wingman.acme.co/media/agent-profiles/${digest}`);
  });
});
