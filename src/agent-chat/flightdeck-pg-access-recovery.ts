export const FLIGHT_DECK_PG_ACCESS_RETRY_CODE = 'flightdeck_pg_access_retrying';
export const FLIGHT_DECK_PG_ACCESS_FAILED_CODE = 'flightdeck_pg_access_failed';

export function isRetryableTowerAccessError(error: unknown): boolean {
  const candidate = error && typeof error === 'object'
    ? error as { status?: unknown; statusCode?: unknown; name?: unknown }
    : null;
  const status = typeof candidate?.status === 'number'
    ? candidate.status
    : typeof candidate?.statusCode === 'number'
      ? candidate.statusCode
      : null;
  if (status === 408 || status === 429 || (status !== null && status >= 500)) {
    return true;
  }
  if (status !== null) {
    return false;
  }

  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  if (/^(AbortError|TimeoutError)$/i.test(name)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /"retryable"\s*:\s*true|bad gateway|gateway timeout|service unavailable|cannot find module|module not found|failed to resolve|import failed|fetch failed|network error|unable to connect|computer able to access the url|typo in the url or port|connection refused|econnreset|econnrefused|etimedout|operation (?:was )?(?:aborted|timed out)|request (?:was )?(?:aborted|timed out)|aborterror|timeouterror/i.test(message);
}

export function flightDeckPgReconnectDelayMs(
  reconnectAttempts: number,
  baseDelayMs: number,
  maximumDelayMs: number,
): number {
  return Math.min(baseDelayMs * Math.pow(2, Math.max(0, reconnectAttempts)), maximumDelayMs);
}
