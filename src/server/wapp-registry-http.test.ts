import { describe, expect, test } from "bun:test";
import { handleWappRegistryHttp } from "./wapp-registry-http";
import type { RequestAuthContext } from "../auth/request-context";
const origin = "https://flight.example.invalid", url = new URL("https://autopilot.example.invalid/api/wapps");
const anon = {} as RequestAuthContext;
function setup() { const calls: string[] = []; return { calls,
  resolve: async (_r: Request, _u: URL, auth: RequestAuthContext) => { calls.push("auth"); return auth; },
  read: async () => { calls.push("read"); return Response.json({ wapps: [] }); } }; }
describe("authenticated WApp registry browser boundary", () => {
  test("exact allowed GET preflight precedes authentication and exposes no registry", async () => {
    const s = setup(), r = await handleWappRegistryHttp(new Request(url, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } }), url, anon, s.resolve, s.read, origin);
    expect(r.status).toBe(204); expect(r.headers.get("access-control-allow-origin")).toBe(origin); expect(r.headers.get("access-control-allow-credentials")).toBeNull(); expect(s.calls).toEqual([]);
  });
  test("unknown/null origins, wildcard configuration, writes and extra headers fail closed", async () => {
    for (const [o, method, headers, configured] of [["https://evil.invalid", "GET", "authorization", origin], ["null", "GET", "authorization", origin], [origin, "POST", "authorization", origin], [origin, "GET", "x-other", origin], [origin, "GET", "authorization", "*"]]) {
      const s = setup(), r = await handleWappRegistryHttp(new Request(url, { method: "OPTIONS", headers: { origin: o!, "access-control-request-method": method!, "access-control-request-headers": headers! } }), url, anon, s.resolve, s.read, configured);
      expect(r.status).toBe(403); expect(s.calls).toEqual([]);
    }
  });
  test("cross-origin cookies cannot replace NIP-98; authentication errors retain narrow CORS", async () => {
    const s = setup(), r = await handleWappRegistryHttp(new Request(url, { headers: { origin, cookie: "session=untrusted" } }), url, anon, s.resolve, s.read, origin);
    expect(r.status).toBe(401); expect(r.headers.get("access-control-allow-origin")).toBe(origin); expect(s.calls).toEqual(["auth"]);
  });
  test("signed GET still runs existing authorization/filtering and retains CORS on denial", async () => {
    const s = setup(), auth = { authMethod: "nip98", signerNpub: "reader" } as RequestAuthContext;
    const r = await handleWappRegistryHttp(new Request(url, { headers: { origin } }), url, auth, s.resolve, async effective => { expect(effective).toBe(auth); return Response.json({ error: "permission-denied" }, { status: 403 }); }, origin);
    expect(r.status).toBe(403); expect(r.headers.get("access-control-allow-origin")).toBe(origin); expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
  test("nonbrowser broker calls preserve existing caller and real registry response shape", async () => {
    const s = setup(), r = await handleWappRegistryHttp(new Request(url), url, anon, s.resolve, s.read, origin);
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ wapps: [] }); expect(s.calls).toEqual(["auth", "read"]);
  });
});
