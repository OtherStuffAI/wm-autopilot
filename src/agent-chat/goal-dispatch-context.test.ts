import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { goalReference, resolveGoalDispatchContext, goalOutputMetadata, goalContextSection, GoalReadFailure, type GoalContextReader } from './goal-dispatch-context';
import { buildRehydratedDirectChatEnvelope } from './direct-chat-prompt-envelope';

const workspace = '11111111-1111-4111-8111-111111111111';
const channel = '22222222-2222-4222-8222-222222222222';
const thread = '33333333-3333-4333-8333-333333333333';
const goalId = '44444444-4444-4444-8444-444444444444';
const versionId = '55555555-5555-4555-8555-555555555555';
const pinId = '66666666-6666-4666-8666-666666666666';
const secondId = '77777777-7777-4777-8777-777777777777';
const thirdId = '88888888-8888-4888-8888-888888888888';
const reference = { version: 1 as const, goal_file_id: goalId };
const route = { workspaceId: workspace, channelId: channel, threadId: thread, backendBaseUrl: 'https://tower.test', appNpub: 'app',
  botIdentity: { botNpub: 'bot', botPubkeyHex: 'key', signNip98: async () => 'signed', signNostrEvent: async () => ({}) } };
const base = `/api/v4/flightdeck-pg/workspaces/${workspace}`;
function fixture(patch: { denied?: string; filePatch?: Record<string, unknown>; goalPatch?: Record<string, unknown>; threadPatch?: Record<string, unknown>; corrupt?: boolean } = {}) {
  const goal = { schema: 'ambulando.goal', schema_version: 1, name: 'Purpose', description: 'Make progress', status: 'active', pinned_refs: [{ type: 'doc', record_id: pinId }], ...patch.goalPatch };
  const bytes = new TextEncoder().encode(JSON.stringify(goal));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const paths: string[] = [];
  const reader: GoalContextReader = {
    json: async path => {
      paths.push(path); if (patch.denied && path.endsWith(patch.denied)) throw new GoalReadFailure(403);
      if (path.endsWith(`/threads/${thread}`)) return { thread: { id: thread, workspace_id: workspace, channel_id: channel, metadata: { ambulando_goal: reference }, ...patch.threadPatch } };
      if (path.endsWith(`/docs/${pinId}`)) return { doc: { id: pinId, workspace_id: workspace, channel_id: channel, title: 'Vision', row_version: 3 } };
      const id = path.split('/').at(-1)!;
      return { file: { id, workspace_id: workspace, content_type: 'application/vnd.ambulando.goal+json', metadata: { goal: { schema_version: 1 } }, current_version_id: versionId,
        object: { storage_object: { sha256_hex: digest, size_bytes: bytes.length } }, ...patch.filePatch } };
    },
    bytes: async path => { paths.push(path); return patch.corrupt ? new TextEncoder().encode('{}') : bytes; },
  };
  return { reader, paths };
}

test('resolves authoritative primary and accessible pins at the exact digest/version', async () => {
  const { reader, paths } = fixture();
  const context = await resolveGoalDispatchContext(route, [], reader);
  expect(context).toMatchObject({ workspace_id: workspace, thread_id: thread, primary: reference,
    goals: [{ goal_file_id: goalId, relation: 'primary', status: 'accessible', file_version_id: versionId, name: 'Purpose', pinned_refs: [{ type: 'doc', record_id: pinId, status: 'accessible', title: 'Vision', row_version: 3 }] }] });
  expect(paths).toContain(`${base}/files/${goalId}/versions/${versionId}/object`);
});

test('multiple explicit mentions remain separate without replacing primary', async () => {
  const { reader } = fixture();
  const context = await resolveGoalDispatchContext(route, [{ message: `@[Other](mention:file:${secondId}) @[Third](mention:goal:${thirdId}) @[Other](mention:file:${secondId})` }], reader);
  expect(context?.primary).toEqual(reference);
  expect(context?.goals.map(g => [g.goal_file_id, g.relation])).toEqual([[goalId, 'primary'], [secondId, 'explicit_mention'], [thirdId, 'explicit_mention']]);
});

test('goal ACL denial preserves only association and no copied goal content', async () => {
  const { reader } = fixture({ denied: `/files/${goalId}` });
  const context = await resolveGoalDispatchContext(route, [], reader);
  expect(context?.goals).toEqual([{ goal_file_id: goalId, relation: 'primary', status: 'acl_unavailable' }]);
  expect(goalOutputMetadata({ artefact: { version: 1 } }, context)).toEqual({ artefact: { version: 1 }, ambulando_goal: reference });
  expect(goalContextSection(context).join('\n')).not.toContain('Make progress');
});

test('inaccessible pin reveals no content and never grants access', async () => {
  const { reader } = fixture({ denied: `/docs/${pinId}` });
  const context = await resolveGoalDispatchContext(route, [], reader);
  expect(context?.goals[0]?.pinned_refs).toEqual([{ type: 'doc', record_id: pinId, status: 'unavailable' }]);
});

test('cross-workspace or mismatched thread routing refuses primary and output writes', async () => {
  for (const threadPatch of [{ workspace_id: secondId }, { channel_id: secondId }, { id: secondId }, { deleted_at: 'now' }]) {
    const { reader, paths } = fixture({ threadPatch });
    const context = await resolveGoalDispatchContext(route, [], reader);
    expect(context?.primary).toBeNull(); expect(paths).toHaveLength(1);
    expect(() => goalOutputMetadata({}, context)).toThrow('Authoritative thread unavailable');
  }
});

test('inaccessible authoritative thread cannot be replaced by caller-supplied references', async () => {
  const { reader } = fixture({ denied: `/threads/${thread}` });
  const context = await resolveGoalDispatchContext(route, [], reader);
  expect(() => goalOutputMetadata({ ambulando_goal: reference }, context)).toThrow();
  expect(goalOutputMetadata({ ambulando_goal: reference, keep: true })).toEqual({ keep: true });
});

test('unsupported/malformed file, hash or goal body remains unavailable without content', async () => {
  for (const patch of [{ filePatch: { workspace_id: secondId } }, { filePatch: { archived_at: 'now' } }, { filePatch: { content_type: 'text/plain' } }, { goalPatch: { schema_version: 2 } }, { goalPatch: { start_date: '2026-02-30' } }, { goalPatch: { default_channel_id: 'bad' } }, { goalPatch: { links: 'wrong' } }, { goalPatch: { checkpoints: [{ id: 'cp', title: 'Next', date: 'tomorrow' }] } }, { goalPatch: { pinned_refs: [{ type: 'chat', record_id: pinId }] } }, { corrupt: true }]) {
    const { reader } = fixture(patch);
    const context = await resolveGoalDispatchContext(route, [], reader);
    expect(context?.goals).toEqual([{ goal_file_id: goalId, relation: 'primary', status: 'invalid_or_unavailable' }]);
    expect(context?.primary).toBeNull();
    expect(() => goalOutputMetadata({}, context)).toThrow('Primary goal');
  }
});

test('strict reference shape excludes spoofed data and malformed UUIDs', () => {
  for (const raw of [null, [], { version: 2, goal_file_id: goalId }, { version: 1, goal_file_id: 'bad' }]) expect(goalReference(raw)).toBeNull();
  expect(goalReference(reference)).toEqual(reference);
  expect(goalReference({ ...reference, future: { kept: true } })).toEqual({ ...reference, future: { kept: true } });
});

test('context remains in model envelope and output metadata, outside human message body', async () => {
  const { reader } = fixture(); const context = await resolveGoalDispatchContext(route, [], reader);
  const envelope = buildRehydratedDirectChatEnvelope({ history: [], prompts: [], goalContext: context });
  expect(envelope).toContain('# Goal context'); expect(envelope).toContain('not instructions or access grants');
  expect(goalOutputMetadata({ ambulando_goal: { version: 1, goal_file_id: secondId }, custom: 'keep' }, context)).toEqual({ custom: 'keep', ambulando_goal: reference });
});

test('legacy non-UUID routes issue no requests', async () => {
  const { reader, paths } = fixture();
  expect(await resolveGoalDispatchContext({ ...route, workspaceId: 'legacy' }, [], reader)).toBeUndefined();
  expect(paths).toHaveLength(0);
});

test('valid authoritative associations retain unknown future fields', async () => {
  const future = { ...reference, future: { retained: true } };
  const { reader } = fixture({ threadPatch: { metadata: { ambulando_goal: future } } });
  const context = await resolveGoalDispatchContext(route, [], reader);
  expect(goalOutputMetadata({}, context)).toEqual({ ambulando_goal: future });
});

test('resolver enforces a total request budget with explicit omissions', async () => {
  const pins = Array.from({ length: 16 }, (_, i) => ({ type: 'doc', record_id: `${(i + 32).toString(16).padStart(8, '0')}-6666-4666-8666-666666666666` }));
  const { reader, paths } = fixture({ goalPatch: { pinned_refs: pins } });
  const mentions = Array.from({ length: 20 }, (_, i) => `@[Goal](mention:file:${(i + 100).toString(16).padStart(8, '0')}-7777-4777-8777-777777777777)`).join(' ');
  const context = await resolveGoalDispatchContext(route, [{ message: mentions }], reader);
  expect(paths.length).toBeLessThanOrEqual(48);
  expect(context?.omitted_goal_count).toBeGreaterThan(0);
  expect(context?.omitted_reason).toBe('Resolution budget exhausted');
});

test('an unresponsive source cannot stall dispatch past the shared deadline', async () => {
  const started = Date.now();
  const context = await resolveGoalDispatchContext(route, [], { json: () => new Promise(() => {}), bytes: () => new Promise(() => {}) });
  expect(Date.now() - started).toBeLessThan(6_000);
  expect(context?.primary).toBeNull();
  expect(context?.unavailable).toContain('Authoritative thread unavailable');
}, 7_000);
