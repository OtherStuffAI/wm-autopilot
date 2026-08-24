import { describe, expect, test } from 'bun:test';

import { triggerRestartApi } from './config.js';

describe('restart config service', () => {
  test('uses the canonical restart endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ status: 'scheduled', mode: 'resume-or-fresh' }, { status: 202 });
    };

    try {
      const result = await triggerRestartApi();
      expect(result.mode).toBe('resume-or-fresh');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([{
      url: '/api/system/restart',
      init: { method: 'POST' },
    }]);
  });
});
