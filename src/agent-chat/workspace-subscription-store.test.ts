import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { WorkspaceSubscriptionStore } from './workspace-subscription-store';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-workspace-store-${randomUUID()}.sqlite`);
}

describe('WorkspaceSubscriptionStore', () => {
  test('scopes same workspace imports by manager and backend connection', () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb());
    const first = store.save(store.createDefault({
      managedByNpub: 'npub1managera',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1app',
      connectionTokenRef: 'agent-connect:first',
    }));
    const second = store.save(store.createDefault({
      managedByNpub: 'npub1managerb',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1app',
      connectionTokenRef: 'agent-connect:second',
    }));

    expect(first.subscriptionId).not.toBe(second.subscriptionId);
    expect(store.listForManagerNpub('npub1managera')).toHaveLength(1);
    expect(store.listForManagerNpub('npub1managerb')).toHaveLength(1);
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1managera',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1botshared',
    })?.subscriptionId).toBe(first.subscriptionId);
    expect(first.onboardingSource).toBe('manual');
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1managerb',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1botshared',
    })?.subscriptionId).toBe(second.subscriptionId);
  });

  test('persists explicit Nostr onboarding source for Flight Deck workspace views', () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb());
    const record = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1bot',
      sourceAppNpub: 'npub1app',
      onboardingSource: 'nostr_33357',
    }));

    expect(record.onboardingSource).toBe('nostr_33357');
    expect(store.getBySubscriptionId(record.subscriptionId)?.onboardingSource).toBe('nostr_33357');
  });

  test('retries failed Flight Deck PG access checks on startup reload', () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb());
    const record = store.save({
      ...store.createDefault({
        managedByNpub: 'npub1manager',
        backendConnectionId: 'backend-1',
        workspaceOwnerNpub: 'npub1workspace',
        backendBaseUrl: 'https://tower.example.com',
        workspaceId: 'workspace-pg-1',
        workspaceServiceNpub: 'npub1workspaceservice',
        botNpub: 'npub1bot',
        sourceAppNpub: 'npub1app',
        onboardingSource: 'nostr_33357',
      }),
      wsKeyStatus: 'failed',
      sseStatus: 'disconnected',
      healthStatus: 'unhealthy',
      lastErrorCode: 'flightdeck_pg_access_failed',
    });

    expect(store.listStartupCandidates().map((candidate) => candidate.subscriptionId)).toContain(record.subscriptionId);
  });

  test('scopes same owner and app by explicit workspace identity', () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb());
    const first = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-one',
      workspaceServiceNpub: 'npub1workspaceone',
      botNpub: 'npub1bot',
      sourceAppNpub: 'npub1app',
      agentProfileId: 'wm-one',
    }));
    const second = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-two',
      workspaceServiceNpub: 'npub1workspacetwo',
      botNpub: 'npub1bot',
      sourceAppNpub: 'npub1app',
      agentProfileId: 'wm-one',
    }));

    expect(first.subscriptionId).not.toBe(second.subscriptionId);
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1bot',
      agentProfileId: 'wm-one',
      towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-one',
      workspaceServiceNpub: 'npub1workspaceone',
    })?.subscriptionId).toBe(first.subscriptionId);
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-1',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1bot',
      agentProfileId: 'wm-one',
      towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-two',
      workspaceServiceNpub: 'npub1workspacetwo',
    })?.subscriptionId).toBe(second.subscriptionId);
  });

  test('allows one manager to subscribe to the same workspace app on separate towers', () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb());
    const first = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-tower-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower-one.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1app',
    }));
    const second = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-tower-2',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower-two.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1app',
    }));

    expect(first.subscriptionId).not.toBe(second.subscriptionId);
    expect(store.listForManagerNpub('npub1manager')).toHaveLength(2);
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-tower-1',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1botshared',
    })?.subscriptionId).toBe(first.subscriptionId);
    expect(store.getBySubscriptionScope({
      managedByNpub: 'npub1manager',
      backendConnectionId: 'backend-tower-2',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app',
      botNpub: 'npub1botshared',
    })?.subscriptionId).toBe(second.subscriptionId);
  });
});
