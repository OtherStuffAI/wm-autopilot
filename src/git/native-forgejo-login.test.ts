import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NativeForgejoLogin, type NativeForgejoServer } from "./native-forgejo-login";

export const nativeServer: NativeForgejoServer = { origin: "https://forgejo.test", towerIssuer: "https://tower.test/api/v4/git/oidc", sourceName: "Tower", clientId: "public-client", redirectUri: "http://127.0.0.1:45678/" };
export function nativeFixture(options: { foreignRedirect?: boolean; badState?: boolean; badConsent?: boolean; denied?: boolean; expiresIn?: number } = {}) {
  const calls: Request[] = [];
  let authorize: URL, authenticated = false, logins = 0, userStatus = 200;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); calls.push(request.clone()); const url = new URL(request.url);
    if (url.origin === "https://tower.test") {
      if (url.pathname.endsWith("/complete")) { logins++; if (options.denied) return new Response(null,{status:403}); return Response.json({ redirect_to: "https://forgejo.test/user/oauth2/Tower/callback?code=tower-code&state=native-oidc-state" }); }
      return Response.json({ request_id: "challenge", completion_url: `${nativeServer.towerIssuer}/authorize/complete`, client_id: "tower-client", expires_at: Math.floor(Date.now()/1000)+60 });
    }
    if (url.pathname.endsWith("/callback")) { authenticated = true; return Response.redirect("https://forgejo.test/",302); }
    if (url.pathname === "/") return new Response("dashboard");
    if (url.pathname === "/user/login") return new Response("login");
    if (url.pathname === "/user/oauth2/Tower") return Response.redirect(`${nativeServer.towerIssuer}/authorize?client_id=tower-client`,302);
    if (url.pathname === "/login/oauth/access_token") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(nativeServer.redirectUri);
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));
      return Response.json({ access_token: `native-token-${logins}`, token_type: "bearer", expires_in: options.expiresIn ?? 3600, refresh_token: "ignored-native-refresh" });
    }
    if (url.pathname === "/api/v1/user") return userStatus === 200 ? Response.json({login:'agent'}) : new Response(null,{status:userStatus});
    if (["/login/oauth/authorize", "/login/oauth/grant"].includes(url.pathname)) {
      if (request.method === "POST") {
        const body = new URLSearchParams(await request.text()); expect(body.get('_csrf')).toBe('csrf'); expect(body.get('granted')).toBe('true'); expect(request.headers.get('cookie')).toContain('session=stock');
        return Response.redirect(`${nativeServer.redirectUri}?code=native-code&state=${options.badState ? 'foreign-state' : authorize.searchParams.get('state')}`,302);
      }
      authorize = url;
      if (!request.headers.has("cookie")) authenticated = false;
      if (!authenticated) return new Response(null,{status:302,headers:{location:options.foreignRedirect ? 'https://attacker.test/' : '/user/login','set-cookie':'session=stock; HttpOnly; Path=/'}});
      return new Response('<form method="post" action="/login/oauth/grant">'+['_csrf','client_id','state','redirect_uri'].map(name=>`<input type="hidden" name="${name}" value="${name === '_csrf' ? 'csrf' : name === 'state' && options.badConsent ? 'foreign' : url.searchParams.get(name)}">`).join('')+'</form>');
    }
    throw new Error('Unexpected test route');
  }) as typeof fetch;
  return { calls, fetchImpl, logins: () => logins, setUserStatus: (value: number) => { userStatus = value; } };
}

describe("native Forgejo login", () => {
  test("binds PKCE, state, stock cookies/CSRF and exact Tower challenge signature", async () => {
    const fixture = nativeFixture(); let signature: any;
    const credential = await new NativeForgejoLogin(nativeServer,fixture.fetchImpl).login(async input => {signature=input;return 'Nostr proof';});
    expect(credential.username).toBe('agent'); expect(credential.password).toBe('native-token-1');
    expect(signature).toMatchObject({url:`${nativeServer.towerIssuer}/authorize/complete`,method:'POST',bodyHash:createHash('sha256').update(JSON.stringify({request_id:'challenge'})).digest('hex')});
    expect(signature.tags).toEqual(expect.arrayContaining([['nonce','challenge'],['aud','tower-client']]));
    expect(fixture.calls.filter(request=>request.headers.has('authorization')).map(request=>new URL(request.url).origin)).toEqual(['https://tower.test','https://forgejo.test']);
  });
  for (const options of [{foreignRedirect:true},{badState:true},{badConsent:true},{denied:true}]) test(`rejects ${JSON.stringify(options)}`,async()=>{
    const fixture=nativeFixture(options);await expect(new NativeForgejoLogin(nativeServer,fixture.fetchImpl).login(async()=> 'Nostr proof')).rejects.toThrow();
  });
});
