import { afterEach, describe, expect, test } from 'bun:test';

import {
  loadSigningPolicies,
  reissueSigningCapability,
  saveSigningPolicy,
} from './signing-policies.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('signing policy settings service', () => {
  test('loads, saves, and reissues through administrator routes with cookies', async () => {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    };
    await loadSigningPolicies();
    await saveSigningPolicy('policy-a', { id: 'policy-a' });
    await reissueSigningCapability('session-a');
    expect(calls.map((call) => [call.url, call.options.method || 'GET', call.options.credentials])).toEqual([
      ['/api/admin/signing-policies', 'GET', 'include'],
      ['/api/admin/signing-policies/policy-a', 'PUT', 'include'],
      ['/api/admin/signing-policies/sessions/session-a/reissue', 'POST', 'include'],
    ]);
  });

  test('surfaces server validation errors', async () => {
    globalThis.fetch = async () => Response.json({ error: 'Policy path is overbroad' }, { status: 400 });
    expect(loadSigningPolicies()).rejects.toThrow('Policy path is overbroad');
  });
});
