import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

let savedMode = null;

mock.module('../../services/signing-policies.js', () => ({
  saveAgentSigningMode: async (mode) => {
    savedMode = mode;
    return {
      activeMode: mode,
      mode: { mode, configured: true, source: 'app', updatedAt: '2026-09-15T00:00:00.000Z' },
      sessions: [{ sessionId: 'session-a', status: 'replacement-issued', restartRequired: false }],
      consequence: 'Signing mode applied.',
    };
  },
}));

import { createSigningPoliciesSection, describeNip98Target, describeNostrKindRule } from './signing-policies-section.js';

const source = readFileSync(new URL('./signing-policies-section.js', import.meta.url), 'utf8');

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toLowerCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.disabled = false;
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

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  async click() {
    await Promise.all((this.listeners.get('click') || []).map((listener) => listener({ preventDefault() {} })));
  }
}

function findByTestId(root, testId) {
  if (root?.dataset?.testid === testId) return root;
  for (const child of root?.children || []) {
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return null;
}

const modes = [
  { id: 'none', name: 'No signing', trust: 'Locked down', description: 'Cannot sign.' },
  { id: 'standard-agent', name: 'Standard agent signing', trust: 'Default', description: 'Session-bound signing.' },
  { id: 'full-nostr', name: 'Full Nostr signing', trust: 'Advanced', description: 'Any Nostr event.' },
  { id: 'full-agent', name: 'Full agent signing', trust: 'High-trust development', description: 'Any event or NIP-98.' },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Signing mode settings section', () => {
  test('shows accessible mode controls and removes the JSON policy editor surface', () => {
    expect(source).toContain("root.dataset.testid = 'signing-policies-settings-section'");
    expect(source).toContain("status.setAttribute('aria-live', 'polite')");
    expect(source).toContain("button.dataset.testid = `signing-mode-option-${mode.id}`");
    expect(source).toContain("button.setAttribute('aria-pressed'");
    expect(source).toContain("section.dataset.testid = 'signing-mode-session-summary'");
    expect(source).not.toContain('createPolicyEditor');
    expect(source).not.toContain('createSigningPolicyImport');
    expect(source).not.toContain('signing-policy-json');
    expect(source).not.toContain('signing-policy-delete');
  });

  test('clicking a mode saves it and shows hot-apply adoption status', async () => {
    const originalDocument = globalThis.document;
    savedMode = null;
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    try {
      const section = createSigningPoliciesSection({
        createState: (receive) => ({
          async refresh(_preferredId, notice) {
            receive({
              inventory: {
                modes,
                activeMode: 'standard-agent',
                mode: { mode: 'standard-agent', configured: false },
                sessions: [{ sessionId: 'session-a', policyState: 'current', policyMode: 'standard-agent' }],
              },
              notice,
            });
          },
        }),
      });
      await tick();
      await tick();

      expect(findByTestId(section, 'signing-mode-current').textContent).toContain('standard agent');
      await findByTestId(section, 'signing-mode-option-full-agent').click();
      expect(savedMode).toBe('full-agent');
      expect(findByTestId(section, 'signing-mode-current').textContent).toContain('full agent');
      expect(findByTestId(section, 'signing-mode-session-updated').textContent).toContain('replacement capability');
      expect(findByTestId(section, 'signing-policies-status').textContent).toBe('Signing mode applied.');
    } finally {
      globalThis.document = originalDocument;
    }
  });

  test('summarizes structured legacy policy descriptions for compatibility internals', () => {
    expect(describeNostrKindRule({
      kind: 31337,
      maxContentBytes: 1024,
      maxTags: 8,
      maxTagBytes: 2048,
      allowedTagNames: ['scope', 'p'],
      requiredTags: [['scope', 'release']],
    })).toBe('Kind 31337: content ≤ 1024 bytes; tags ≤ 8 / 2048 bytes; names scope, p; required scope="release"');
    expect(describeNip98Target({
      origin: 'https://tower.example',
      exactPaths: [{ path: '/api/v4/messages', methods: ['GET'] }],
      requireBodyHashMethods: [],
    })).toBe('https://tower.example · GET · exact /api/v4/messages · prefixes none · payload hash optional');
  });
});
