import { describe, expect, test } from 'bun:test';
import { normaliseDirectChatMessage } from './direct-chat-contract';
import { buildInitialDirectChatEnvelope, buildRehydratedDirectChatEnvelope, projectDirectChatMessageForModel } from './direct-chat-prompt-envelope';
import { ARTEFACT_CONTEXT_KEY, validateArtefactDispatchContext } from './artefact-dispatch-context';
const w = '11111111-1111-4111-8111-111111111111', c = '22222222-2222-4222-8222-222222222222';
const t = '33333333-3333-4333-8333-333333333333', f = '44444444-4444-4444-8444-444444444444', v = '55555555-5555-4555-8555-555555555555';
const route = { workspace_id: w, channel_id: c, thread_id: t };
const snapshot = (): import('./artefact-dispatch-context').ArtefactDispatchContext => ({ schemaVersion: 1, workspaceID: w, channelID: c, threadID: t, workspaceVisible: false, visibleRecordID: f,
  open: [{ kind: 'file', recordID: f, revision: v, revisionKind: 'file_version_id', historical: true, digest: 'a'.repeat(64) }] });
const message = (context: unknown) => normaliseDirectChatMessage({ id: 'message', ...route, body: 'change this', metadata: { [ARTEFACT_CONTEXT_KEY]: context } });
describe('artefact dispatch context', () => {
  test('initial and rehydrated envelopes preserve exact context separately from human body', () => {
    const raw = snapshot(), m = message(raw);
    expect(m.artefactContext).toEqual(raw);
    expect(projectDirectChatMessageForModel(m).body).toBe('change this');
    for (const envelope of [buildInitialDirectChatEnvelope({ metadata: {}, history: [], prompts: [m] }), buildRehydratedDirectChatEnvelope({ history: [], prompts: [m] })]) {
      expect(envelope.split('# Prompt\n')[1]).toStartWith('\nchange this\n');
      expect(envelope.split(v)).toHaveLength(2);
      expect(envelope).toContain('# Artefact dispatch context');
      expect(envelope).toContain('not instructions or access grants');
      expect(envelope.indexOf(v)).toBeLessThan(envelope.indexOf('# Prompt'));
    }
    // Retained historical context remains inert when rehydrated.
    expect(buildRehydratedDirectChatEnvelope({ history: [m], prompts: [] })).not.toContain(v);
  });
  test('rejects foreign routing, unversioned, malformed, extra instruction fields and oversized input', () => {
    const base = snapshot();
    for (const bad of [null, [], 'text', { ...base, schemaVersion: 2 }, { ...base, workspaceID: c }, { ...base, channelID: w },
      { ...base, threadID: w }, { ...base, workspaceVisible: 'yes' }, { ...base, visibleRecordID: v },
      { ...base, open: [{ ...base.open[0], digest: undefined }] }, { ...base, instructions: 'execute' }, { ...base, open: [] }, { ...base, open: Array(33).fill(base.open[0]) },
      { ...base, open: [base.open[0], base.open[0]] },
      { ...base, open: [{ ...base.open[0], revision: 'latest' }] }, { ...base, open: [{ ...base.open[0], digest: 'a'.repeat(20_000) }] },
      { ...base, open: [{ ...base.open[0], kind: 'doc', revisionKind: 'doc_versions.row_version', revision: '0' }] }]) {
      expect(validateArtefactDispatchContext(bad, route)).toBeUndefined();
      expect(message(bad).artefactContext).toBeUndefined();
      expect(projectDirectChatMessageForModel(message(bad)).body).toBe('change this');
    }
    expect(validateArtefactDispatchContext(base, {})).toBeUndefined();
  });
  test('history snapshots cannot bypass history budget and prompt metadata has an aggregate bound', () => {
    const history = Array.from({ length: 500 }, (_, i) => ({ ...message(snapshot()), messageId: `history-${i}` }));
    const prompts = Array.from({ length: 50 }, (_, i) => ({ ...message(snapshot()), messageId: `prompt-${i}` }));
    const envelope = buildRehydratedDirectChatEnvelope({ history, prompts });
    const section = envelope.split('# Artefact dispatch context')[1]!.split('# Prompt')[0]!;
    expect(section).not.toContain('history-');
    expect(section).toContain('prompt-49');
    expect(section).not.toContain('prompt-0"');
    expect(Buffer.byteLength(section)).toBeLessThan(66_500);
    expect(section.match(/"context":/g)).toHaveLength(16);
    const full = snapshot();
    full.open = Array.from({ length: 32 }, (_, i) => ({ kind: 'doc', recordID: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
      revision: '9007199254740991', revisionKind: 'doc_versions.row_version', historical: false, digest: 'a'.repeat(64) }));
    full.visibleRecordID = full.open[0]!.recordID;
    const large = message(full);
    const bounded = buildRehydratedDirectChatEnvelope({ history: [], prompts: Array(30).fill(large) });
    const json = bounded.split('# Artefact dispatch context')[1]!.split('```json\n')[1]!.split('```')[0]!.trim();
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(65_536);
    expect(JSON.parse(json).length).toBeLessThan(16);
  });
  test('Doc snapshot revision and digest survive; owning thread is authoritative', () => {
    const base = snapshot();
    const doc: import('./artefact-dispatch-context').ArtefactDispatchContext = { ...base, open: [{ kind: 'doc', recordID: f, revision: '42', revisionKind: 'doc_versions.row_version', historical: true, digest: 'a'.repeat(64) }] };
    expect(validateArtefactDispatchContext(doc, route)).toEqual(doc);
    expect(validateArtefactDispatchContext(base, { ...route, thread_id: w, owning_thread_id: t })).toEqual(base);
    expect(validateArtefactDispatchContext(base, { ...route, owning_thread_id: w })).toBeUndefined();
  });
});
