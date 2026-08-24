import { describe, expect, test } from 'bun:test';

import { createSettingsTabs } from './settings-tabs.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.value = '';
    this.listeners = new Map();
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  click() {
    (this.listeners.get('click') || []).forEach((listener) => listener());
  }

  querySelector() {
    return null;
  }
}

describe('Settings navigation shell', () => {
  test('renders a titled desktop rail and preserves the mobile section picker', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement: (tagName) => new FakeElement(tagName),
    };

    try {
      const shell = createSettingsTabs({
        tabDefs: [
          { id: 'profile', group: 'Personal', label: 'Profile', render: () => new FakeElement('div') },
          { id: 'workspaces', group: 'Agents & Automation', label: 'Workspaces', render: () => new FakeElement('div') },
        ],
        activeTabId: 'profile',
      });

      const [desktopNav, mobileLabel, content] = shell.children;
      expect(shell.className).toBe('wm-settings-shell');
      expect(desktopNav.className).toBe('wm-settings-nav');
      expect(desktopNav.children[0].className).toBe('wm-settings-nav__title');
      expect(desktopNav.children[0].textContent).toBe('Settings');
      expect(desktopNav.children.slice(1).map((group) => group.children[0].textContent)).toEqual([
        'Personal',
        'Agents & Automation',
      ]);
      expect(mobileLabel.className).toBe('wm-settings-mobile-nav');
      expect(mobileLabel.children[1].dataset.testid).toBe('settings-mobile-navigation');
      expect(mobileLabel.children[1].children.map((option) => option.value)).toEqual(['profile', 'workspaces']);
      expect(content.dataset.testid).toBe('settings-page-content');
    } finally {
      globalThis.document = originalDocument;
    }
  });

  test('navigates from Settings to the Agent Profiles page', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement: (tagName) => new FakeElement(tagName),
    };

    try {
      const profileList = new FakeElement('div');
      profileList.dataset.testid = 'agent-profiles-settings-section';
      const shell = createSettingsTabs({
        tabDefs: [
          { id: 'profile', group: 'Personal', label: 'Profile', render: () => new FakeElement('div') },
          { id: 'agentProfiles', group: 'Agents & Automation', label: 'Agent Profiles', render: () => profileList },
        ],
        activeTabId: 'profile',
      });
      const [desktopNav, , content] = shell.children;
      const automationGroup = desktopNav.children[2];
      const agentProfilesButton = automationGroup.children[1];

      expect(agentProfilesButton.dataset.testid).toBe('settings-nav-agentProfiles');
      agentProfilesButton.click();
      expect(content.children[0].dataset.testid).toBe('agent-profiles-settings-section');
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
