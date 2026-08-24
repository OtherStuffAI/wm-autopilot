function requireChallenge(payload) {
  if (typeof payload?.challenge !== "string" || !payload.challenge) {
    throw new Error("Server returned an invalid login challenge");
  }
  return payload.challenge;
}

export function createLoginEventTemplate(challenge, pageUrl = window.location.href) {
  const loginUrl = new URL("/api/auth/session", pageUrl);
  return {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", loginUrl.toString()],
      ["method", "POST"],
      ["purpose", "wingman-login"],
      ["challenge", challenge],
    ],
    content: challenge,
  };
}

async function requestLoginChallenge(fetchImpl) {
  const response = await fetchImpl("/api/auth/challenge", {
    method: "GET",
    credentials: "include",
    headers: { "cache-control": "no-store" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : `Failed to create login challenge (${response.status})`;
    throw new Error(message);
  }
  return requireChallenge(payload);
}

export async function persistServerSession(
  npub,
  encryptedNsec,
  signEvent,
  options = {},
) {
  if (typeof signEvent !== "function") {
    throw new Error("A login signer is required");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const challenge = await requestLoginChallenge(fetchImpl);
  const signedEvent = await signEvent(createLoginEventTemplate(challenge, options.pageUrl));
  if (!signedEvent || typeof signedEvent !== "object") {
    throw new Error("Login signer returned an invalid event");
  }

  const response = await fetchImpl("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      npub,
      encryptedNsec: typeof encryptedNsec === "string" ? encryptedNsec : null,
      challenge,
      signedEvent,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof payload.error === "string" ? payload.error : `Failed to create session (${response.status})`;
    throw new Error(message);
  }

  const expiresAt = typeof payload?.expiresAt === "number" && Number.isFinite(payload.expiresAt) ? payload.expiresAt : null;
  return { expiresAt };
}
