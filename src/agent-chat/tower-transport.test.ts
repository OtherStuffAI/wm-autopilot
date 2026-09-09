import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19, finalizeEvent, verifyEvent } from "nostr-tools";
import { TowerTransport } from "./tower-transport";
import { normalizeTowerTransport, parseTowerFipsEndpoint } from "./tower-transport-config";

const nodeNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
const serviceNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture() {
  const requests: { url: string; host: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url!, host: req.headers.host!, body });
    if (req.url === "/health") { res.end(JSON.stringify({ service_npub: serviceNpub })); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "https://public.example" }); res.end(); return; }
    if (req.url === "/stream") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: hello\n\n"); return; }
    const event = JSON.parse(Buffer.from(req.headers.authorization!.slice(6), "base64").toString());
    const valid = verifyEvent(event) && event.tags.some((t: string[]) => t[0] === "u" && t[1] === `http://${req.headers.host}${req.url}`)
      && event.tags.some((t: string[]) => t[0] === "method" && t[1] === req.method)
      && event.tags.some((t: string[]) => t[0] === "payload" && t[1] === createHash("sha256").update(body).digest("hex"));
    res.writeHead(valid ? 201 : 401, { "x-fixture": "preserved" }); res.end(body);
  });
  servers.push(server);
  server.listen(0, "::1"); await once(server, "listening");
  const endpoint = `http://${nodeNpub}.fips:${(server.address() as { port: number }).port}`;
  const config = normalizeTowerTransport({ mode: "fips", fipsEndpoint: endpoint, expectedServiceNpub: serviceNpub }, endpoint);
  let publicRequests = 0;
  const transport = new TowerTransport("https://public.example", config, {
    resolveMesh: async () => "::1", timeoutMs: 2000,
    fetch: (() => { publicRequests++; throw new Error("Unexpected public request"); }) as unknown as typeof fetch,
  });
  return { transport, endpoint, requests, publicRequests: () => publicRequests };
}

test("pins native TCP while preserving signed method, encoded path, query, bytes and headers", async () => {
  const { transport, endpoint, requests, publicRequests } = await fixture();
  const path = "/exact%2Fpath?z=2&a=%2B";
  const target = await transport.prepare(`https://public.example${path}`);
  expect(target.toString()).toBe(endpoint + path);
  const body = '{ "exact": "bytes" }';
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [
    ["u", target.toString()], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")],
  ] }, generateSecretKey());
  const response = await transport.fetch(target, { method: "POST", body, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` } });
  expect(response.status).toBe(201); expect(response.headers.get("x-fixture")).toBe("preserved");
  expect(await response.text()).toBe(body);
  expect(requests.at(-1)).toEqual({ url: path, host: new URL(endpoint).host, body });
  expect(publicRequests()).toBe(0);
  expect(transport.diagnostics.verifiedServiceNpub).toBe(serviceNpub);
  expect(transport.diagnostics.counters).toEqual({ https: { requests: 0, errors: 0 }, fips: { requests: 2, errors: 0 } });
});

test("SSE cancellation and transport generation replacement abort the native stream", async () => {
  const { transport, endpoint } = await fixture();
  const response = await transport.fetch(`${endpoint}/stream`, { headers: { accept: "text/event-stream" } });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n");
  const next = reader.read();
  transport.close();
  await expect(next).rejects.toThrow();
  await expect(transport.prepare(`${endpoint}/stream`)).rejects.toThrow("selection changed");
});

test("rejects wrong service, unapproved destination and redirect without public retries", async () => {
  const { transport, endpoint, publicRequests } = await fixture();
  await expect(transport.fetch(`${endpoint}/redirect`)).rejects.toThrow("redirects");
  expect(() => transport.target("https://unapproved.example/path")).toThrow("outside");
  const wrong = new TowerTransport(endpoint, { ...transport.config, expectedServiceNpub: nodeNpub }, { resolveMesh: async () => "::1" });
  await expect(wrong.prepare(endpoint)).rejects.toThrow("identity mismatch");
  expect(publicRequests()).toBe(0);
});

test("mesh outage remains explicit with zero HTTPS requests", async () => {
  const { transport, endpoint, publicRequests } = await fixture();
  const broken = new TowerTransport(endpoint, transport.config, { resolveMesh: async () => { throw new Error("Mesh unavailable"); } });
  await expect(broken.fetch(endpoint)).rejects.toThrow("Mesh unavailable");
  expect(broken.diagnostics.effectiveTransport).toBeNull();
  expect(broken.diagnostics.reconnectState).toBe("error");
  expect(publicRequests()).toBe(0);
});

test.each(["http://localhost:43100", `http://${nodeNpub}.fips:0`, `http://${nodeNpub}.fips:80`, `http://${nodeNpub}.fips:043100`, `http://${nodeNpub}.fips:65536`, `http://${nodeNpub}.fips:43100/path`, `http://${nodeNpub}.fips:43100?x=1`, "http://npub1fake.fips:43100"])("rejects unsafe endpoint %s", (endpoint) => {
  expect(() => parseTowerFipsEndpoint(endpoint)).toThrow();
});

test("one caller can cancel shared identity verification without cancelling another", async () => {
  let release!: (address: string) => void;
  const transport = new TowerTransport("https://public.example", normalizeTowerTransport({
    mode: "fips", fipsEndpoint: `http://${nodeNpub}.fips:43100`, expectedServiceNpub: serviceNpub,
  }, "https://public.example"), {
    resolveMesh: () => new Promise((resolve) => { release = resolve; }),
    requestMesh: async () => Response.json({ service_npub: serviceNpub }),
  });
  const controller = new AbortController();
  const first = transport.prepare("https://public.example/one", controller.signal);
  const second = transport.prepare("https://public.example/two");
  controller.abort(new Error("Caller cancelled"));
  await expect(first).rejects.toThrow("Caller cancelled");
  release("::1");
  expect((await second).pathname).toBe("/two");
  expect(transport.diagnostics.counters.fips.requests).toBe(1);
  transport.close();
});
