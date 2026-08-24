async function readJsonResponse(response, fallbackMessage) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || response.statusText || fallbackMessage);
  }
  return payload;
}

export async function fetchInstanceSettings() {
  const response = await fetch('/api/instance-settings', { credentials: 'include' });
  return readJsonResponse(response, 'Failed to load instance settings');
}

export async function importInstanceSettings(keys) {
  const response = await fetch('/api/instance-settings/import', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
  return readJsonResponse(response, 'Failed to import settings');
}

export async function saveInstanceSetting(key, value) {
  const response = await fetch(`/api/instance-settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  return readJsonResponse(response, 'Failed to save setting');
}

export async function deleteInstanceSetting(key) {
  const response = await fetch(`/api/instance-settings/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  return readJsonResponse(response, 'Failed to delete setting');
}

export async function backupEnvFile() {
  const response = await fetch('/api/instance-settings/backup-env', {
    method: 'POST',
    credentials: 'include',
  });
  return readJsonResponse(response, 'Failed to back up env file');
}

export async function cleanupEnvFile(keys) {
  const response = await fetch('/api/instance-settings/cleanup-env', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
  return readJsonResponse(response, 'Failed to clean up env file');
}
