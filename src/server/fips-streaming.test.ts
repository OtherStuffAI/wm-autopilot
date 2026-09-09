import { expect, test } from "bun:test";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { WebSocket } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { createTcpForwardingServer, isForwardedTcpPeer } from "../apps/fips-app-ingress-manager";
import { Nip98ReplayCache, verifyNip98Request } from "../auth/nip98-verifier";
import { mintSessionCookie, readSessionCookie } from "../auth/session-cookie";

Bun.env.IDENTITY_SESSION_SECRET ??= "FipsIngress-TestOnly-SessionCookie-2026!";

test("TCP ingress preserves exact NIP98 upload URLs, cookies, SSE, assets and WebSockets", async () => {
  const origin = "http://npub1sx42mj99aql52aklsg70y2jmr95u7uz2p40k769aw46ppjv302kqkhmu5r.fips:3601";
  const cache = new Nip98ReplayCache(100, ":memory:");
  const secret = generateSecretKey();
  const sockets = new Set<Socket>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/internal") {
        const peer = server.requestIP(request)!;
        return new Response(null, { status: isForwardedTcpPeer(sockets, peer) ? 403 : 200 });
      }
      if (url.pathname === "/socket") {
        if (request.headers.get("cookie") !== "session=valid") return new Response("Unauthorized", { status: 401 });
        if (request.headers.get("origin") !== origin) return new Response("Forbidden", { status: 403 });
        if (server.upgrade(request)) return;
      }
      if (url.pathname === "/asset.js") return new Response("export const loaded = true;", { headers: { "content-type": "application/javascript" } });
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `${origin}/home?x=1`, "set-cookie": "session=valid; HttpOnly; SameSite=Lax; Path=/" } });
      if (url.pathname === "/events") return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          setTimeout(() => { controller.enqueue(new TextEncoder().encode("data: second\n\n")); controller.close(); }, 20);
        },
      }), { headers: { "content-type": "text/event-stream" } });
      const verified = await verifyNip98Request({ request, requestUrl: url, configuredBaseUrl: origin, replayCache: cache });
      if (!verified) return new Response("Unauthorized", { status: 401 });
      return Response.json({ url: request.url, body: await request.text(), signer: verified.signerNpub });
    },
    websocket: { message(ws, message) { ws.send(message); } },
  });
  const proxy = createTcpForwardingServer(upstream.port!, createServer, sockets);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const headers = { host: new URL(origin).host };
  try {
    expect((await fetch(`${local}/internal`, { headers: { host: "localhost" } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${upstream.port}/internal`)).status).toBe(200);
    const body = "upload\u0000unicode-🌱";
    const path = "/api/upload?owner=alice&path=a%2Fb";
    function authorization(signedUrl: string) {
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [
        ["u", signedUrl], ["method", "POST"], ["payload", bytesToHex(sha256(new TextEncoder().encode(body)))],
      ] }, secret);
      return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
    }
    const auth = authorization(`${origin}${path}`);
    const upload = await fetch(`${local}${path}`, { method: "POST", headers: { ...headers, authorization: auth }, body });
    expect(upload.status).toBe(200);
    const result = await upload.json();
    expect(result).toMatchObject({ url: `${origin}${path}`, body });
    const { cookie } = mintSessionCookie(result.signer, { secure: false });
    expect(cookie).not.toContain("; Secure");
    expect(cookie).toContain("HttpOnly");
    expect(readSessionCookie(cookie)).toBeTruthy();
    for (const value of [undefined, auth, authorization(`https://autopilot.example${path}`), authorization(`${origin}/api/upload?owner=bob`)]) {
      expect((await fetch(`${local}${path}`, { method: "POST", headers: { ...headers, ...(value ? { authorization: value } : {}) }, body })).status).toBe(401);
    }
    const asset = await fetch(`${local}/asset.js`, { headers });
    expect(asset.headers.get("content-type")).toBe("application/javascript");
    expect(await asset.text()).toContain("export const");
    const redirect = await fetch(`${local}/redirect`, { headers, redirect: "manual" });
    expect(redirect.headers.get("location")).toBe(`${origin}/home?x=1`);
    expect(redirect.headers.get("set-cookie")).toContain("HttpOnly");
    const events = await fetch(`${local}/events`, { headers });
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");
    expect((await reader.read()).done).toBe(true);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${local.replace("http:", "ws:")}/socket`, { headers: { ...headers, cookie: "session=valid", origin } });
      ws.on("error", reject);
      ws.on("open", () => ws.send("terminal\u001b[31m"));
      ws.on("message", (data) => { expect(data.toString()).toBe("terminal\u001b[31m"); ws.close(); });
      ws.on("close", () => resolve());
    });
    for (const extra of [{ origin }, { cookie: "session=valid", origin: "https://wrong.example" }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: (proxy.address() as AddressInfo).port });
        let response = "";
        socket.setTimeout(2000, () => socket.destroy(new Error("handshake timed out")));
        socket.on("error", reject);
        socket.on("connect", () => socket.write([
          "GET /socket HTTP/1.1", `Host: ${headers.host}`, "Connection: Upgrade", "Upgrade: websocket",
          "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`), "", "",
        ].join("\r\n")));
        socket.on("data", (data) => {
          response += data.toString();
          if (response.includes("\r\n\r\n")) { socket.destroy(); resolve(Number(response.split(" ")[1])); }
        });
      });
      expect(status).toBe(extra.cookie ? 403 : 401);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    upstream.stop(true);
  }
}, 10000);
