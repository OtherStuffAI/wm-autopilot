const retryableUploadStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function createUploadForm(agent, file, uploadId) {
  const form = new FormData();
  form.append("agent", agent);
  form.append("uploadId", uploadId);
  form.append("image", file, file.name);
  return form;
}

async function readUploadPayload(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error || response.statusText || "Unknown error";
    const error = new Error(`Image upload failed (${response.status}): ${detail}`);
    error.status = response.status;
    error.retryable = retryableUploadStatuses.has(response.status);
    throw error;
  }
  return payload;
}

async function recoverCompletedUpload(fetchImpl, agent, file, uploadId) {
  const query = new URLSearchParams({
    agent,
    uploadId,
    name: file.name,
    mime: file.type,
  });
  try {
    const response = await fetchImpl(`/api/uploads/images/status?${query.toString()}`);
    if (response.ok) {
      return await readUploadPayload(response);
    }
  } catch {
    // The recovery request shares the same connection and may fail too.
  }
  return null;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function uploadImageWithRecovery({
  agent,
  file,
  fetchImpl = fetch,
  uploadId = crypto.randomUUID(),
  attempts = 2,
  retryDelayMs = 300,
}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl("/api/uploads/images", {
        method: "POST",
        body: createUploadForm(agent, file, uploadId),
      });
      return await readUploadPayload(response);
    } catch (error) {
      lastError = error;
      if (error?.retryable === false) {
        throw error;
      }
      const recovered = await recoverCompletedUpload(fetchImpl, agent, file, uploadId);
      if (recovered) {
        return recovered;
      }
      if (attempt + 1 < attempts) {
        await wait(retryDelayMs * (attempt + 1));
      }
    }
  }
  throw lastError ?? new Error("Image upload failed");
}
