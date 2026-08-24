import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DuplicateCallbackPublicationDecisionStore,
  DuplicateCallbackPublicationFilter,
} from './duplicate-callback-publication-filter';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(config: { marker?: string; windowSeconds?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'duplicate-callback-filter-'));
  roots.push(root);
  const path = join(root, 'filter.sqlite');
  const store = new DuplicateCallbackPublicationDecisionStore(path);
  const warnings: unknown[] = [];
  let currentConfig = {
    marker: config.marker ?? 'duplicate callback:',
    windowSeconds: config.windowSeconds ?? 180,
  };
  const filter = new DuplicateCallbackPublicationFilter(() => currentConfig, store,
    { warn: (...args) => { warnings.push(args); } });
  const publishedAt = '2026-08-01T00:00:00.000Z';
  store.recordPublished({ decisionId: 'prior', routingKey: 'route-a', candidateAt: publishedAt,
    publishedAt, publishedMessageId: 'message-prior' });
  const evaluate = (body: string, seconds: number, patch: { decisionId?: string; routingKey?: string; candidateAt?: string } = {}) =>
    filter.evaluate({ decisionId: patch.decisionId ?? `candidate-${seconds}-${body}`,
      subscriptionId: 'subscription-a', agentNpub: 'npub1agent',
      routingKey: patch.routingKey ?? 'route-a', body,
      candidateAt: patch.candidateAt ?? new Date(Date.parse(publishedAt) + seconds * 1_000).toISOString() });
  return { path, store, filter, warnings, evaluate, setConfig: (next: typeof currentConfig) => { currentConfig = next; } };
}

describe('duplicate callback publication filter', () => {
  test('matches lower, upper, and mixed case only at the response start', () => {
    const f = fixture();
    expect(f.evaluate('duplicate callback: lower', 1).suppress).toBe(true);
    expect(f.evaluate('DUPLICATE CALLBACK: upper', 2).suppress).toBe(true);
    expect(f.evaluate('DuPlIcAtE CaLlBaCk: mixed', 3).suppress).toBe(true);
    expect(f.evaluate('Normal response mentions duplicate callback: later', 4).suppress).toBe(false);
  });

  test('allows only horizontal leading whitespace before the marker', () => {
    const f = fixture();
    expect(f.evaluate('  \tDuplicate callback: indented', 1).suppress).toBe(true);
    expect(f.evaluate('\nDuplicate callback: new paragraph', 2).suppress).toBe(false);
    expect(f.evaluate('\r\nDuplicate callback: new paragraph', 3).suppress).toBe(false);
  });

  test('does not fuzzily match the unconfigured calback misspelling', () => {
    const f = fixture();
    expect(f.evaluate('duplicate calback: typo', 1).suppress).toBe(false);
  });

  test('suppresses at 179 and exactly 180 seconds, then publishes at 181', () => {
    const f = fixture();
    expect(f.evaluate('duplicate callback: 179', 179)).toMatchObject({ suppress: true, elapsedSeconds: 179 });
    expect(f.evaluate('duplicate callback: 180', 180)).toMatchObject({ suppress: true, elapsedSeconds: 180 });
    expect(f.evaluate('duplicate callback: 181', 181)).toMatchObject({ suppress: false, reason: 'outside_window', elapsedSeconds: 181 });
  });

  test('keeps publication history independent between routing keys', () => {
    const f = fixture();
    expect(f.evaluate('duplicate callback: other thread', 1, { routingKey: 'route-b' })).toMatchObject({
      suppress: false, reason: 'timing_evidence_missing',
    });
  });

  test('uses persisted publication evidence after restart and records suppression evidence once', () => {
    const f = fixture();
    const restartedStore = new DuplicateCallbackPublicationDecisionStore(f.path);
    const restarted = new DuplicateCallbackPublicationFilter(() => ({ marker: 'duplicate callback:', windowSeconds: 180 }), restartedStore,
      { warn: () => {} });
    const input = { decisionId: 'restart-candidate', routingKey: 'route-a', subscriptionId: 'subscription-a',
      agentNpub: 'npub1agent', body: 'Duplicate callback: recovered',
      candidateAt: '2026-08-01T00:01:00.000Z' };
    expect(restarted.evaluate(input).suppress).toBe(true);
    expect(restarted.evaluate(input).suppress).toBe(true);
    const disabledReplay = new DuplicateCallbackPublicationFilter(() => ({ marker: '', windowSeconds: 0 }), restartedStore,
      { warn: () => {} });
    expect(disabledReplay.evaluate(input)).toMatchObject({
      suppress: true,
      reason: 'duplicate_callback_within_window',
    });
    expect(restartedStore.get('restart-candidate')).toMatchObject({
      outcome: 'suppressed', reason: 'duplicate_callback_within_window', previousPublishedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  test('supports explicit marker overrides and disablement', () => {
    const custom = fixture({ marker: 'repeat response:' });
    expect(custom.evaluate('Repeat Response: custom', 1).suppress).toBe(true);
    expect(custom.evaluate('duplicate callback: default no longer matches', 2).suppress).toBe(false);
    const empty = fixture({ marker: '' });
    expect(empty.evaluate('duplicate callback: disabled', 1)).toMatchObject({ suppress: false, reason: 'disabled' });
    const zero = fixture({ windowSeconds: 0 });
    expect(zero.evaluate('duplicate callback: disabled', 1)).toMatchObject({ suppress: false, reason: 'disabled' });
  });

  test('resolves different persisted policies for each workspace route', () => {
    const root = mkdtempSync(join(tmpdir(), 'duplicate-callback-filter-routes-'));
    roots.push(root);
    const store = new DuplicateCallbackPublicationDecisionStore(join(root, 'filter.sqlite'));
    const configs = new Map([
      ['subscription-a', { marker: 'duplicate callback:', windowSeconds: 180 }],
      ['subscription-b', { marker: 'repeat response:', windowSeconds: 30 }],
    ]);
    const filter = new DuplicateCallbackPublicationFilter(
      ({ subscriptionId }) => configs.get(subscriptionId) ?? null,
      store,
      { warn: () => {} },
    );
    const publishedAt = '2026-08-01T00:00:00.000Z';
    for (const routingKey of ['route-a', 'route-b']) {
      store.recordPublished({ decisionId: `prior-${routingKey}`, routingKey, candidateAt: publishedAt,
        publishedAt, publishedMessageId: `message-${routingKey}` });
    }

    expect(filter.evaluate({ decisionId: 'candidate-a', subscriptionId: 'subscription-a', agentNpub: 'npub1agent',
      routingKey: 'route-a', body: 'Duplicate callback: workspace A', candidateAt: '2026-08-01T00:02:00.000Z' }).suppress).toBe(true);
    expect(filter.evaluate({ decisionId: 'candidate-b-marker', subscriptionId: 'subscription-b', agentNpub: 'npub1agent',
      routingKey: 'route-b', body: 'Duplicate callback: workspace B', candidateAt: '2026-08-01T00:00:20.000Z' })).toMatchObject({
      suppress: false, reason: 'marker_not_at_start',
    });
    expect(filter.evaluate({ decisionId: 'candidate-b-window', subscriptionId: 'subscription-b', agentNpub: 'npub1agent',
      routingKey: 'route-b', body: 'Repeat response: workspace B', candidateAt: '2026-08-01T00:00:31.000Z' })).toMatchObject({
      suppress: false, reason: 'outside_window',
    });
  });

  test('reads a saved policy on the next decision without reconstructing the filter', () => {
    const f = fixture();
    expect(f.evaluate('Repeat response: before save', 10)).toMatchObject({
      suppress: false, reason: 'marker_not_at_start',
    });
    f.setConfig({ marker: 'repeat response:', windowSeconds: 15 });
    expect(f.evaluate('Repeat response: after save', 10)).toMatchObject({
      suppress: true, reason: 'duplicate_callback_within_window',
    });
    f.setConfig({ marker: '', windowSeconds: 15 });
    expect(f.evaluate('Repeat response: marker disabled', 11)).toMatchObject({ suppress: false, reason: 'disabled' });
    f.setConfig({ marker: 'repeat response:', windowSeconds: 0 });
    expect(f.evaluate('Repeat response: window disabled', 12)).toMatchObject({ suppress: false, reason: 'disabled' });
  });

  test('fails open when candidate or previous publication timing evidence is invalid', () => {
    const f = fixture();
    expect(f.evaluate('duplicate callback: invalid candidate', 1, { candidateAt: 'invalid' })).toMatchObject({
      suppress: false, reason: 'timing_evidence_missing',
    });
    f.store.recordPublished({ decisionId: 'invalid-prior', routingKey: 'invalid-route', candidateAt: 'invalid',
      publishedAt: 'invalid', publishedMessageId: 'invalid-message' });
    expect(f.evaluate('duplicate callback: invalid prior', 1, { routingKey: 'invalid-route' })).toMatchObject({
      suppress: false, reason: 'timing_evidence_missing',
    });
  });
});
