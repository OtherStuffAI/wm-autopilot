function createApiError(response, data, fallbackMessage) {
  const message =
    typeof data?.error === "string" && data.error.length > 0
      ? data.error
      : response.statusText || fallbackMessage;
  const error = new Error(message);
  error.status = response.status;
  return error;
}

export async function generateMessageSpeechApi({ sessionId, messageId, text, summary = false, signal }) {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/speech`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, summary, mode: summary ? "summary" : "full" }),
      signal,
    },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "Speech generation failed");
  }

  return data ?? {};
}

export async function fetchMessageSpeechApi({ sessionId, messageId, signal }) {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/speech`,
    { signal },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "Speech lookup failed");
  }

  return data ?? {};
}
