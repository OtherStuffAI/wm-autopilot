import { expect, test } from "bun:test";
import { boundedResponse } from "./bounded-response.ts";
import { RecordSyncClient } from "./record-sync-client.ts";
import { MAX_BYTES } from "./record-sync-protocol.ts";
import {
  fixture,
  change,
  pagePayload,
} from "./record-sync-fixture.test-helper.ts";
import { rmSync } from "node:fs";

function paced(
  bytes: Uint8Array,
  chunk = 65536,
  pause = 1000,
  initialPause = 0,
) {
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(offset === 0 ? initialPause : pause);
      if (cancelled) return;
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream), cancelled: () => cancelled };
}
test("mid-body deadline cancels the reader before parse and oversized bodies are bounded", async () => {
  const stalled = paced(new Uint8Array(2000), 1000, 1000);
  const started = performance.now();
  await expect(
    boundedResponse(
      (async () => stalled.response) as typeof fetch,
      "https://fixture",
      undefined,
      Date.now() + 30,
    ),
  ).rejects.toThrow("deadline");
  expect(performance.now() - started).toBeLessThan(300);
  expect(stalled.cancelled()).toBe(true);
  const big = paced(new Uint8Array(MAX_BYTES + 1), MAX_BYTES + 1, 0);
  await expect(
    boundedResponse(
      (async () => big.response) as typeof fetch,
      "https://fixture",
      undefined,
      Date.now() + 1000,
    ),
  ).rejects.toThrow("1 MiB");
  expect(big.cancelled()).toBe(true);
});
test("cancellation stops paused transfer without parse or retry", async () => {
  const abort = new AbortController();
  const stalled = paced(new Uint8Array(2000), 1000, 1000);
  setTimeout(() => abort.abort(), 20);
  await expect(
    boundedResponse(
      (async () => stalled.response) as typeof fetch,
      "https://fixture",
      { signal: abort.signal },
      Date.now() + 1000,
    ),
  ).rejects.toThrow("cancelled");
  expect(stalled.cancelled()).toBe(true);
});
test("at most two retries with fresh signing and Retry-After defers without enough wake budget", async () => {
  let signs = 0;
  let gets = 0;
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("nip98")) {
      signs++;
      return Response.json({ token: "signed" });
    }
    gets++;
    return Response.json({ error: "busy" }, { status: 503 });
  }) as typeof fetch;
  const client = new RecordSyncClient(
    {
      wingmanUrl: "https://broker",
      sessionId: crypto.randomUUID(),
      capabilityToken: "cap",
      fetch: impl,
    },
    Date.now() + 120000,
    false,
    "app",
    30000,
    undefined,
    () => 0,
  );
  await expect(
    client.request("https://tower/test", "GET", undefined, "page"),
  ).rejects.toThrow("503");
  expect(signs).toBe(3);
  expect(gets).toBe(3);
  gets = 0;
  signs = 0;
  const limited = new RecordSyncClient(
    {
      wingmanUrl: "https://broker",
      sessionId: crypto.randomUUID(),
      capabilityToken: "cap",
      fetch: (async (input) =>
        String(input).includes("nip98")
          ? Response.json({ token: "signed" })
          : Response.json(
              { error: "rate_limit" },
              { status: 429, headers: { "retry-after": "90" } },
            )) as typeof fetch,
    },
    Date.now() + 45000,
    false,
    "app",
  );
  await expect(
    limited.request("https://tower/test", "GET", undefined, "page"),
  ).rejects.toThrow("deferred");
  expect(limited.timings).toHaveLength(0);
});
test("healthy full-page pipeline fixture p95 and 64 KiB/s with a pause stay within targets", async () => {
  // Entire JSON response, including all metadata, is exactly the 1 MiB ceiling.
  const template = pagePayload([
    change("full", "task", "9007199254740993", { body: "" }),
  ]);
  const length = Buffer.byteLength(
    JSON.stringify({
      ...template,
      client_id: "00000000-0000-4000-8000-000000000000",
      next_cursor: "opaque-1",
    }),
  );
  template.changes = (template.changes as any[]).map((c) => ({
    ...c,
    row: { ...c.row, body: "x".repeat(MAX_BYTES - length) },
  }));
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const f = fixture([template, pagePayload([], true)]);
    try {
      const r = await f.run();
      expect(r.complete).toBe(true);
      samples.push(r.timings.pages[0]!.totalMs);
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  }
  const p95 = samples.sort((a, b) => a - b)[
    Math.ceil(samples.length * 0.95) - 1
  ]!;
  expect(p95).toBeLessThan(10000);
  for (const selectedTransport of ["https", "fips"] as const) {
    const f = fixture([template, pagePayload([], true)]);
    f.setBound(selectedTransport === "fips");
    const delegate = f.context.fetch!;
    let slow = false;
    const transport = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const response = await delegate(input, init);
      const directPage = new URL(String(input)).pathname.endsWith(
        "/record-sync",
      );
      const command = String(init?.body ?? "").startsWith("{")
        ? JSON.parse(String(init?.body))
        : {};
      const brokerPage =
        command.action === "record_sync_request" &&
        new URL(command.url).pathname.endsWith("/record-sync");
      if ((directPage || brokerPage) && !slow) {
        slow = true;
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.length).toBe(MAX_BYTES);
        return paced(bytes, 65536, 1000, 1000).response;
      }
      return response;
    }) as typeof fetch;
    try {
      const r = await f.run({ fetchImpl: transport });
      expect(r.complete).toBe(true);
      const elapsed = r.timings.pages[0]!.totalMs;
      expect(elapsed).toBeLessThan(25000);
      console.info(
        JSON.stringify({
          fixture:
            "local-memory HTTPS transport + real SQLite, 1 MiB, 64KiB/s + 1s initial pause",
          healthyP95Ms: p95,
          slowPipelineMs: elapsed,
          selectedTransport,
          productionMeasured: false,
        }),
      );
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  }
}, 60000);
test("mid-body heartbeat failure keeps bootstrap position without rows or ack", async () => {
  const f = fixture([]);
  const original = f.context.fetch!;
  let requests = 0;
  const failed = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/record-sync")) {
      requests++;
      return paced(new TextEncoder().encode('{"changes":['), 5, 1000).response;
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const result = await f.run({ fetchImpl: failed, requestTimeoutMs: 30 });
    expect(result.complete).toBe(false);
    expect(result.coverage.downloadedCounts).toEqual({});
    expect(result.cache.pendingAck).toBe(false);
    expect(requests).toBe(3);
    expect(f.calls.some((c) => c.url.pathname.endsWith("/ack"))).toBe(false);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});
test("cancellation before headers settles even if a transport ignores its abort signal", async () => {
  const controller = new AbortController();
  const started = performance.now();
  setTimeout(() => controller.abort(), 20);
  await expect(boundedResponse((async () => new Promise<Response>(() => {})) as typeof fetch, "https://fixture", { signal: controller.signal }, Date.now() + 30000)).rejects.toThrow("cancelled");
  expect(performance.now() - started).toBeLessThan(300);
});
