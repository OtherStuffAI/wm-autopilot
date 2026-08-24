import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { BackendConnectionStore } from './backend-connection-store';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-backend-connections-${randomUUID()}.sqlite`);
}

describe('BackendConnectionStore grants', () => {
  test('lists only owned and explicitly granted backend connections for a manager', () => {
    const store = new BackendConnectionStore(makeTempDb());
    const owned = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      backendBaseUrl: 'https://owned.example.com',
    }));
    const granted = store.save(store.createDefault({
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://granted.example.com',
    }));
    const privateForeign = store.save(store.createDefault({
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://private.example.com',
    }));

    store.replaceAvailabilityGrants({
      backendConnectionId: granted.backendConnectionId,
      managerNpubs: ['npub1manager'],
    });

    const availableIds = store
      .listAvailableForManagerNpub('npub1manager')
      .map((record) => record.backendConnectionId)
      .sort();

    expect(availableIds).toEqual([granted.backendConnectionId, owned.backendConnectionId].sort());
    expect(availableIds).not.toContain(privateForeign.backendConnectionId);
    expect(store.getById(granted.backendConnectionId)?.sharePolicy).toBe('selected_users');
  });

  test('persists the shared service marker and exposes it to other managers', () => {
    const store = new BackendConnectionStore(makeTempDb());
    const backend = store.save(store.createDefault({
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://service.example.com',
    }));

    const grants = store.replaceAvailabilityGrants({
      backendConnectionId: backend.backendConnectionId,
      sharedService: true,
    });

    expect(grants).toEqual([
      expect.objectContaining({
        backendConnectionId: backend.backendConnectionId,
        grantKind: 'shared_service',
        granteeNpub: null,
      }),
    ]);
    expect(store.hasSharedServiceGrant(backend.backendConnectionId)).toBe(true);
    expect(store.listAvailableForManagerNpub('npub1manager').map((record) => record.backendConnectionId)).toEqual([
      backend.backendConnectionId,
    ]);
    expect(store.getById(backend.backendConnectionId)?.sharePolicy).toBe('shared_service');
  });
});
