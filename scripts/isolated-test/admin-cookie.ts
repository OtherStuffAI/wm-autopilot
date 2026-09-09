import { finalizeEvent } from "nostr-tools";

/** Authenticate only the disposable harness administrator through the normal login challenge. */
export async function testAdministratorCookie(npub: string, key: Uint8Array): Promise<string> {
  const origin = "http://127.0.0.1:3600";
  const challengeResponse = await fetch(`${origin}/api/auth/challenge`);
  if (!challengeResponse.ok) throw new Error("Isolated administrator challenge failed");
  const { challenge } = await challengeResponse.json() as { challenge: string };
  const signedEvent = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: challenge,
    tags: [["u", `${origin}/api/auth/session`], ["method", "POST"], ["purpose", "wingman-login"], ["challenge", challenge]],
  }, key);
  const response = await fetch(`${origin}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub, challenge, signedEvent }) });
  if (!response.ok) throw new Error(`Isolated administrator login failed (${response.status})`);
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  if (!cookies) throw new Error("Isolated administrator login returned no session cookie");
  return cookies;
}
