import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  connectPackageExpiry,
  copyAutopilotConnectPackage,
  generateAutopilotConnectPackage,
  isConnectPackageExpired,
} from './autopilot-connect-package.js';

const generatedAt = '2026-09-24T06:00:00.000Z';
const packageValue = { manifest: { version: 2, generated_at: generatedAt }, signature: { id: 'signed' } };
const originalWindow = globalThis.window;
const originalLocation = globalThis.location;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.location = originalLocation;
  globalThis.fetch = originalFetch;
});

describe('Autopilot Connect Package UI service', () => {
  test('tracks the five-minute package lifetime at its exact boundary', () => {
    const expiry = Date.parse(generatedAt) + 300_000;
    expect(connectPackageExpiry(packageValue)).toBe(expiry);
    expect(isConnectPackageExpired(packageValue, expiry - 1)).toBe(false);
    expect(isConnectPackageExpired(packageValue, expiry)).toBe(true);
    expect(isConnectPackageExpired({ manifest: {} }, expiry)).toBe(true);
  });

  test('generates v2 through an exact owner-scoped NIP-98 request', async () => {
    const signEvent = mock(async (event) => ({ ...event, id: 'event-id', pubkey: 'ab'.repeat(32), sig: 'cd'.repeat(64) }));
    globalThis.window = { nostr: { signEvent } };
    globalThis.location = new URL('https://autopilot.example/settings/automation/workspaces');
    globalThis.fetch = mock(async (path, options) => {
      expect(path).toBe('/api/control-plane/v2/connect-package?owner_npub=npub1owner');
      expect(options.method).toBe('GET');
      expect(options.credentials).toBe('include');
      expect(options.headers.Authorization).toMatch(/^Nostr /);
      return Response.json(packageValue);
    });

    expect(await generateAutopilotConnectPackage('npub1owner')).toEqual(packageValue);
    expect(signEvent).toHaveBeenCalledTimes(1);
    expect(signEvent.mock.calls[0][0]).toMatchObject({
      kind: 27235,
      tags: [
        ['u', 'https://autopilot.example/api/control-plane/v2/connect-package?owner_npub=npub1owner'],
        ['method', 'GET'],
      ],
    });
  });

  test('surfaces generation errors and rejects copying expired packages', async () => {
    globalThis.window = { nostr: { signEvent: async (event) => event } };
    globalThis.location = new URL('https://autopilot.example/settings/automation/workspaces');
    globalThis.fetch = mock(async () => Response.json({ error: 'control-plane-read-authority-required' }, { status: 403 }));
    await expect(generateAutopilotConnectPackage('npub1wrong')).rejects.toThrow('control-plane-read-authority-required');

    const clipboard = { writeText: mock(async () => {}) };
    await expect(copyAutopilotConnectPackage(packageValue, clipboard)).rejects.toThrow('expired');
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test('copies only the generated JSON envelope', async () => {
    const fresh = { manifest: { version: 2, generated_at: new Date().toISOString() }, signature: { id: 'signed' } };
    const clipboard = { writeText: mock(async () => {}) };
    await copyAutopilotConnectPackage(fresh, clipboard);
    expect(clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(fresh));
  });
});
