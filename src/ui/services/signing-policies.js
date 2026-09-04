async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Signing policy request failed (${response.status})`);
  return payload;
}

export function loadSigningPolicies() {
  return request('/api/admin/signing-policies');
}

export function loadSigningPolicy(policyId) {
  return request(`/api/admin/signing-policies/${encodeURIComponent(policyId)}`);
}

export function saveSigningPolicy(policyId, draft, { create = false } = {}) {
  return request(create ? '/api/admin/signing-policies' : `/api/admin/signing-policies/${encodeURIComponent(policyId)}`, {
    method: create ? 'POST' : 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

export function setSigningPolicyEnabled(policyId, enabled) {
  return request(`/api/admin/signing-policies/${encodeURIComponent(policyId)}/enabled`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export function reissueSigningCapability(sessionId) {
  return request(`/api/admin/signing-policies/sessions/${encodeURIComponent(sessionId)}/reissue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}
