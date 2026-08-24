function extractErrorMessage(payload, fallback) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string' && payload.message.length > 0) {
      return payload.message;
    }
    if (typeof payload.error === 'string' && payload.error.length > 0) {
      return payload.error;
    }
  }
  return fallback;
}

export async function fetchRemoteInstructTemplate() {
  const response = await fetch('/api/remote-instruct/template', {
    credentials: 'include',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, response.statusText || 'Failed to load Remote Instruct'));
  }
  return payload;
}

export async function saveRemoteInstructTemplate(template) {
  const response = await fetch('/api/remote-instruct/template', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, response.statusText || 'Failed to save Remote Instruct'));
  }
  return payload;
}
