import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const settingsSource = readFileSync(new URL('./signing-policies-section.js', import.meta.url), 'utf8');
const importSource = readFileSync(new URL('./signing-policy-import.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('./signing-policy-editor.js', import.meta.url), 'utf8');

describe('legacy signing policy JSON tools', () => {
  test('remain outside the normal Settings signing-mode product surface', () => {
    expect(importSource).toContain('createSigningPolicyImport');
    expect(editorSource).toContain('createPolicyEditor');
    expect(settingsSource).not.toContain('createSigningPolicyImport');
    expect(settingsSource).not.toContain('createPolicyEditor');
    expect(settingsSource).not.toContain('signing-policy-import');
    expect(settingsSource).not.toContain('signing-policy-editor');
    expect(settingsSource).not.toContain('signing-policy-json');
  });
});
