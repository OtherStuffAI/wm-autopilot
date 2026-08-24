import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./terminal-security-section.js', import.meta.url), 'utf8');

describe('terminal security settings section', () => {
  test('provides accessible PIN replacement controls without reading a secret', () => {
    expect(source).toContain("card.dataset.testid = 'terminal-security-settings'");
    expect(source).toContain("confirmation.setAttribute('aria-label', 'Confirm terminal PIN')");
    expect(source).toContain("await replaceTerminalPin(pin.value, confirmation.value)");
    expect(source).not.toContain('fetchTerminalPin');
  });
});
