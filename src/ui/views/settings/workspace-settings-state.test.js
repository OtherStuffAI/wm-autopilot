import { describe, expect, test } from 'bun:test';

import {
  getWorkspaceCollectionState,
  getWorkspaceHealthLabel,
  isRevokedWorkspaceSubscription,
} from './workspace-settings-state.js';

describe('workspace settings presentation state', () => {
  test('distinguishes loading, empty, error and partial-error collections', () => {
    expect(getWorkspaceCollectionState({ loading: true })).toBe('loading');
    expect(getWorkspaceCollectionState({ error: new Error('offline') })).toBe('error');
    expect(getWorkspaceCollectionState({ subscriptions: [] })).toBe('empty');
    expect(getWorkspaceCollectionState({ subscriptions: [{ subscriptionId: 'one' }], partialErrors: ['routes failed'] })).toBe('partial-error');
    expect(getWorkspaceCollectionState({ subscriptions: [{ subscriptionId: 'one' }] })).toBe('ready');
  });

  test('reports disconnected, disabled and revoked subscriptions explicitly', () => {
    expect(getWorkspaceHealthLabel({ sseStatus: 'disconnected' })).toBe('Disconnected');
    expect(getWorkspaceHealthLabel({ sseStatus: 'disabled' })).toBe('Disabled');
    const revoked = { wsKeyStatus: 'revoked' };
    expect(isRevokedWorkspaceSubscription(revoked)).toBe(true);
    expect(getWorkspaceHealthLabel(revoked)).toBe('Revoked');
  });
});
