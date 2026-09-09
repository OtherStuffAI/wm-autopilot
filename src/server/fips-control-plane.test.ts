import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { FipsControlPlane, controlPlaneFipsPort } from "./fips-control-plane";
import { resolveHttpsRedirectUrl } from "./request-url";

const NODE = "npub1sx42mj99aql52aklsg70y2jmr95u7uz2p40k769aw46ppjv302kqkhmu5r";
const MESH = "fd1b:4788:b7ab:7a43:6a61:1fc5:9fb1:e34c";

async function listeningControlPlane() {
  let binding: unknown;
  const server = {
    once: () => server, on: () => server, off: () => server,
    listen: (options: unknown, done: () => void) => { binding = options; done(); },
    close: (done: () => void) => done(),
  } as unknown as Server;
  const control = new FipsControlPlane({
    env: { FIPS_AUTOPILOT_ENABLED: "true" },
    discover: async () => ({ nodeNpub: NODE, meshAddress: MESH }),
    serverFactory: (() => server) as typeof createServer,
  });
  await control.start(3600);
  return { control, binding };
}

describe("Autopilot FIPS ingress", () => {
  test("binds only the node mesh address on a distinct port", async () => {
    const { control, binding } = await listeningControlPlane();
    expect(binding).toEqual({ host: MESH, port: 3601, ipv6Only: true });
    expect(control.getEndpoint()).toMatchObject({ status: "listening", url: `http://${NODE}.fips:3601/` });
    await control.shutdown();
  });

  test("rejects wildcard ports, target collision and managed-app range", () => {
    for (const value of ["0", "3600", "41000", "65536", "no", "1024.5", ""]) {
      expect(() => controlPlaneFipsPort(value, 3600)).toThrow();
    }
    expect(controlPlaneFipsPort("8080", 3600)).toBe(8080);
  });

  test("disabled, missing node and invalid configuration never claim public traffic", async () => {
    const disabled = new FipsControlPlane({ env: { FIPS_AUTOPILOT_ENABLED: "false" } });
    expect(await disabled.start(3600)).toMatchObject({ status: "disabled", url: null });
    const absent = new FipsControlPlane({ env: { FIPS_AUTOPILOT_ENABLED: "true" }, discover: async () => { throw new Error("node offline"); } });
    expect(await absent.start(3600)).toMatchObject({ status: "unavailable", url: null, error: "node offline" });
    const invalid = new FipsControlPlane({ env: { FIPS_AUTOPILOT_ENABLED: "true", FIPS_AUTOPILOT_PORT: "3600" } });
    expect(await invalid.start(3600)).toMatchObject({ status: "error", url: null });
    expect(absent.isMeshUrl(new URL(`http://${NODE}.fips:3601/`))).toBe(false);
  });

  test("bind conflicts remain visible and cannot activate mesh authentication", async () => {
    const server = createServer();
    server.listen = (() => { throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" }); }) as typeof server.listen;
    const control = new FipsControlPlane({
      env: { FIPS_AUTOPILOT_ENABLED: "true" },
      discover: async () => ({ nodeNpub: NODE, meshAddress: MESH }),
      serverFactory: (() => server) as typeof createServer,
    });
    expect(await control.start(3600)).toMatchObject({ status: "conflict", error: "Port 3601 is already bound on the FIPS mesh address" });
    expect(control.isMeshUrl(new URL(`http://${NODE}.fips:3601/`))).toBe(false);
    await control.shutdown();
  });

  test("mesh URL keeps exact auth origin, redirects and HTTP cookies; HTTPS remains secure", async () => {
    const { control } = await listeningControlPlane();
    const url = new URL(`http://${NODE}.fips:3601/?next=apps`);
    const publicBase = "https://autopilot.example";
    expect(control.authenticationBaseUrl(url, publicBase)).toBe(url.origin);
    expect(control.authenticationBaseUrl(new URL(`http://${NODE}.fips:3602/`), publicBase)).toBe(publicBase);
    expect(control.authenticationBaseUrl(new URL("http://other.fips:3601/"), publicBase)).toBe(publicBase);
    const request = new Request(url);
    expect(control.homeUrl(request, url, publicBase).href).toBe(`${url.origin}/home?next=apps`);
    expect(resolveHttpsRedirectUrl(request, url, publicBase)).toBeNull();
    const original = Bun.env.IDENTITY_COOKIE_SECURE;
    try {
      Bun.env.IDENTITY_COOKIE_SECURE = "true";
      expect(control.secureCookies(request)).toBe(false);
      expect(control.secureCookies(new Request(publicBase))).toBe(true);
    } finally {
      if (original === undefined) delete Bun.env.IDENTITY_COOKIE_SECURE;
      else Bun.env.IDENTITY_COOKIE_SECURE = original;
      await control.shutdown();
    }
    const publicUrl = new URL("http://autopilot.example/path?q=1");
    expect(resolveHttpsRedirectUrl(new Request(publicUrl), publicUrl, publicBase)).toBe(`${publicBase}/path?q=1`);
  });
});
