import { describe, expect, test } from 'bun:test';

import {
  createAgentModelLookupController,
  getAvailableHarnesses,
  getModelOptionsForAgent,
  modelValueForPayload,
} from './agent-model-lookups.js';

class FakeElement {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.value = '';
    this.textContent = '';
    this.disabled = false;
  }

  get options() { return this.children; }
  get selectedIndex() { return this.children.findIndex((child) => child.value === this.value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; this.value = ''; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { this.listeners.get(type)?.({ type }); }
}

const config = {
  defaultAgent: 'codex',
  agents: [
    { id: 'codex', label: 'Codex', modelOptions: ['default', 'gpt-5.5'] },
    { id: 'goose', label: 'Goose', modelOptions: ['default', 'qwen/qwen3.7-flash'] },
    { id: 'empty', label: 'Empty Harness', modelOptions: [] },
  ],
};

function harness() {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => new FakeElement() };
  const harnessSelect = new FakeElement();
  const modelSelect = new FakeElement();
  const status = new FakeElement();
  const controller = createAgentModelLookupController({ harnessSelect, modelSelect, status });
  return { originalDocument, harnessSelect, modelSelect, status, controller };
}

describe('authoritative agent model lookups', () => {
  test('populates stable harness IDs and labels in configured order', () => {
    expect(getAvailableHarnesses(config)).toEqual([
      { id: 'codex', label: 'Codex' },
      { id: 'goose', label: 'Goose' },
      { id: 'empty', label: 'Empty Harness' },
    ]);
  });

  test('uses the configured Goose models and preserves its default choice', () => {
    expect(getModelOptionsForAgent(config, 'goose')).toEqual(['default', 'qwen/qwen3.7-flash']);
    expect(modelValueForPayload('default')).toBeNull();
  });

  test('changes models with the harness and clears an incompatible selection', () => {
    const view = harness();
    try {
      view.controller.setConfig(config, { harness: 'goose', model: 'qwen/qwen3.7-flash' });
      expect(view.harnessSelect.value).toBe('goose');
      expect(view.modelSelect.value).toBe('qwen/qwen3.7-flash');

      view.harnessSelect.value = 'codex';
      view.harnessSelect.dispatch('change');
      expect(view.modelSelect.children.map((option) => option.value)).toEqual(['default', 'gpt-5.5']);
      expect(view.modelSelect.value).toBe('default');
    } finally {
      globalThis.document = view.originalDocument;
    }
  });

  test('shows an explicit unusable state when a harness has no models', () => {
    const view = harness();
    try {
      view.controller.setConfig(config, { harness: 'empty' });
      expect(view.modelSelect.disabled).toBe(true);
      expect(view.modelSelect.children[0].textContent).toBe('No models available');
      expect(view.status.textContent).toContain('No models are configured');
    } finally {
      globalThis.document = view.originalDocument;
    }
  });
});
