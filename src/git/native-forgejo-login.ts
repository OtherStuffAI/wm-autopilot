import { createHash, randomBytes } from "node:crypto";

export interface NativeForgejoServer {
  origin: string;
  towerIssuer: string;
  sourceName: string;
  clientId: string;
  redirectUri: string;
}
export type ForgejoSigner = (input: {
  url: string; method: "GET" | "POST" | "PUT"; bodyHash?: string; tags?: string[][];
}) => Promise<string>;
export interface NativeForgejoCredential { username: string; password: string; expiresAt: string }

export function trustedOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Forgejo authentication requires HTTPS (HTTP is allowed only on loopback).");
  }
  return url.origin;
}

// Deliberately implement only stock OIDC login and OAuth consent. Password,
// account-linking and 2FA forms require their normal interactive completion.
export class NativeForgejoLogin {
  constructor(readonly config: NativeForgejoServer, private readonly fetchImpl: typeof fetch = fetch) {
    if (trustedOrigin(config.origin) !== config.origin) throw new Error("Forgejo origin must be canonical.");
    trustedOrigin(config.towerIssuer);
    const callback = new URL(config.redirectUri);
    if (!['http:', 'https:'].includes(callback.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) || callback.username || callback.password || callback.search || callback.hash) throw new Error("OAuth redirect must be an exact loopback callback without query parameters.");
  }

  async login(signNip98: ForgejoSigner): Promise<NativeForgejoCredential> {
    const { origin, towerIssuer, sourceName, clientId, redirectUri } = this.config;
    const cookies = new Map<string, Map<string, string>>();
    const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
    const authorization = new URL("/login/oauth/authorize", origin);
    authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    const issuer = new URL(towerIssuer);
    let current = authorization, method = "GET", body: string | undefined, headers: Record<string,string> = {};
    let beganOidc = false, completedOidc = false;
    for (let step = 0; step < 30; step++) {
      if (current.origin === new URL(redirectUri).origin && current.pathname === new URL(redirectUri).pathname) {
        if (current.searchParams.getAll("state").length !== 1 || current.searchParams.get("state") !== state || current.searchParams.getAll("code").length !== 1 || current.searchParams.has("error")) throw new Error("Forgejo OAuth callback state or code is invalid.");
        const response = await this.fetchImpl(`${origin}/login/oauth/access_token`, { method: "POST", redirect: "error",
          headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code: current.searchParams.get("code")!, code_verifier: verifier }) });
        if (!response.ok) throw new Error(`Forgejo OAuth code exchange failed (${response.status}).`);
        const token = await response.json() as { access_token?: string; expires_in?: number; token_type?: string };
        if (!token.access_token || /[\r\n]/.test(token.access_token) || token.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(token.expires_in) || token.expires_in! <= 0) throw new Error("Forgejo issued a malformed native OAuth credential.");
        const user = await this.fetchImpl(`${origin}/api/v1/user`, { redirect: "error", headers: { authorization: `Bearer ${token.access_token}` } });
        if (!user.ok) throw new Error(`Forgejo rejected its issued account credential (${user.status}).`);
        const account = await user.json() as { login?: string };
        if (!account.login || /[\r\n]/.test(account.login)) throw new Error("Forgejo account username is invalid.");
        return { username: account.login, password: token.access_token, expiresAt: new Date(Date.now() + token.expires_in! * 1000).toISOString() };
      }
      const isTower = current.origin === issuer.origin && current.pathname === `${issuer.pathname.replace(/\/$/, "")}/authorize`;
      if (current.origin !== origin && !isTower) throw new Error("Forgejo login attempted an untrusted redirect.");
      const jar = cookies.get(current.origin) ?? new Map<string,string>(); cookies.set(current.origin, jar);
      const response = await this.fetchImpl(current.toString(), { method, body, redirect: "manual", headers: {
        ...headers, ...(jar.size ? { cookie: [...jar].map(([key,value]) => `${key}=${value}`).join("; ") } : {}),
        ...(isTower ? { accept: "application/json" } : {}),
      } });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1)); }
      if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
        current = new URL(response.headers.get("location")!, current); method = "GET"; body = undefined; headers = {}; continue;
      }
      if (!response.ok) throw new Error(`Native Forgejo sign-in failed (${response.status}).`);
      if (isTower) {
        if (completedOidc) throw new Error("Repeated Tower authentication challenge.");
        const challenge = await response.json() as { request_id: string; completion_url: string; client_id: string; expires_at: number };
        const completion = `${towerIssuer.replace(/\/$/, "")}/authorize/complete`;
        const now = Math.floor(Date.now()/1000);
        if (challenge.completion_url !== completion || !challenge.request_id || challenge.client_id !== current.searchParams.get("client_id") || !Number.isInteger(challenge.expires_at) || challenge.expires_at <= now || challenge.expires_at > now + 65) throw new Error("Invalid Tower login challenge.");
        const raw = JSON.stringify({ request_id: challenge.request_id });
        const proof = await signNip98({ url: completion, method: "POST", bodyHash: createHash("sha256").update(raw).digest("hex"), tags: [["nonce", challenge.request_id], ["aud", challenge.client_id], ["expiration", String(challenge.expires_at)]] });
        const result = await this.fetchImpl(completion, { method: "POST", redirect: "error", headers: { authorization: proof, "content-type": "application/json", accept: "application/json" }, body: raw });
        if (!result.ok) throw new Error(`Tower Nostr sign-in denied (${result.status}).`);
        const next = await result.json() as { redirect_to: string };
        current = new URL(next.redirect_to); completedOidc = true; continue;
      }
      const html = await response.text();
      if (current.pathname === "/user/login" && !beganOidc) {
        beganOidc = true; current = new URL(`/user/oauth2/${encodeURIComponent(sourceName)}`, origin); continue;
      }
      if (current.pathname === "/login/oauth/authorize") {
        const form = parseConsent(html);
        if (["client_id", "state", "redirect_uri"].some(key => form.getAll(key).length !== 1) || form.get("client_id") !== clientId || form.get("state") !== state || form.get("redirect_uri") !== redirectUri) throw new Error("Forgejo OAuth consent binding is invalid.");
        const referer = current.toString();
        form.set("granted", "true"); current = new URL("/login/oauth/grant", origin); method = "POST"; body = form.toString(); headers = { "content-type": "application/x-www-form-urlencoded", origin, referer }; continue;
      }
      // A successful OIDC callback may render the dashboard before returning.
      if (completedOidc && current.pathname === "/") { current = authorization; continue; }
      throw new Error(`Native Forgejo sign-in requires interactive completion at ${current.pathname}.`);
    }
    throw new Error("Native Forgejo sign-in exceeded the redirect limit.");
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x[0-9a-f]+|#[0-9]+);/gi, entity => {
    const named: Record<string,string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'" };
    if (named[entity]) return named[entity]!;
    return String.fromCodePoint(entity.startsWith('&#x') ? parseInt(entity.slice(3,-1),16) : parseInt(entity.slice(2,-1),10));
  });
}
function parseConsent(html: string): URLSearchParams {
  const fields = new URLSearchParams();
  const consent = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].find(match => /action=["']\/login\/oauth\/grant["']/.test(match[1]!));
  if (!consent) throw new Error("Stock Forgejo OAuth consent form is missing.");
  for (const input of consent[2]!.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = new Map([...input[0].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(match => [match[1]!, decodeHtml(match[2]!) ]));
    if (attrs.get('type') === 'hidden' && attrs.has('name')) fields.append(attrs.get('name')!, attrs.get('value') ?? '');
  }
  return fields;
}
