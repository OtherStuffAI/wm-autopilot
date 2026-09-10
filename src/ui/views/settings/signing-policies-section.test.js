import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { describeNip98Target, describeNostrKindRule, draftFromPolicy } from './signing-policies-section.js';
import { saveSigningPolicy } from '../../services/signing-policies.js';
import { validateSigningPolicyDraft } from '../../../signing/signing-policy-validation.ts';

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

  test('summarizes and preserves structured custom-kind constraints', () => {
    const nostrKindRules = [{
      kind: 31337,
      maxContentBytes: 1024,
      maxTags: 8,
      maxTagBytes: 2048,
      allowedTagNames: ['scope', 'p'],
      requiredTags: [['scope', 'release']],
    }];
    expect(describeNostrKindRule(nostrKindRules[0])).toBe(
      'Kind 31337: content ≤ 1024 bytes; tags ≤ 8 / 2048 bytes; names scope, p; required scope="release"',
    );
    expect(draftFromPolicy({
      id: 'custom-nostr', name: 'Custom', description: 'Custom kind', enabled: true,
      operations: ['nostr.sign'], eventKinds: [31337], nostrKindRules,
      nip98Targets: [], assignments: { profileIds: ['profile-a'], workspaceIds: [] },
    }).nostrKindRules).toBe(nostrKindRules);
  });

  test('summarizes both editable and built-in NIP-98 target shapes without crashing', () => {
    expect(describeNip98Target({
      origin: 'https://tower.example', methods: ['POST'],
      exactPaths: ['/api/v4/git/oidc/authorize/complete'], pathPrefixes: [], requireBodyHash: true,
    })).toBe('https://tower.example · POST · exact /api/v4/git/oidc/authorize/complete · prefixes none · payload hash required');
    expect(describeNip98Target({
      origin: 'https://tower.example',
      exactPaths: [{ path: '/api/v4/messages', methods: ['GET'] }],
      requireBodyHashMethods: [],
    })).toBe('https://tower.example · GET · exact /api/v4/messages · prefixes none · payload hash optional');
  });

  test('shows full exact tags and preserves them through JSON editor save and validation', async () => {
    const exactTags = [['d', 'synthetic'], ['relays', 'wss://one.example/', 'wss://two.example/']];
    const policy = {
      id: 'synthetic-only', name: 'Synthetic', description: 'Exact tags', enabled: false,
      operations: ['nostr.sign'], eventKinds: [30617], nip98Targets: [],
      assignments: { profileIds: [], workspaceIds: [] },
      nostrKindRules: [{ kind: 30617, maxContentBytes: 0, maxTags: 16, maxTagBytes: 4096,
        allowedTagNames: ['d', 'relays'], exactTags }],
    };
    expect(describeNostrKindRule(policy.nostrKindRules[0])).toContain(
      'exactly once (full tag) ["d","synthetic"], ["relays","wss://one.example/","wss://two.example/"]',
    );
    const originalFetch = globalThis.fetch;
    try {
      let saved;
      globalThis.fetch = async (_url, options) => {
        saved = validateSigningPolicyDraft(JSON.parse(options.body));
        return Response.json({ policy: saved });
      };
      await saveSigningPolicy(policy.id, JSON.parse(JSON.stringify(draftFromPolicy(policy))));
      expect(saved.nostrKindRules[0].exactTags).toEqual(exactTags);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
