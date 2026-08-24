/**
 * Team billing API client wrappers.
 */

export async function fetchTeamBillingApi() {
  const response = await fetch('/api/billing/team');
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : response.statusText || 'Failed to load billing settings';
    throw new Error(message);
  }
  return payload;
}

export async function updateTeamBillingApi(input) {
  const response = await fetch('/api/billing/team', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : response.statusText || 'Failed to update billing settings';
    throw new Error(message);
  }
  return payload;
}

export async function fetchBillingUsageApi(limit = 50) {
  const queryLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50;
  const response = await fetch(`/api/billing/usage?limit=${encodeURIComponent(String(queryLimit))}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : response.statusText || 'Failed to load billing usage';
    throw new Error(message);
  }
  return payload;
}

