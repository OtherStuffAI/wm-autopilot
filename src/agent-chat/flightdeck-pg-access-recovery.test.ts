import { expect, test } from 'bun:test';
import { isRetryableTowerAccessError } from './flightdeck-pg-access-recovery';

test('retries native socket errors independently of their runtime message', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']) {
    expect(isRetryableTowerAccessError(Object.assign(new Error('Transport unavailable'), { code }))).toBe(true);
  }
});

test('retries Bun socket closures and transport backoff diagnostics', () => {
  const message = 'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';
  expect(isRetryableTowerAccessError(new Error(message))).toBe(true);
  expect(isRetryableTowerAccessError(new Error(`Tower FIPS reconnect is backed off until 2026-09-28T05:05:41.559Z: ${message}`))).toBe(true);
});

test('keeps permanent HTTP and identity failures non-retryable', () => {
  for (const status of [400, 401, 403, 404]) {
    expect(isRetryableTowerAccessError(Object.assign(new Error('Network error'), { status, code: 'ECONNRESET' }))).toBe(false);
  }
  expect(isRetryableTowerAccessError(new Error('Tower service identity mismatch on approved mesh endpoint'))).toBe(false);
  expect(isRetryableTowerAccessError(Object.assign(new Error('Invalid transport configuration'), { code: 'EINVAL' }))).toBe(false);
});
