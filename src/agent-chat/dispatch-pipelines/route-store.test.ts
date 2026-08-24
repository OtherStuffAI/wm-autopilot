import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { DispatchRouteStore } from './route-store';

function makeTempDb(): string {
  return join(tmpdir(), `dispatch-route-store-${randomUUID()}.sqlite`);
}

describe('DispatchRouteStore', () => {
  test('normalises generated built-in pipeline ids to stable latest policies', () => {
    const store = new DispatchRouteStore(makeTempDb());

    const route = store.save({
      managedByNpub: 'npub1manager',
      subscriptionId: 'subscription-1',
      workspaceOwnerNpub: 'npub1workspace',
      botNpub: 'npub1bot',
      sourceAppNpub: 'npub1app',
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'shared:7df6cda5438c',
      enabled: true,
    });

    expect(route.pipelineDefinitionId).toBe('fd-agent-dispatch-chat');
    expect(route.pipelineVersionPolicy).toBe('latest');
    expect(store.getByRouteId(route.routeId)).toMatchObject({
      pipelineDefinitionId: 'fd-agent-dispatch-chat',
      pipelineVersionPolicy: 'latest',
    });
  });

  test('preserves custom generated pipeline ids', () => {
    const store = new DispatchRouteStore(makeTempDb());

    const route = store.save({
      managedByNpub: 'npub1manager',
      subscriptionId: 'subscription-1',
      workspaceOwnerNpub: 'npub1workspace',
      botNpub: 'npub1bot',
      sourceAppNpub: 'npub1app',
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'shared:custom123456',
      enabled: true,
    });

    expect(route.pipelineDefinitionId).toBe('shared:custom123456');
    expect(route.pipelineVersionPolicy).toBe('latest');
  });
});
