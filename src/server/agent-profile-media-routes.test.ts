import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentProfileMediaStore, verifyAgentProfileMedia } from '../agent-chat/agent-profile-media-store';
import type { AgentDefinitionRecord } from '../agent-chat/types';
import {
  handleAgentProfileCreateApi,
  handleAgentProfileMediaUploadApi,
  type AgentProfileMediaApiContext,
} from './agent-profile-media-routes';
import { handleAgentChatApi } from './agent-chat-routes';

const roots: string[] = [];
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

function agent(overrides: Partial<AgentDefinitionRecord> = {}): AgentDefinitionRecord {
  return {
    agentId: 'profile-one',
    label: 'Profile One',
    botNpub: 'npub1profileone',
    workspaceOwnerNpub: 'npub1manager',
    groupNpubs: [],
    workingDirectory: '/tmp/profile-one',
    harness: 'codex',
    model: null,
    archived: false,
    publicProfile: { name: 'Profile One', picture: 'https://external.host/profile-one.jpg', about: 'Agent', nip05: null },
    capabilities: ['chat_intercept'],
    directChat: { enabled: true, sessionAgent: 'codex', directory: '/tmp/profile-one', model: null, idleRetentionMinutes: 60 },
    chatPromptTemplate: '',
    taskPromptTemplate: '',
    flowDispatchPromptTemplate: '',
    taskReviewPromptTemplate: '',
    approvalDispatchPromptTemplate: '',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    managedByNpub: 'npub1manager',
    ...overrides,
  };
}

function uploadRequest(path: string, profile: Record<string, unknown> = {}): Request {
  const form = new FormData();
  form.set('profile', JSON.stringify(profile));
  form.set('file', new File([PNG], 'untrusted-name.png', { type: 'image/png' }));
  return new Request(`https://wingman.acme.co${path}`, { method: 'POST', body: form });
}

function fixture(overrides: Partial<AgentProfileMediaApiContext> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-profile-media-route-'));
  roots.push(root);
  const store = new AgentProfileMediaStore(join(root, 'media.db'));
  let current = agent();
  const saves: AgentDefinitionRecord[] = [];
  const manager = {
    getAgentForManager: (agentId: string, managerNpub: string) => (
      agentId === current.agentId && managerNpub === current.managedByNpub ? current : null
    ),
    validateAgentWorkingDirectory: async () => {},
    saveAgentForManager: async (input: AgentDefinitionRecord) => {
      current = { ...input };
      saves.push(current);
      return current;
    },
  };
  const context = {
    manager,
    agentTypes: [{ id: 'codex', label: 'Codex', modelOptions: ['default'] }],
    profileMediaStore: store,
    profileMediaBaseUrl: 'https://wingman.acme.co',
    profileMediaBaseUrlConfigured: true,
    republishAgentProfile: async () => ({ eventId: 'event-1', createdAt: 123 }),
    ...overrides,
  } as unknown as AgentProfileMediaApiContext;
  return { context, store, saves, current: () => current };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('authenticated agent profile media mutation', () => {
  test('requires an authenticated Agent Profile manager', async () => {
    const f = fixture();
    const path = '/api/agent-chat/profiles/profile-one/media';
    const request = new Request(`https://wingman.acme.co${path}`, { method: 'POST' });
    const response = await handleAgentChatApi(
      request,
      new URL(request.url),
      'POST',
      { npub: null, session: null },
      f.context,
    );
    expect(response?.status).toBe(401);
    expect(f.saves).toHaveLength(0);
    f.store.close();
  });

  test('rejects unauthorized mutation before reading the upload', async () => {
    const f = fixture();
    const path = '/api/agent-chat/profiles/profile-one/media';
    const request = new Request(`https://wingman.acme.co${path}`, { method: 'POST' });
    const response = await handleAgentProfileMediaUploadApi(
      request, new URL(request.url), 'POST', { managerNpub: 'npub1manager', canManage: false }, f.context,
    );
    expect(response?.status).toBe(403);
    expect(f.saves).toHaveLength(0);
    f.store.close();
  });

  test('stores verified media, publishes the owned URL, then updates the local profile', async () => {
    const order: string[] = [];
    let publishedCandidate: AgentDefinitionRecord | null = null;
    const f = fixture({
      republishAgentProfile: async (candidate) => {
        order.push('publish');
        publishedCandidate = candidate;
        return { eventId: 'event-owned', createdAt: 456 };
      },
    });
    const originalSave = f.context.manager.saveAgentForManager.bind(f.context.manager);
    f.context.manager.saveAgentForManager = async (input) => {
      order.push('save');
      return originalSave(input);
    };
    const path = '/api/agent-chat/profiles/profile-one/media';
    const request = uploadRequest(path, { publicProfile: { name: 'Profile One Owned', about: 'Durable' } });
    const response = await handleAgentProfileMediaUploadApi(
      request, new URL(request.url), 'POST', { managerNpub: 'npub1manager', canManage: true }, f.context,
    );
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.media).toMatchObject({ savedLocally: true, publishedToRelays: true, contentType: 'image/png' });
    expect(body.media.publicUrl).toBe(`https://wingman.acme.co/media/agent-profiles/${body.media.digest}`);
    expect(publishedCandidate!.publicProfile).toMatchObject({ name: 'Profile One Owned', about: 'Durable', picture: body.media.publicUrl });
    expect(f.current().publicProfile?.picture).toBe(body.media.publicUrl);
    expect(order).toEqual(['publish', 'save']);
    expect(f.store.listOwners(body.media.digest)).toMatchObject([{ agentId: 'profile-one', botNpub: 'npub1profileone', managerNpub: 'npub1manager' }]);
    f.store.close();
  });

  test('retains locally saved bytes but not the candidate URL when relay publication fails', async () => {
    const f = fixture({ republishAgentProfile: async () => { throw new Error('relay unavailable'); } });
    const before = f.current().publicProfile?.picture;
    const path = '/api/agent-chat/profiles/profile-one/media';
    const request = uploadRequest(path);
    const response = await handleAgentProfileMediaUploadApi(
      request, new URL(request.url), 'POST', { managerNpub: 'npub1manager', canManage: true }, f.context,
    );
    expect(response?.status).toBe(502);
    const body = await response!.json();
    expect(body).toMatchObject({ published: false, media: { savedLocally: true, publishedToRelays: false } });
    expect(f.current().publicProfile?.picture).toBe(before);
    expect(f.saves).toHaveLength(0);
    expect(f.store.get(body.media.digest)).not.toBeNull();
    f.store.close();
  });

  test('rejects an unusable base URL before writing or publishing', async () => {
    let publishCalls = 0;
    const f = fixture({
      profileMediaBaseUrl: 'http://localhost:3600',
      profileMediaBaseUrlConfigured: true,
      republishAgentProfile: async () => { publishCalls += 1; return { eventId: 'never', createdAt: 1 }; },
    });
    const path = '/api/agent-chat/profiles/profile-one/media';
    const request = uploadRequest(path);
    const response = await handleAgentProfileMediaUploadApi(
      request, new URL(request.url), 'POST', { managerNpub: 'npub1manager', canManage: true }, f.context,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ error: expect.stringContaining('external HTTP') });
    expect(publishCalls).toBe(0);
    expect(f.store.get(verifyAgentProfileMedia(PNG, 'image/png').digest)).toBeNull();
    f.store.close();
  });

  test('rolls back a newly created identity and local media if initial publication fails', async () => {
    const f = fixture();
    const created = agent({ publicProfile: { name: 'Profile One', picture: null, about: null, nip05: null } });
    let rolledBack = false;
    f.context.manager.createAgentProfileForManager = async (input) => ({
      agent: { ...created, publicProfile: input.publicProfile },
      signedProfileEvent: { id: 'event', pubkey: '0'.repeat(64), sig: '0'.repeat(128), kind: 0, tags: [], content: '{}', created_at: 1 },
    });
    f.context.manager.rollbackCreatedAgentProfile = async () => { rolledBack = true; };
    f.context.publishAgentProfile = async () => { throw new Error('relay unavailable'); };
    const path = '/api/agent-chat/profiles';
    const request = uploadRequest(path, {
      profileId: 'profile-one', label: 'Profile One', workingDirectory: '/tmp/profile-one', harness: 'codex', name: 'Profile One',
    });
    const response = await handleAgentProfileCreateApi(
      request, new URL(request.url), 'POST', { managerNpub: 'npub1manager', canManage: true }, f.context,
    );
    expect(response?.status).toBe(502);
    expect(rolledBack).toBe(true);
    const digest = verifyAgentProfileMedia(PNG, 'image/png').digest;
    expect(f.store.get(digest)).toBeNull();
    f.store.close();
  });
});
