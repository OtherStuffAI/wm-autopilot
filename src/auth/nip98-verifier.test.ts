import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import {
  canonicalNip98RequestUrl,
  Nip98ReplayCache,
  NIP98_CLOCK_SKEW_SECONDS,
  NIP98_MAX_AGE_SECONDS,
  verifyNip98Request,
} from "./nip98-verifier";

const secret = generateSecretKey();
const now = 2_000_000_000;
const tempDirectories: string[] = [];

function replayCache(limit = 10_000, filePath?: string): Nip98ReplayCache {
  const directory = mkdtempSync(join(tmpdir(), "nip98-replay-"));
  tempDirectories.push(directory);
  return new Nip98ReplayCache(limit, filePath ?? join(directory, "wingman.db"));
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function signedRequest(input: {
  actualUrl?: string;
  signedUrl?: string;
  method?: string;
  body?: string;
  signedBody?: string;
  createdAt?: number;
  extraTags?: string[][];
  headers?: Record<string, string>;
}) {
  const actualUrl = input.actualUrl ?? "https://autopilot.example/api/items?owner=alice";
  const method = input.method ?? "GET";
  const tags = [["u", input.signedUrl ?? actualUrl], ["method", method], ...(input.extraTags ?? [])];
  if (input.signedBody !== undefined) {
    tags.push(["payload", bytesToHex(sha256(new TextEncoder().encode(input.signedBody)))]);
  }
  const event = finalizeEvent({ kind: 27235, created_at: input.createdAt ?? now, content: "", tags }, secret);
  const request = new Request(actualUrl, {
    method,
    body: input.body,
    headers: {
      authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
      ...(input.headers ?? {}),
    },
  });
  return { event, request, requestUrl: new URL(actualUrl) };
}

async function verify(input: ReturnType<typeof signedRequest>, cache = replayCache()) {
  return await verifyNip98Request({ ...input, configuredBaseUrl: "https://autopilot.example", replayCache: cache, now });
}

describe("NIP-98 request verification", () => {
  test("binds the exact canonical URL including query", async () => {
    expect(await verify(signedRequest({}))).not.toBeNull();
    expect(await verify(signedRequest({ signedUrl: "https://autopilot.example/api/items?owner=bob" }))).toBeNull();
  });

  test("requires an exact payload hash for body bytes", async () => {
    expect(await verify(signedRequest({ method: "POST", body: '{"ok":true}', signedBody: '{"ok":true}' }))).not.toBeNull();
    expect(await verify(signedRequest({ method: "POST", body: '{"ok":false}' }))).toBeNull();
    expect(await verify(signedRequest({ method: "POST", body: '{"ok":false}', signedBody: '{"ok":true}' }))).toBeNull();
  });

  test("rejects payload tags on bodyless requests", async () => {
    expect(await verify(signedRequest({ signedBody: "" }))).toBeNull();
  });

  test("rejects replay until the event validity expires", async () => {
    const cache = replayCache();
    const input = signedRequest({});
    expect(await verify(input, cache)).not.toBeNull();
    expect(await verify(input, cache)).toBeNull();
    cache.cleanup(now + NIP98_MAX_AGE_SECONDS + NIP98_CLOCK_SKEW_SECONDS + 1);
    expect(cache.size).toBe(0);
  });

  test("enforces age with a small explicit future-skew allowance", async () => {
    expect(await verify(signedRequest({ createdAt: now - NIP98_MAX_AGE_SECONDS }))).not.toBeNull();
    expect(await verify(signedRequest({ createdAt: now - NIP98_MAX_AGE_SECONDS - 1 }))).toBeNull();
    expect(await verify(signedRequest({ createdAt: now + NIP98_CLOCK_SKEW_SECONDS }))).not.toBeNull();
    expect(await verify(signedRequest({ createdAt: now + NIP98_CLOCK_SKEW_SECONDS + 1 }))).toBeNull();
  });

  test("uses only configured proxy origin and ignores arbitrary forwarded authority", async () => {
    const input = signedRequest({
      actualUrl: "http://127.0.0.1:3600/api/items?q=1",
      signedUrl: "https://autopilot.example/api/items?q=1",
      headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
    });
    expect(canonicalNip98RequestUrl(input.requestUrl, "https://autopilot.example/base")).toBe("https://autopilot.example/api/items?q=1");
    expect(await verify(input)).not.toBeNull();
    expect(await verify(signedRequest({
      actualUrl: "http://127.0.0.1:3600/api/items?q=1",
      signedUrl: "http://attacker.example/api/items?q=1",
      headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
    }))).toBeNull();
  });

  test("keeps accepted IDs protected and fails closed at capacity", () => {
    const cache = replayCache(2);
    expect(cache.accept("victim", now + 20, now)).toBe(true);
    expect(cache.accept("a", now + 10, now)).toBe(true);
    expect(cache.accept("b", now + 30, now)).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.accept("victim", now + 40, now)).toBe(false);
  });

  test("reclaims expired entries before enforcing capacity", () => {
    const cache = replayCache(2);
    expect(cache.accept("a", now + 1, now)).toBe(true);
    expect(cache.accept("b", now + 20, now)).toBe(true);
    expect(cache.accept("c", now + 30, now + 1)).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.accept("a", now + 40, now + 1)).toBe(false);
  });

  test("shares atomic exactly-once admission across workers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nip98-replay-shared-"));
    tempDirectories.push(directory);
    const filePath = join(directory, "wingman.db");
    const workers = Array.from({ length: 8 }, () => new Nip98ReplayCache(10, filePath));

    const results = await Promise.all(workers.map(async (cache) => cache.accept("same-event", now + 20, now)));

    expect(results.filter(Boolean)).toHaveLength(1);
    for (const worker of workers) worker.close();
  });

  test("rejects an unexpired event after reconstruction", () => {
    const directory = mkdtempSync(join(tmpdir(), "nip98-replay-restart-"));
    tempDirectories.push(directory);
    const filePath = join(directory, "wingman.db");
    const beforeRestart = new Nip98ReplayCache(2, filePath);
    expect(beforeRestart.accept("event", now + 20, now)).toBe(true);
    beforeRestart.close();

    const afterRestart = new Nip98ReplayCache(2, filePath);
    expect(afterRestart.accept("event", now + 20, now)).toBe(false);
    afterRestart.close();
  });
});
