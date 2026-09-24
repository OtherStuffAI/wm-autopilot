import { afterEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { createPipelineRouterHandler, isChatAddressable } from './pipeline-router-handler';
import { PipelineStore } from '../pipelines/pipeline-store';

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) { try { unlinkSync(path); } catch {} } });

function definition(id: string, version: number, entry = true) {
  return { id, slug: id, name: id, path: `/tmp/${id}.json`, scope: 'user', ownerAlias: 'owner',
    spec: { name: `Pipeline ${id}`, description: `${id} description`, version,
      steps: [{ name: 'entry', type: 'block', block: entry ? 'flightdeck.threadInvocation' : 'flightdeck.returnToThread' }] } } as any;
}

function request() {
  return { agent: { agentId: 'pipe', botNpub: 'npub1pipe' }, botIdentity: { botNpub: 'npub1pipe' },
    subscription: { subscriptionId: 'sub', backendConnectionId: 'backend', backendBaseUrl: 'https://tower.example',
      workspaceId: '11111111-1111-4111-8111-111111111111', sourceAppNpub: 'npub1app', managedByNpub: 'npub1owner' },
    channelId: 'channel', threadId: '22222222-2222-4222-8222-222222222222',
    message: { id: 'message-1', body: '@Pipe use the council exactly', sender_npub: 'npub1requester' } } as any;
}

describe('pipeline router handler', () => {
  test('recognises only definitions whose first effective step is the entry block', () => {
    expect(isChatAddressable(definition('yes', 1))).toBe(true);
    expect(isChatAddressable(definition('no', 1, false))).toBe(false);
  });

  test('starts the highest-probability choice with the exact source prompt and acknowledges once', async () => {
    const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const store = new PipelineStore(path); const published: any[] = []; const starts: any[] = [];
    const handler = createPipelineRouterHandler({ store, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({}) as any,
      listDefinitions: async () => [definition('council', 4), definition('hidden', 1, false)],
      decide: async (input: any) => ({ model: 'jev-1', usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 8,
        answers: { pipeline: { type: 'choice', choice: 'council', confidence: .7, probabilities: { council: .8, no_match: .2 } } } }) as any,
      startRun: async (input: any) => { starts.push(input); return { run: { id: 'run-1' }, input: input.invocation, resolution: {} } as any; },
      publish: async (input: any) => { published.push(input); return { message: { id: 'ack-1' } } as any; } });
    await handler(request()); await handler(request());
    expect(starts).toHaveLength(1);
    expect(starts[0].invocation).toEqual({ workspaceId: '11111111-1111-4111-8111-111111111111',
      threadId: '22222222-2222-4222-8222-222222222222', frmNpub: 'npub1requester', prompt: '@Pipe use the council exactly' });
    expect(starts[0].initiatingAgentNpub).toBe('npub1pipe');
    expect(published.map((item) => item.body)).toEqual(["I’ve started Pipeline council with your request. Its response will return here."]);
  });

  test('no_match publishes one error and starts nothing', async () => {
    const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const store = new PipelineStore(path); const published: any[] = []; let starts = 0;
    const handler = createPipelineRouterHandler({ store, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({}) as any,
      listDefinitions: async () => [definition('council', 4)],
      decide: async () => ({ model: 'jev-1', usage: {}, latencyMs: 2, answers: { pipeline: { type: 'choice', choice: 'no_match', confidence: .8, probabilities: { council: .1, no_match: .9 } } } }) as any,
      startRun: async () => { starts += 1; throw new Error('unexpected'); },
      publish: async (input: any) => { published.push(input); return { message: { id: 'error-1' } } as any; } });
    await handler(request());
    expect(starts).toBe(0); expect(published).toHaveLength(1);
  });
});
