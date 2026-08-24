export async function fetchUserSettings() {
  const response = await fetch('/api/user/settings', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || response.statusText || 'Failed to load settings');
  }
  return payload?.settings && typeof payload.settings === 'object' ? payload.settings : {};
}

export async function saveUserSetting(key, value) {
  const response = await fetch(`/api/user/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || response.statusText || 'Failed to save setting');
  }
  return payload;
}

export async function deleteUserSetting(key) {
  const response = await fetch(`/api/user/settings/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || response.statusText || 'Failed to delete setting');
  }
  return payload;
}
