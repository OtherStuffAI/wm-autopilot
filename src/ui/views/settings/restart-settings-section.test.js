import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./restart-settings-section.js', import.meta.url), 'utf8');

describe('restart settings section', () => {
  test('presents the shared resume-or-fresh policy with accessible controls', () => {
    expect(source).toContain("card.dataset.testid = 'restart-settings-section'");
    expect(source).toContain("restartButton.dataset.testid = 'restart-autopilot'");
    expect(source).toContain("status.setAttribute('aria-live', 'polite')");
    expect(source).toContain('otherwise start a fresh replacement');
    expect(source).toContain('await triggerRestart()');
  });
});
