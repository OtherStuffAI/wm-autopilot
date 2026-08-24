async function readJsonResponse(response, fallbackMessage) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || fallbackMessage);
  return payload;
}

export async function replaceTerminalPin(pin, confirmPin) {
  const response = await fetch('/api/terminal/pin', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ pin, confirmPin }),
  });
  return readJsonResponse(response, 'Failed to save terminal PIN');
}
