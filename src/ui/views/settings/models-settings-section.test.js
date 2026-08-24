import { describe, expect, test } from 'bun:test';

import { createModelsSettingsSection, moveModel } from './models-settings-section.js';
import {
  normalizeOpenRouterModelLines,
  readOpenRouterModelsSetting,
} from './model-provider-settings.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toLowerCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.classList = { toggle: () => {} };
  }

  append(...children) {
    this.children.push(...children.filter(Boolean));
  }

  replaceChildren(...children) {
    this.children = children.filter(Boolean);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'data-testid') this.dataset.testid = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type) {
    const event = { preventDefault() {} };
    await Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
  }

  querySelector() {
    return null;
  }

  focus() {}
}

function queryByTestId(node, testId) {
  if (node?.dataset?.testid === testId) return node;
  for (const child of node?.children || []) {
    const match = queryByTestId(child, testId);
    if (match) return match;
  }
  return null;
}

async function withFakeDocument(run) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  try {
    await run();
  } finally {
    globalThis.document = originalDocument;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('OpenRouter Models settings', () => {
  test('normalizes and validates one provider-relative model per line', () => {
    expect(normalizeOpenRouterModelLines(' qwen/qwen3.7-flash\n\nqwen/qwen3.7-flash\ngoogle/gemini-3.6-flash ')).toEqual([
      'qwen/qwen3.7-flash',
      'google/gemini-3.6-flash',
    ]);
    expect(() => normalizeOpenRouterModelLines('openrouter/qwen/qwen3.7-flash')).toThrow('provider/model');
  });

  test('reorders models through the keyboard button path without mutating the source list', () => {
    const source = ['one/model', 'two/model', 'three/model'];
    expect(moveModel(source, 1, 'up')).toEqual(['two/model', 'one/model', 'three/model']);
    expect(moveModel(source, 1, 'down')).toEqual(['one/model', 'three/model', 'two/model']);
    expect(source).toEqual(['one/model', 'two/model', 'three/model']);
  });

  test('renders the fixed provider and saves the normalized list before refreshing config', async () => {
    await withFakeDocument(async () => {
      let saved = null;
      let refreshCount = 0;
      const section = createModelsSettingsSection({
        loadSettings: async () => ({ settings: [] }),
        saveSetting: async (key, value) => { saved = { key, value }; },
        onSaved: async () => { refreshCount += 1; },
      });
      await tick();

      expect(queryByTestId(section, 'models-provider').textContent).toContain('OpenRouter');
      expect(queryByTestId(section, 'models-structured-rows').children).toHaveLength(4);
      const textarea = queryByTestId(section, 'models-openrouter-list');
      expect(textarea.value).toBe([
        'qwen/qwen3.7-flash',
        'anthropic/claude-opus-5-fast',
        'google/gemini-3.6-flash',
        'thinkingmachines/inkling',
      ].join('\n'));
      textarea.value = ' qwen/qwen3.7-flash\n\nqwen/qwen3.7-flash\nanthropic/claude-opus-5-fast ';
      await queryByTestId(section, 'models-apply-text').dispatch('click');
      const form = section.children[4];
      await form.dispatch('submit');

      expect(saved.key).toBe('models.providers');
      expect(readOpenRouterModelsSetting(saved.value)).toEqual([
        'qwen/qwen3.7-flash',
        'anthropic/claude-opus-5-fast',
      ]);
      expect(textarea.value).toBe('qwen/qwen3.7-flash\nanthropic/claude-opus-5-fast');
      expect(refreshCount).toBe(1);
      expect(queryByTestId(section, 'models-save-status').textContent).toContain('Saved 2');
    });
  });

  test('shows save errors inline and does not claim success', async () => {
    await withFakeDocument(async () => {
      let saveCount = 0;
      const section = createModelsSettingsSection({
        loadSettings: async () => ({ settings: [] }),
        saveSetting: async () => { saveCount += 1; },
      });
      await tick();
      const firstRow = queryByTestId(section, 'models-row-0');
      firstRow.value = 'malformed';
      await firstRow.dispatch('input');
      await section.children[4].dispatch('submit');

      expect(saveCount).toBe(0);
      expect(queryByTestId(section, 'models-save-status').textContent).toContain('provider/model');
    });
  });
});
