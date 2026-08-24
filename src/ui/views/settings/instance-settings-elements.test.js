import { describe, expect, test } from 'bun:test';

import { createButton } from './instance-settings-elements.js';

class FakeButton {
  constructor() {
    this.type = '';
    this.className = '';
    this.textContent = '';
  }
}

describe('instance settings controls', () => {
  test('supports submit buttons for form editors', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement: () => new FakeButton(),
    };

    try {
      expect(createButton('Save', 'wm-button', 'submit').type).toBe('submit');
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
