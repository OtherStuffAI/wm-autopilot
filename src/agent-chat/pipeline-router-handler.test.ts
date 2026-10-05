import { afterEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { createPipelineRouterHandler, isChatAddressable } from './pipeline-router-handler';
import { PipelineStore } from '../pipelines/pipeline-store';
import { FlightDeckDispatchOutcomeStore } from './flightdeck-dispatch-outcome-store';
import { parseLearningPipelineCommand } from './learning-pipeline-route';

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) { try { unlinkSync(path); } catch {} } });

function definition(id: string, version: number, entry = true) {
  return { id, slug: id, name: id, path: `/tmp/${id}.json`, scope: 'user', ownerAlias: 'owner',
    spec: { name: id.startsWith('learning-') ? id : `Pipeline ${id}`, description: `${id} description`, version,
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
  test('accepts only a bounded learning command and no learner or answer payload', () => {
    expect(parseLearningPipelineCommand('@[Piper](mention:agent:npub1pipe) learning lesson moon-phases'))
      .toEqual({ action: 'lesson', concept: 'moon-phases' });
    expect(parseLearningPipelineCommand('@Piper learning assessment moon-phases my answer')).toBeNull();
    expect(parseLearningPipelineCommand('@Piper learning plan npub1anotherlearner')).toBeNull();
  });
  test('recognises only definitions whose first effective step is the entry block', () => {
    expect(isChatAddressable(definition('yes', 1))).toBe(true);
    expect(isChatAddressable(definition('no', 1, false))).toBe(false);
  });

  test('starts the highest-probability choice with the exact source prompt and acknowledges once', async () => {
    const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const store = new PipelineStore(path); const published: any[] = []; const starts: any[] = [];
    const dispatchOutcomeStore = new FlightDeckDispatchOutcomeStore(path);
    const handler = createPipelineRouterHandler({ readContext: async () => ({ version: 1, messages: [] }), store, dispatchOutcomeStore, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({
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
    expect(starts[0].threadContext).toEqual({ version: 1, messages: [] });
    expect(starts[0].initiatingAgentNpub).toBe('npub1pipe');
    expect(starts[0].initiatingAgentProfileId).toBe('pipe');
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
    const handler = createPipelineRouterHandler({ readContext: async () => ({ version: 1, messages: [] }), store, dispatchOutcomeStore, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({
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

  test('routes an explicit learning mention with trusted context after learner grant check', async () => {
    const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const store = new PipelineStore(path); const published: any[] = []; const starts: any[] = []; let checks = 0;
    const handler = createPipelineRouterHandler({ readContext: async () => ({ version: 1, messages: [] }), store, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({}) as any,
      listDefinitions: async () => [definition('learning-lesson', 1)],
      decide: async () => { throw new Error('learning route must not use classifier'); },
      authorizeLearning: async () => { checks += 1; },
      startRun: async (input: any) => { starts.push(input); return { run: { id: 'learning-run-1' }, input: {}, resolution: {} } as any; },
      publish: async (input: any) => { published.push(input); return { message: { id: 'ack' } } as any; } });
    const source = request(); source.message.body = '@Piper learning lesson moon-phases';
    await handler(source); await handler(source);
    expect(checks).toBe(1); expect(starts).toHaveLength(1);
    expect(starts[0].trustedLearningContext).toEqual({ towerUrl: 'https://tower.example',
      workspaceId: source.subscription.workspaceId, goal: 'moon-phases', concept: 'moon-phases', idempotencyKey: 'flightdeck:message-1' });
    expect(starts[0].invocation).toMatchObject({ workspaceId: source.subscription.workspaceId,
      threadId: source.threadId, frmNpub: 'npub1requester' });
    expect(published[0]).toMatchObject({ channelId: 'channel', threadId: source.threadId });
    expect(JSON.stringify(published)).not.toContain('learnerNpub');
  });

  test('fails closed when Piper has no learner grant and does not echo private text', async () => {
    const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
    const store = new PipelineStore(path); const published: any[] = []; let starts = 0;
    const handler = createPipelineRouterHandler({ readContext: async () => ({ version: 1, messages: [] }), store, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({}) as any,
      listDefinitions: async () => [definition('learning-assessment', 1)],
      authorizeLearning: async () => { throw new Error('Tower denied learner access (403)'); },
      startRun: async () => { starts += 1; throw new Error('unexpected'); },
      publish: async (input: any) => { published.push(input); return { message: { id: 'ack' } } as any; } });
    const source = request(); source.message.body = '@Piper learning assessment moon-phases';
    await handler(source);
    expect(starts).toBe(0); expect(published).toHaveLength(1);
    expect(published[0].body).toContain('Check the learner grant');
    expect(JSON.stringify(published)).not.toContain(source.message.body);
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
    const handler = createPipelineRouterHandler({ readContext: async () => ({ version: 1, messages: [] }), store, dispatchOutcomeStore, callbackOrigin: 'http://localhost', getSessionApiContext: () => ({
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

test('context retrieval failure is visible, starts nothing and never calls Jev', async () => {
  const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
  const store = new PipelineStore(path); const published: any[] = [];
  const handler = createPipelineRouterHandler({ store, dispatchOutcomeStore: new FlightDeckDispatchOutcomeStore(path),
    callbackOrigin: 'http://localhost', getSessionApiContext: () => ({ userSettingsStore: { getAll: () => ({ openrouter_api_key: 'fixture' }) } }) as any,
    listDefinitions: async () => [definition('bird', 3)],
    readContext: async () => { throw new Error('Tower denied required history (403)'); },
    decide: async () => { throw new Error('must not classify'); },
    startRun: async () => { throw new Error('must not start'); },
    publish: async (input: any) => { published.push(input); return { message: { id: 'error' } } as any; } });
  await handler(request());
  expect(published).toHaveLength(1);
  expect(published[0].body).toContain('Tower denied required history (403)');
});

test('Jev receives inert history and usefulness instructions; selected run keeps exact current correction', async () => {
  const path = `/tmp/pipeline-router-${crypto.randomUUID()}.sqlite`; paths.push(path);
  const store = new PipelineStore(path); let selection: any; let started: any;
  const context = { version: 1, sourceMessageId: 'message-1', messages: [
    { body: 'Summarize my latest tweets into 10 points', inherited: true },
    { body: 'Following or For You, and how many tweets?', inherited: false },
  ], truncated: false };
  const handler = createPipelineRouterHandler({ store, dispatchOutcomeStore: new FlightDeckDispatchOutcomeStore(path),
    callbackOrigin: 'http://localhost', getSessionApiContext: () => ({ userSettingsStore: { getAll: () => ({ openrouter_api_key: 'fixture' }) } }) as any,
    listDefinitions: async () => [definition('bird', 3), { ...definition('disabled', 1), spec: { ...definition('disabled', 1).spec, enabled: false } }],
    readContext: async () => context,
    decide: async (input: any) => { selection = input; return { model: 'fixture', usage: {}, latencyMs: 1, answers: { pipeline: { choice: 'bird' } } } as any; },
    startRun: async (input: any) => { started = input; return { run: { id: 'run' } } as any; },
    publish: async () => ({ message: { id: 'ack' } }) as any });
  const source = request(); source.message.body = 'Following, 100 please';
  await handler(source);
  expect(selection.state).toEqual({ sourceQuestion: source.message.body, threadContext: context });
  expect(selection.questions.pipeline.instructions).toContain('contribute most usefully');
  expect(selection.questions.pipeline.instructions).toContain('topic changes');
  expect(selection.questions.pipeline.criteria).toEqual({ bird: 'Pipeline bird: bird description', no_match: 'None of the available pipelines is suitable for this request.' });
  expect(started.threadContext).toEqual(context);
  expect(started.invocation.prompt).toBe(source.message.body);
  expect(started.invocation.frmNpub).toBe('npub1requester');
});
