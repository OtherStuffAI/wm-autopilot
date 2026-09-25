import { afterEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { createPipelineRouterHandler, isChatAddressable } from './pipeline-router-handler';
import { PipelineStore } from '../pipelines/pipeline-store';
import { FlightDeckDispatchOutcomeStore } from './flightdeck-dispatch-outcome-store';

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
    const dispatchOutcomeStore = new FlightDeckDispatchOutcomeStore(path);
    const handler = createPipelineRouterHandler({ store, dispatchOutcomeStore, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({
      userSettingsStore: { getAll: () => ({ openrouter_api_key: 'owner-key' }) },
    }) as any,
      listDefinitions: async () => [definition('council', 4), definition('hidden', 1, false)],
      decide: async (input: any) => ({ model: 'jev-1', usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 8,
        answers: { pipeline: { type: 'choice', choice: 'council', confidence: .7, probabilities: { council: .8, no_match: .2 } } } }) as any,
      startRun: async (input: any) => {
        starts.push(input);
        input.onRunCreated({ id: 'run-1', name: 'Pipeline council', status: 'running' });
        input.onRunCompleted({ id: 'run-1', name: 'Pipeline council', status: 'ok', completedAt: '2026-09-25T03:10:00.000Z', error: null });
        return { run: { id: 'run-1' }, input: input.invocation, resolution: {} } as any;
      },
      publish: async (input: any) => { published.push(input); return { message: { id: 'ack-1' } } as any; } });
    await handler(request()); await handler(request());
    expect(starts).toHaveLength(1);
    expect(starts[0].invocation).toEqual({ workspaceId: '11111111-1111-4111-8111-111111111111',
      threadId: '22222222-2222-4222-8222-222222222222', frmNpub: 'npub1requester', prompt: '@Pipe use the council exactly' });
    expect(starts[0].initiatingAgentNpub).toBe('npub1pipe');
    expect(published.map((item) => item.body)).toEqual(["I’ve started Pipeline council with your request. Its response will return here."]);
    expect(published[0].botIdentity.botNpub).toBe('npub1pipe');
    expect(dispatchOutcomeStore.listPage(['sub'], { limit: 10, offset: 0 }).rows[0]).toMatchObject({
      action: 'pipeline', actionId: 'run-1', agentId: 'pipe', outcome: 'launched', status: 'ok',
      dispatchAction: 'chat_pipeline_completed', details: { run_id: 'run-1', pipeline_name: 'Pipeline council', status: 'ok' },
    });
    expect(JSON.stringify(published)).not.toContain('owner-key');
  });

  test('no_match publishes one error and starts nothing', async () => {
    const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const store = new PipelineStore(path); const published: any[] = []; let starts = 0;
    const dispatchOutcomeStore = new FlightDeckDispatchOutcomeStore(path);
    const handler = createPipelineRouterHandler({ store, dispatchOutcomeStore, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({
      userSettingsStore: { getAll: () => ({ openrouter_api_key: 'owner-key' }) },
    }) as any,
      listDefinitions: async () => [definition('council', 4)],
      decide: async () => ({ model: 'jev-1', usage: {}, latencyMs: 2, answers: { pipeline: { type: 'choice', choice: 'no_match', confidence: .8, probabilities: { council: .1, no_match: .9 } } } }) as any,
      startRun: async () => { starts += 1; throw new Error('unexpected'); },
      publish: async (input: any) => { published.push(input); return { message: { id: 'error-1' } } as any; } });
    await handler(request());
    expect(starts).toBe(0); expect(published).toHaveLength(1);
    expect(dispatchOutcomeStore.listPage(['sub'], { limit: 10, offset: 0, includeIgnoredAndSuppressed: true }).rows[0]).toMatchObject({
      action: null, actionId: null, agentId: 'pipe', outcome: 'ignored', status: 'no_match',
      dispatchAction: 'chat_pipeline_no_match', reasonCode: 'pipeline_no_match',
    });
  });

  test('publishes a local configuration error without calling Decisions or exposing secrets', async () => {
    const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const store = new PipelineStore(path); const published: any[] = []; let decisions = 0; let evidence: unknown;
    const dispatchOutcomeStore = new FlightDeckDispatchOutcomeStore(path);
    const completeDecision = store.completeFlightDeckRouterDecision.bind(store);
    store.completeFlightDeckRouterDecision = (sourceMessageId, input) => {
      evidence = input.evidence;
      completeDecision(sourceMessageId, input);
    };
    const handler = createPipelineRouterHandler({ store, dispatchOutcomeStore, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({
      userSettingsStore: { getAll: () => ({ openrouter_api_key: '   ' }) },
      getStoredInstanceSetting: () => null,
    }) as any,
      listDefinitions: async () => [definition('council', 4)],
      decide: async () => { decisions += 1; throw new Error('unexpected network call'); },
      publish: async (input: any) => { published.push(input); return { message: { id: 'error-1' } } as any; } });
    const previous = { classifier: process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY,
      key: process.env.OPENROUTER_API_KEY, legacy: process.env.OPENROUTER_API };
    delete process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API;
    try { await handler(request()); } finally {
      if (previous.classifier === undefined) delete process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY; else process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = previous.classifier;
      if (previous.key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous.key;
      if (previous.legacy === undefined) delete process.env.OPENROUTER_API; else process.env.OPENROUTER_API = previous.legacy;
    }
    expect(decisions).toBe(0); expect(published).toHaveLength(1);
    expect(JSON.stringify(published)).not.toContain('owner-key');
    expect(JSON.stringify(evidence)).not.toContain('owner-key');
    expect(published[0].body).toContain('Classifier OpenRouter API key is not configured');
    expect(dispatchOutcomeStore.listPage(['sub'], { limit: 10, offset: 0 }).rows[0]).toMatchObject({
      agentId: 'pipe', outcome: 'failed', status: 'error', dispatchAction: 'chat_pipeline_failed',
      reasonCode: 'pipeline_start_failed',
    });
  });
});
