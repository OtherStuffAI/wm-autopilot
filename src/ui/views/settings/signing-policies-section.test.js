import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./signing-policies-section.js', import.meta.url), 'utf8');

describe('Signing Policies settings section', () => {
  test('covers accessible inventory, load/error/status, save and enable controls', () => {
    expect(source).toContain("root.dataset.testid = 'signing-policies-settings-section'");
    expect(source).toContain("status.setAttribute('aria-live', 'polite')");
    expect(source).toContain("status.dataset.state = 'loading'");
    expect(source).toContain("status.dataset.state = 'error'");
    expect(source).toContain("textarea.dataset.testid = 'signing-policy-json'");
    expect(source).toContain("save.dataset.testid = 'signing-policy-save'");
    expect(source).toContain("enabled.dataset.testid = 'signing-policy-enable-toggle'");
  });

  test('requires confirmation and explains failed revoke/reissue recovery', () => {
    expect(source).toContain("button.dataset.testid = 'signing-policy-reissue'");
    expect(source).toContain('A failed reissue leaves it revoked.');
    expect(source).toContain('if (!confirmAction(');
    expect(source).toContain('The old capability remains revoked; restart that session to recover.');
    expect(source).toContain("session.policyState");
  });
});
