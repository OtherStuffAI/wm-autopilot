import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TinfoilProxy, TinfoilProxyError } from "./tinfoil-proxy";

// Synthetic fixtures: shell scripts that emit a ready line. They perform NO attestation and use no provider, model or payment.
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const iso = (ms: number) => new Date(ms).toISOString();
const summary = (now: number, patch: Record<string, unknown> = {}) => ({
  enclave: "inference.example", repo: "org/repo", project: "proj", release_tag: "v1", release_digest: "abc", platform: "tdx",
  tls_key_fingerprint: "ff", verified_at: iso(now - 1000), expires_at: iso(now + 3_600_000), ...patch,
});
const ready = (now: number, patch: Record<string, unknown> = {}, listen = "127.0.0.1:43111") => ({ event: "ready", listen, verification: summary(now, patch) });

function fixture(body: (record: string) => string, options: { pin?: boolean | string; now?: () => number; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tinfoil-proxy-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const record = join(dir, "record");
  const binary = join(dir, "tinfoil-proxy");
  const script = `#!/bin/sh\necho spawn >> '${record}.spawns'\nenv > '${record}.env'\n${body(record)}\n`;
  writeFileSync(binary, script);
  chmodSync(binary, 0o700);
  const sha256 = typeof options.pin === "string" ? options.pin : options.pin === false ? undefined : createHash("sha256").update(script).digest("hex");
  const proxy = new TinfoilProxy({ binary, sha256, now: options.now, handshakeTimeoutMs: options.timeoutMs ?? 5000 });
  cleanups.push(() => proxy.close());
  return { proxy, binary, record, spawns: () => (existsSync(`${record}.spawns`) ? readFileSync(`${record}.spawns`, "utf8").trim().split("\n").length : 0) };
}
const emit = (message: unknown) => `printf '%s\\n' '${JSON.stringify(message)}'`;
const serve = (message: unknown, tail = "exec sleep 60") => (record: string) => `${emit(message)}\nread line\necho "$line" > '${record}.signal'\n${tail}`;
const code = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { expect(error).toBeInstanceOf(TinfoilProxyError); expect((error as Error).message).toBe("tinfoil_verified_proxy_unavailable"); return (error as TinfoilProxyError).code; } throw new Error("accepted"); };
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(30); expect(check()).toBe(true); };

test("verified current summary returns a loopback endpoint and releases the child with go", async () => {
  const f = fixture(serve(ready(Date.now())));
  expect(await f.proxy.baseUrl()).toBe("http://127.0.0.1:43111/v1");
  expect(f.proxy.verification()?.platform).toBe("tdx");
  await waitFor(() => existsSync(`${f.record}.signal`));
  expect(readFileSync(`${f.record}.signal`, "utf8").trim()).toBe("go");
});

test("child receives no inherited credentials", async () => {
  process.env.TINFOIL_TEST_PROVIDER_SECRET = "must-not-leak";
  cleanups.push(() => { delete process.env.TINFOIL_TEST_PROVIDER_SECRET; });
  const f = fixture(serve(ready(Date.now())));
  await f.proxy.baseUrl();
  const env = readFileSync(`${f.record}.env`, "utf8");
  expect(env).not.toContain("must-not-leak");
  const names = env.trim().split("\n").map(line => line.split("=")[0]).filter(name => !["PATH", "HOME", "SSL_CERT_FILE", "PWD", "SHLVL", "_", "OLDPWD"].includes(name));
  expect(names).toEqual([]);
});

test("binary must match the operator pin; absent or wrong pin never spawns", async () => {
  for (const pin of [false, "", "0".repeat(64), "not-a-digest"] as const) {
    const f = fixture(serve(ready(Date.now())), { pin });
    expect(await code(f.proxy.baseUrl())).toBe("binary_unpinned");
    expect(f.spawns()).toBe(0);
  }
  expect(await code(new TinfoilProxy({ binary: "/nonexistent/tinfoil-proxy", sha256: "0".repeat(64) }).baseUrl())).toBe("proxy_unavailable");
});

test("legacy, malformed, incomplete, expired or inconsistent summaries fail closed", async () => {
  const now = Date.now();
  const mutations: Array<[string, unknown]> = [
    ["legacy verification_document", { event: "ready", listen: "127.0.0.1:43111", verification_document: { anything: 1 } }],
    ["no verification", { event: "ready", listen: "127.0.0.1:43111" }],
    ["verification string", { event: "ready", listen: "127.0.0.1:43111", verification: "ok" }],
    ["off loopback", ready(now, {}, "0.0.0.0:43111")],
    ["hostname", ready(now, {}, "localhost:43111")],
    ["port zero", ready(now, {}, "127.0.0.1:0")],
    ["port too large", ready(now, {}, "127.0.0.1:70000")],
    ["trailing text", ready(now, {}, "127.0.0.1:4311/x")],
    ["missing expiry", ready(now, { expires_at: undefined })],
    ["malformed expiry", ready(now, { expires_at: "tomorrow" })],
    ["impossible date", ready(now, { expires_at: "2099-02-31T12:00:00Z" })],
    ["invalid leap day", ready(now, { expires_at: "2099-02-29T12:00:00Z" })],
    ["normalized midnight", ready(now, { expires_at: "2099-01-01T24:00:00Z" })],
    ["non-UTC expiry", ready(now, { expires_at: "2099-01-01T00:00:00+01:00" })],
    ["already expired", ready(now, { expires_at: iso(now - 5000) })],
    ["expiry before verification", ready(now, { verified_at: iso(now + 50_000), expires_at: iso(now + 40_000) })],
    ["verified in future", ready(now, { verified_at: iso(now + 600_000), expires_at: iso(now + 900_000) })],
    ["missing enclave", ready(now, { enclave: undefined })],
    ["missing repo", ready(now, { repo: undefined })],
    ["missing project", ready(now, { project: undefined })],
    ["missing digest", ready(now, { release_digest: undefined })],
    ["unknown platform", ready(now, { platform: "none" })],
    ["empty fingerprint", ready(now, { tls_key_fingerprint: "" })],
    ["non-string field", ready(now, { repo: 5 })],
    ["control characters", ready(now, { enclave: "a\u0007b" })],
    ["oversize field", ready(now, { enclave: "x".repeat(600) })],
  ];
  for (const [what, message] of mutations) {
    const f = fixture(serve(message));
    const failure = await code(f.proxy.baseUrl()).catch(() => `${what} accepted`);
    expect(failure, what).toMatch(/^(verification_invalid|attestation_stale)$/);
    expect(f.proxy.verification()).toBeNull();
  }
}, 30_000);

test("handshake rejects oversize output and times out without leaking process text", async () => {
  const noisy = fixture(() => `echo 'provider-secret-from-stderr' >&2\nhead -c 2000000 /dev/zero | tr '\\0' a\necho\nexec sleep 60`);
  expect(await code(noisy.proxy.baseUrl())).toBe("handshake_oversize");
  const silent = fixture(() => `echo 'provider-secret-from-stderr' >&2\nexec sleep 60`, { timeoutMs: 300 });
  const error = await silent.proxy.baseUrl().catch(e => e);
  expect(error.code).toBe("handshake_timeout");
  expect(String(error.message) + String(error.stack)).not.toContain("provider-secret");
});

test("unrelated or garbage lines before ready are skipped; exit before ready fails", async () => {
  const f = fixture(record => `echo 'not json'\n${emit({ event: "verification" })}\n${serve(ready(Date.now()))(record)}`);
  expect(await f.proxy.baseUrl()).toBe("http://127.0.0.1:43111/v1");
  expect(await code(fixture(() => "exit 3").proxy.baseUrl())).toBe("proxy_unavailable");
});

test("expired attestation is never reused: per-call freshness re-verifies with a fresh child", async () => {
  let clock = Date.now();
  const f = fixture(record => serve(ready(clock, { expires_at: iso(clock + 60_000) }))(record), { now: () => clock });
  await f.proxy.baseUrl();
  await f.proxy.baseUrl();
  expect(f.spawns()).toBe(1);
  clock += 61_000;
  expect(f.proxy.verification()).toBeNull();
  // The fixture still prints its original (now stale) summary, so re-verification must fail closed rather than return the old endpoint.
  expect(await code(f.proxy.baseUrl())).toBe("attestation_stale");
  expect(f.spawns()).toBe(2);
});

test("exited child voids the endpoint and is replaced; no cached endpoint survives", async () => {
  const f = fixture(serve(ready(Date.now()), "sleep 0.3"));
  await f.proxy.baseUrl();
  await Bun.sleep(700);
  expect(f.proxy.verification()).toBeNull();
  expect(await f.proxy.baseUrl()).toBe("http://127.0.0.1:43111/v1");
  expect(f.spawns()).toBe(2);
});

test("close voids the endpoint and kills the child; a later call restarts", async () => {
  const f = fixture(serve(ready(Date.now())));
  await f.proxy.baseUrl();
  f.proxy.close();
  expect(f.proxy.verification()).toBeNull();
  await f.proxy.baseUrl();
  expect(f.spawns()).toBe(2);
});

test("close during handshake rejects the pending start and leaves nothing live", async () => {
  const f = fixture(() => "exec sleep 60");
  const pending = f.proxy.baseUrl().catch(e => e);
  await waitFor(() => f.spawns() === 1);
  f.proxy.close();
  expect(((await pending) as TinfoilProxyError).code).toBe("proxy_unavailable");
  expect(f.proxy.verification()).toBeNull();
});

test("concurrent calls share a single verified child", async () => {
  const f = fixture(serve(ready(Date.now())));
  const urls = await Promise.all(Array.from({ length: 10 }, () => f.proxy.baseUrl()));
  expect(new Set(urls).size).toBe(1);
  expect(f.spawns()).toBe(1);
});

test("concurrent calls all fail closed together when verification fails", async () => {
  const f = fixture(serve(ready(Date.now(), { platform: "none" })));
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.proxy.baseUrl()));
  expect(results.every(result => result.status === "rejected")).toBe(true);
  expect(f.spawns()).toBe(1);
});
