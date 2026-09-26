import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineStore } from './pipeline-store';
import { ensurePipelineDirectories, getPipelineDefinition } from './pipeline-loader';

test('five Space pipeline definitions load with private reference outputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'learning-defs-'));
  const previous = process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT = root;
  try {
    await ensurePipelineDirectories(null);
    for (const action of ['plan', 'question', 'lesson', 'assessment', 'recall']) {
      const definition = await getPipelineDefinition(`learning-${action}`, null);
      expect(definition?.spec.name).toBe(`learning-${action}`);
      expect(definition?.spec.steps).toHaveLength(2);
      expect(definition?.spec.steps[0]).toMatchObject({ type: 'block', block: 'flightdeck.threadInvocation' });
    }
  } finally {
    if (previous === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
    else process.env.WINGMEN_PIPELINES_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('learning run idempotency is owner, action and input bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'learning-runs-'));
  try {
    const store = new PipelineStore(join(root, 'runs.sqlite'));
    expect(store.reserveLearningRun('owner-a', 'learning-plan', 'key', 'hash-a').state).toBe('new');
    expect(store.reserveLearningRun('owner-a', 'learning-plan', 'key', 'hash-a').state).toBe('pending');
    store.bindLearningRun('owner-a', 'learning-plan', 'key', 'run-1');
    expect(store.reserveLearningRun('owner-a', 'learning-plan', 'key', 'hash-a')).toEqual({ state: 'existing', runId: 'run-1' });
    expect(store.reserveLearningRun('owner-a', 'learning-plan', 'key', 'hash-b').state).toBe('conflict');
    expect(store.reserveLearningRun('owner-b', 'learning-plan', 'key', 'hash-a').state).toBe('new');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
