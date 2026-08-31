import { beforeEach, describe, expect, mock, test } from 'bun:test';

let createPayload = null;
let updatePayload = null;
let uploadPayload = null;
let listedAgents = [];
let listedDefaults = {};
let rotatePayload = null;
let defaultPayload = null;
let deletePayload = null;

mock.module('../../services/agent-chat.js', () => ({
  createAgentChatProfile: async (input) => {
    createPayload = input;
    return { agent: { agentId: 'Builder', label: 'Builder', botNpub: 'npub1Builder' } };
  },
  deleteAgentChatProfile: async (profileId) => {
    deletePayload = profileId;
    return { deleted: true, profileId, botNpub: 'npub1Builder', keyDisposition: 'deleted_from_vault' };
  },
  updateAgentChatProfile: async (profileId, input) => {
    updatePayload = { profileId, input };
    return { agent: { ...listedAgents[0], ...input }, published: false };
  },
  uploadAgentChatProfileMedia: async (profileId, mediaFile, input) => {
    uploadPayload = { profileId, mediaFile, input };
    return {
      agent: { ...listedAgents[0], ...input },
      published: true,
      media: { savedLocally: true, publishedToRelays: true },
    };
  },
  rotateAgentChatProfileKey: async (...args) => { rotatePayload = args; return { state: 'completed', newNpub: 'npub1rotated', warnings: [], externalActions: [], tower: { status: 'completed', migrationCounts: { memberships: 2 } } }; },
  setDefaultAgentChatProfile: async (profileId) => { defaultPayload = profileId; return { defaultAgentProfileId: profileId }; },
  listAgentChatAgents: async () => ({ agents: listedAgents, permissions: { canManage: true }, defaults: listedDefaults }),
}));

mock.module('../../services/config.js', () => ({
  fetchConfigApi: async () => ({
    defaultAgent: 'codex',
    agents: [
      { id: 'codex', label: 'Codex', modelOptions: ['default', 'gpt-5.5'] },
      { id: 'goose', label: 'Goose', modelOptions: ['default', 'qwen/qwen3.7-flash', 'deepseek/deepseek-v4-flash-0731'] },
    ],
  }),
}));

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.value = '';
    this.hidden = false;
    this.disabled = false;
  }

  get options() { return this.children; }
  get selectedIndex() { return this.children.findIndex((child) => child.value === this.value); }

  append(...children) { this.children.push(...children.filter(Boolean)); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'data-testid') this.dataset.testid = String(value);
  }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatchEvent(event) { (this.listeners.get(event.type) || []).forEach((listener) => listener(event)); }
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); }
  focus() {}
  select() {}
}

function findByTestId(root, testId) {
  if (root?.dataset?.testid === testId) return root;
  for (const child of root?.children || []) {
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return null;
}

describe('Agent Profiles Settings entry', () => {
  beforeEach(() => {
    createPayload = null;
    updatePayload = null;
    uploadPayload = null;
    rotatePayload = null;
    defaultPayload = null;
    deletePayload = null;
    listedAgents = [];
    listedDefaults = {};
  });

  test('shows Add Agent Profile with no subscriptions and opens the complete create form', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    try {
      const { createAgentProfilesSection } = await import('./agent-profiles-section.js');
      const section = createAgentProfilesSection();
      await Promise.resolve();
      await Promise.resolve();

      const addButton = findByTestId(section, 'agent-profiles-add');
      const modal = findByTestId(section, 'agent-chat-agent-name-modal');
      expect(addButton?.textContent).toBe('Add Agent Profile');
      expect(findByTestId(section, 'agent-profiles-empty')?.textContent).toContain('workspace connection is not required');

      addButton.click();
      expect(modal.hidden).toBe(false);
      expect(findByTestId(modal, 'agent-chat-agent-name')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-working-directory')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-create-harness')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-create-model')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-create-picture')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-create-picture-file')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-create-picture-preview')?.alt).toBe('Agent profile image preview');
      expect(findByTestId(modal, 'agent-chat-agent-create-about')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-create-nip05')).not.toBeNull();
      expect(findByTestId(modal, 'agent-chat-agent-name-advanced-panel')?.style.display).toBe('');

      const harnessSelect = findByTestId(modal, 'agent-chat-agent-create-harness');
      const modelSelect = findByTestId(modal, 'agent-chat-agent-create-model');
      expect(harnessSelect.children.map((option) => [option.value, option.textContent])).toEqual([
        ['codex', 'Codex'],
        ['goose', 'Goose'],
      ]);
      harnessSelect.value = 'goose';
      harnessSelect.dispatchEvent({ type: 'change' });
      modelSelect.value = 'qwen/qwen3.7-flash';
      const nameInput = findByTestId(modal, 'agent-chat-agent-name');
      nameInput.value = 'Builder';
      nameInput.dispatchEvent({ type: 'input' });
      const directoryInput = findByTestId(modal, 'agent-chat-agent-working-directory');
      directoryInput.value = '/Users/example/wingmen/Builder21';
      directoryInput.dispatchEvent({ type: 'input' });
      const mediaFile = new File([new Uint8Array([1, 2, 3])], 'builder.png', { type: 'image/png' });
      const mediaInput = findByTestId(modal, 'agent-chat-agent-create-picture-file');
      mediaInput.files = [mediaFile];
      mediaInput.dispatchEvent({ type: 'change' });
      findByTestId(modal, 'agent-chat-agent-name-submit').click();
      await Promise.resolve();
      await Promise.resolve();
      expect(createPayload).toMatchObject({
        profileId: 'builder',
        label: 'Builder',
        name: 'Builder',
        harness: 'goose',
        model: 'qwen/qwen3.7-flash',
        workingDirectory: '/Users/example/wingmen/Builder21',
        mediaFile,
      });
    } finally {
      globalThis.document = originalDocument;
    }
  });

  test('exposes Edit Agent Profile and opens current immutable and runtime values', async () => {
    listedAgents = [{
      agentId: 'Builder', label: 'Builder', botNpub: 'npub1Builder',
      workingDirectory: '/Users/example/wingmen/agent-workspace', harness: 'goose', model: 'deepseek/deepseek-v4-flash-0731',
      enabled: true, capabilities: ['chat_intercept'], directChat: { enabled: true },
      publicProfile: { name: 'Builder', about: 'Builder', picture: null, nip05: null },
    }];
    const originalDocument = globalThis.document;
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    try {
      const { createAgentProfilesSection } = await import('./agent-profiles-section.js');
      const section = createAgentProfilesSection();
      await Promise.resolve();
      await Promise.resolve();
      findByTestId(section, 'agent-profile-edit-Builder').click();
      const modal = findByTestId(section, 'agent-profile-editor-modal');
      expect(modal.hidden).toBe(false);
      expect(findByTestId(modal, 'agent-profile-edit-npub').value).toBe('npub1Builder');
      expect(findByTestId(modal, 'agent-profile-edit-npub').readOnly).toBe(true);
      expect(findByTestId(modal, 'agent-profile-edit-directory').value).toBe('/Users/example/wingmen/agent-workspace');
      expect(findByTestId(modal, 'agent-profile-edit-harness').value).toBe('goose');
      expect(findByTestId(modal, 'agent-profile-edit-model').value).toBe('deepseek/deepseek-v4-flash-0731');
      expect(findByTestId(modal, 'agent-profile-edit-picture-file')).not.toBeNull();
      expect(findByTestId(modal, 'agent-profile-edit-picture-status')?.attributes.get('aria-live')).toBe('polite');
      findByTestId(modal, 'agent-profile-edit-directory').value = '/Users/example/wingmen/Builder21';
      findByTestId(modal, 'agent-profile-edit-save').click();
      await Promise.resolve();
      await Promise.resolve();
      expect(updatePayload).toMatchObject({
        profileId: 'Builder',
        input: {
          workingDirectory: '/Users/example/wingmen/Builder21',
          harness: 'goose',
          model: 'deepseek/deepseek-v4-flash-0731',
        },
      });
      expect(updatePayload.input).not.toHaveProperty('botNpub');
    } finally {
      globalThis.document = originalDocument;
    }
  });

  test('imports a selected edit image through the owned media path', async () => {
    listedAgents = [{
      agentId: 'profile-one', label: 'Profile One', botNpub: 'npub1profileone', workingDirectory: '/tmp/profile-one', harness: 'codex', model: null,
      enabled: true, capabilities: ['chat_intercept'], directChat: { enabled: true },
      publicProfile: { name: 'Profile One', about: 'Agent', picture: 'https://external.host/profile-one.jpg', nip05: null },
    }];
    const originalDocument = globalThis.document;
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    try {
      const { createAgentProfilesSection } = await import('./agent-profiles-section.js');
      const section = createAgentProfilesSection();
      await Promise.resolve(); await Promise.resolve();
      findByTestId(section, 'agent-profile-edit-profile-one').click();
      const modal = findByTestId(section, 'agent-profile-editor-modal');
      const mediaFile = new File([new Uint8Array([4, 5, 6])], 'profile-one.png', { type: 'image/png' });
      const mediaInput = findByTestId(modal, 'agent-profile-edit-picture-file');
      mediaInput.files = [mediaFile];
      mediaInput.dispatchEvent({ type: 'change' });
      expect(findByTestId(modal, 'agent-profile-edit-picture-preview').hidden).toBe(false);
      expect(findByTestId(modal, 'agent-profile-edit-picture-status').textContent).toContain('saved locally');
      findByTestId(modal, 'agent-profile-edit-save').click();
      await Promise.resolve(); await Promise.resolve();
      expect(uploadPayload).toMatchObject({
        profileId: 'profile-one',
        mediaFile,
        input: { publicProfile: { name: 'Profile One', about: 'Agent' } },
      });
      expect(updatePayload).toBeNull();
      expect(findByTestId(section, 'agent-profiles-status').textContent).toContain('image locally and published');
    } finally {
      globalThis.document = originalDocument;
    }
  });

  test('shows manager rotation action and requires the irreversible confirmation', async () => {
    listedAgents = [{
      agentId: 'Builder', label: 'Builder', botNpub: 'npub1Builder', workingDirectory: '/tmp/Builder', harness: 'codex', model: null,
      enabled: true, capabilities: ['chat_intercept'], directChat: { enabled: true }, publicProfile: { name: 'Builder' },
    }];
    const originalDocument = globalThis.document;
    const originalConfirm = globalThis.confirm;
    let confirmation = '';
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    globalThis.confirm = (message) => { confirmation = message; return true; };
    try {
      const { createAgentProfilesSection } = await import('./agent-profiles-section.js');
      const section = createAgentProfilesSection();
      await Promise.resolve(); await Promise.resolve();
      findByTestId(section, 'agent-profile-rotate-Builder').click();
      await Promise.resolve(); await Promise.resolve();
      expect(confirmation).toContain('Builder (Builder)');
      expect(confirmation).toContain('npub1Builder');
      expect(confirmation).toContain('sessions using it will stop working');
      expect(confirmation).toContain('private key is never displayed or exported');
      expect(rotatePayload?.slice(0, 2)).toEqual(['Builder', 'npub1Builder']);
      expect(findByTestId(section, 'agent-profiles-status')?.textContent).toContain('Tower completed (memberships: 2)');
    } finally {
      globalThis.document = originalDocument;
      globalThis.confirm = originalConfirm;
    }
  });

  test('deletes a profile only after warning about key and subscription consequences', async () => {
    listedAgents = [{
      agentId: 'Builder', label: 'Builder', botNpub: 'npub1Builder', workingDirectory: '/tmp/Builder', harness: 'codex', model: null,
      enabled: true, capabilities: ['chat_intercept'], directChat: { enabled: true }, publicProfile: { name: 'Builder' },
    }];
    const originalDocument = globalThis.document;
    const originalConfirm = globalThis.confirm;
    let confirmation = '';
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    globalThis.confirm = (message) => { confirmation = message; return true; };
    try {
      const { createAgentProfilesSection } = await import('./agent-profiles-section.js');
      const section = createAgentProfilesSection();
      await Promise.resolve(); await Promise.resolve();
      const deleteButton = findByTestId(section, 'agent-profile-delete-Builder');
      expect(deleteButton?.attributes.get('aria-label')).toContain('locally managed signing key');
      expect(deleteButton?.className).toContain('danger');
      deleteButton.click();
      await Promise.resolve(); await Promise.resolve();
      expect(confirmation).toContain('WINGMAN_PRIV');
      expect(confirmation).toContain('Workspace subscriptions must be deleted or rebound first');
      expect(confirmation).toContain('cannot be undone');
      expect(deletePayload).toBe('Builder');
      expect(findByTestId(section, 'agent-profiles-status')?.textContent).toContain('permanently removed');
    } finally {
      globalThis.document = originalDocument;
      globalThis.confirm = originalConfirm;
    }
  });

  test('marks the default profile and allows choosing another one', async () => {
    listedAgents = [
      { agentId: 'rick', label: 'Rick', botNpub: 'npub1rick', workingDirectory: '/tmp/rick', enabled: true, capabilities: [], publicProfile: { name: 'Rick' } },
      { agentId: 'brick', label: 'Brick', botNpub: 'npub1brick', workingDirectory: '/tmp/brick', enabled: true, capabilities: [], publicProfile: { name: 'Brick' } },
    ];
    listedDefaults = { defaultAgentProfileId: 'rick' };
    const originalDocument = globalThis.document;
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    try {
      const { createAgentProfilesSection } = await import('./agent-profiles-section.js');
      const section = createAgentProfilesSection();
      await Promise.resolve(); await Promise.resolve();
      expect(findByTestId(section, 'agent-profile-default-rick')?.textContent).toBe('Default agent');
      expect(findByTestId(section, 'agent-profile-make-default-rick')).toBeNull();
      findByTestId(section, 'agent-profile-make-default-brick').click();
      await Promise.resolve(); await Promise.resolve();
      expect(defaultPayload).toBe('brick');
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
