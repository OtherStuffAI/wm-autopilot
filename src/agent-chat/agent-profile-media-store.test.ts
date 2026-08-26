import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentProfileMediaStore,
  MAX_AGENT_PROFILE_MEDIA_BYTES,
  verifyAgentProfileMedia,
} from './agent-profile-media-store';

const roots: string[] = [];
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));
const JPEG = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64',
));
const WEBP = Uint8Array.from(Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=',
  'base64',
));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-profile-media-'));
  roots.push(root);
  const path = join(root, 'media.db');
  return { path, store: new AgentProfileMediaStore(path) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agent profile media validation and storage', () => {
  test('persists verified bytes and ownership metadata across reopen', () => {
    const f = fixture();
    const verified = verifyAgentProfileMedia(PNG, 'image/png');
    const owner = { agentId: 'profile-one', botNpub: 'npub1profileone', managerNpub: 'npub1manager' };
    const stored = f.store.put(verified, owner);
    expect(stored).toMatchObject({
      digest: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    expect(f.store.listOwners(verified.digest)).toEqual([{ ...owner, createdAt: expect.any(String) }]);
    f.store.close();

    const reopened = new AgentProfileMediaStore(f.path);
    expect(Array.from(reopened.get(verified.digest)!.bytes)).toEqual(Array.from(PNG));
    expect(reopened.listOwners(verified.digest)).toHaveLength(1);
    reopened.close();
  });

  test('deduplicates content while retaining distinct profile owners', () => {
    const f = fixture();
    const verified = verifyAgentProfileMedia(PNG, 'image/png');
    f.store.put(verified, { agentId: 'profile-one', botNpub: 'npub1profileone', managerNpub: 'npub1manager' });
    f.store.put(verified, { agentId: 'profile-two', botNpub: 'npub1profiletwo', managerNpub: 'npub1manager' });
    expect(f.store.listOwners(verified.digest).map((owner) => owner.agentId).sort()).toEqual(['profile-one', 'profile-two']);
    f.store.close();
  });

  test('rejects unsupported, unsafe, mismatched, corrupt, and oversized input', () => {
    expect(() => verifyAgentProfileMedia(PNG, 'image/jpeg')).toThrow('MIME mismatch');
    expect(() => verifyAgentProfileMedia(Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/svg+xml')).toThrow('Only JPEG, PNG, and static WebP');
    expect(() => verifyAgentProfileMedia(Buffer.from('<html>not an image</html>'), 'image/png')).toThrow('not a valid supported raster image');
    const corrupt = Uint8Array.from(PNG);
    corrupt[corrupt.length - 5] ^= 0xff;
    expect(() => verifyAgentProfileMedia(corrupt, 'image/png')).toThrow('not a valid supported raster image');
    expect(() => verifyAgentProfileMedia(new Uint8Array(MAX_AGENT_PROFILE_MEDIA_BYTES + 1), 'image/png')).toThrow('5MB limit');
  });

  test('accepts structurally valid JPEG and static WebP bytes', () => {
    expect(verifyAgentProfileMedia(JPEG, 'image/jpeg')).toMatchObject({ contentType: 'image/jpeg', size: JPEG.byteLength });
    expect(verifyAgentProfileMedia(WEBP, 'image/webp')).toMatchObject({ contentType: 'image/webp', size: WEBP.byteLength });
  });
});
