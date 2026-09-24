import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const card = readFileSync(new URL('./autopilot-connect-package-card.js', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('./workspace-settings-section.js', import.meta.url), 'utf8');

describe('Workspace Settings Autopilot Connect Package card', () => {
  test('presents one installation package with accessible generation, copy, status, and expiry controls', () => {
    expect(workspace).toContain('const connectPackageCard = createAutopilotConnectPackageCard({ ownerNpub })');
    expect(workspace).toContain('body.replaceChildren(connectPackageCard, toolbar');
    expect(card).toContain('Generate one signed package for this Autopilot installation');
    expect(card).toContain('discover the agents available to you');
    expect(card).toContain('short-lived for five minutes');
    expect(card).toContain("createButton('Generate package'");
    expect(card).toContain("createButton('Copy package'");
    expect(card).toContain("status.setAttribute('aria-live', 'polite')");
    expect(card).toContain("status.textContent = 'Package expired. Generate a new package to continue.'");
  });
});
