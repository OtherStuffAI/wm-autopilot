/**
 * Voice note upload and send-time transcription API helpers.
 */

function createApiError(response, data, fallbackMessage) {
  const message =
    typeof data?.error === "string" && data.error.length > 0
      ? data.error
      : response.statusText || fallbackMessage;
  const error = new Error(message);
  error.status = response.status;
  if (typeof data?.publicPath === "string") {
    error.publicPath = data.publicPath;
  }
  return error;
}

export async function uploadVoiceNoteApi({ agent, file, signal }) {
  const form = new FormData();
  form.append("agent", agent);
  form.append("audio", file, file.name);

  const response = await fetch("/api/uploads/voice-notes", {
    method: "POST",
    body: form,
    signal,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "Voice note upload failed");
  }

  return data ?? {};
}

export async function transcribeVoiceNoteApi({ publicPath, signal }) {
  const response = await fetch("/api/uploads/voice-notes/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicPath }),
    signal,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createApiError(response, data, "Voice note transcription failed");
  }

  return data ?? {};
}
