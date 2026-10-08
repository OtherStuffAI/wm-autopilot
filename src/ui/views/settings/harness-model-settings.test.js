import { describe, expect, test } from 'bun:test';

import {
  effectiveModelsFromConfig,
  normalizeHarnessModelLines,
  readHarnessModelSettings,
  withHarnessModels,
} from './harness-model-settings.js';

describe('harness model settings helpers', () => {
  test('normalizes one model per line and drops the implicit default', () => {
    expect(normalizeHarnessModelLines('default\n claude-opus-5-5 \n\nsonnet[1m]\nclaude-opus-5-5', 'Claude'))
      .toEqual(['claude-opus-5-5', 'sonnet[1m]']);
    expect(() => normalizeHarnessModelLines('default', 'Codex')).toThrow('Add at least one Codex model');
    expect(() => normalizeHarnessModelLines('bad model', 'Codex')).toThrow('Codex line 1');
  });

  test('replaces or removes a single harness without touching the other', () => {
    const settings = readHarnessModelSettings(JSON.stringify({
      harnesses: { claude: { models: ['opus'] }, codex: { models: ['gpt-6.1-sol'] } },
    }));
    expect(withHarnessModels(settings, 'codex', null)).toEqual({ harnesses: { claude: { models: ['opus'] } } });
    expect(withHarnessModels(settings, 'claude', { models: ['fable'] }).harnesses.codex).toEqual({ models: ['gpt-6.1-sol'] });
    expect(readHarnessModelSettings(null)).toEqual({ harnesses: {} });
  });

  test('reads effective models from /api/config without the default entry', () => {
    const config = { agents: [{ id: 'codex', modelOptions: ['default', 'gpt-6.1-sol'] }] };
    expect(effectiveModelsFromConfig(config, 'codex')).toEqual(['gpt-6.1-sol']);
    expect(effectiveModelsFromConfig(config, 'claude')).toEqual([]);
  });
});
