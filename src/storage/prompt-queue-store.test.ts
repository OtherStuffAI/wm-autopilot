import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { PromptQueueStore } from './prompt-queue-store';

function makeTempDb(): string {
  return join(tmpdir(), `prompt-queue-store-${randomUUID()}.sqlite`);
}

describe('PromptQueueStore', () => {
  test('detects queued prompts by exact content within a session', () => {
    const store = new PromptQueueStore(makeTempDb());

    store.addPrompt('session-1', { content: 'Agent work dispatch.\nTask id: task-1' });
    store.addPrompt('session-2', { content: 'Agent work dispatch.\nTask id: task-1' });

    expect(store.hasQueuedPrompt('session-1', 'Agent work dispatch.\nTask id: task-1')).toBe(true);
    expect(store.hasQueuedPrompt('session-1', 'Agent work dispatch.\nTask id: task-2')).toBe(false);
    expect(store.hasQueuedPrompt('session-2', 'Agent work dispatch.\nTask id: task-1')).toBe(true);
  });

  test('detects queued agent-work task advisories by task id', () => {
    const store = new PromptQueueStore(makeTempDb());

    store.addPrompt('session-1', {
      content: 'Agent work dispatch.\nDispatch reason: task updated.\nTask id: task-42',
    });
    store.addPrompt('session-1', {
      content: 'Night Watch reflection check-in.',
    });

    expect(store.hasQueuedTaskDispatchPrompt('session-1', 'task-42')).toBe(true);
    expect(store.hasQueuedTaskDispatchPrompt('session-1', 'task-99')).toBe(false);
  });

  test('persists typed payloads and deduplicates a callback key', () => {
    const store = new PromptQueueStore(makeTempDb());
    expect(store.addPrompt('supervisor', { content: 'callback', type: 'dispatch_callback',
      dedupeKey: 'dispatch:fingerprint', payload: { dispatchId: 'dispatch' } })).not.toBeNull();
    expect(store.addPrompt('supervisor', { content: 'callback again', type: 'dispatch_callback',
      dedupeKey: 'dispatch:fingerprint' })).toBeNull();
    expect(store.getSessionQueue('supervisor')[0]?.payload).toEqual({ dispatchId: 'dispatch' });
  });

  test('hydrates retained prompts in chronological order after reopening the queue', () => {
    const path = makeTempDb();
    const writer = new PromptQueueStore(path);
    writer.addPrompt('session-1', { content: 'first' });
    writer.addPrompt('session-1', { content: 'second' });

    const reloaded = new PromptQueueStore(path);
    expect(reloaded.getSessionQueue('session-1').map((prompt) => [prompt.order, prompt.content])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });
});
