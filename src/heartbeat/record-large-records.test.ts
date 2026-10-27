import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { fixture, change, pagePayload } from "./record-sync-fixture.test-helper.ts";
import { CHUNK_BYTES } from "./record-large-records.ts";

function largeFixture(withPrior = false, wrongIdentity = false) {
  const canonical = change("large", "message", "1", { body: "文🙂".repeat(200_000) });
  const bytes = Buffer.from(JSON.stringify({ change: wrongIdentity ? { ...canonical, id: "foreign" } : canonical, actors: [] }));
  const manifest = { manifest_id: "20000000-0000-4000-8000-000000000001", family: "message", id: "large", version: "1",
    sha256: createHash("sha256").update(bytes).digest("hex"), total_bytes: bytes.length,
    chunk_bytes: CHUNK_BYTES, chunk_count: Math.ceil(bytes.length / CHUNK_BYTES) };
  const manifestPage = withPrior ? pagePayload([], true, { large_records: [manifest], has_more: true,
    handover: { target_position: "9007199254740993", through_position: "0", complete: false, authority_epoch: "epoch", access_revision: "1" } })
    : pagePayload([], false, { large_records: [manifest] });
  const f = fixture([...(withPrior ? [pagePayload([change("large", "message", "0", { body: "prior" })])] : []), manifestPage, pagePayload([], true)]);
  const chunks: number[] = [];
  let failIndex = -1;
  let corrupt = false;
  let pauseIndex = -1;
  let invalidAck = false;
  let accessDenied = false;
  let dropAcceptedAck = false;
  let serverAccepted = false;
  let failAck = false;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mcp/wingman/flightdeck") {
      const command = JSON.parse(String(init?.body));
      if (["transport_request", "record_sync_request"].includes(command.action)) {
        const response = await fetchImpl(command.url, { method: command.method, headers: command.headers,
          ...(command.bodyBase64 === null ? {} : { body: Buffer.from(command.bodyBase64, "base64").toString() }) });
        if (command.action === "record_sync_request") return response;
        return Response.json({ status: response.status, headers: [...response.headers], bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64") });
      }
    }
    if (url.pathname.includes("/chunks/")) {
      const i = Number(url.pathname.split("/").at(-1)); chunks.push(i);
      if (i === pauseIndex) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "120" } });
      if (i === failIndex) return Response.json({ error: "large_record_changed" }, { status: 409 });
      const data = Buffer.from(bytes.subarray(i * CHUNK_BYTES, Math.min(bytes.length, (i + 1) * CHUNK_BYTES)));
      if (corrupt && i === 1) data[0] = data[0]! ^ 1;
      return new Response(data, { headers: { "content-type": "application/octet-stream" } });
    }
    if (url.pathname.endsWith("/ack")) {
      const body = JSON.parse(String(init?.body));
      if (body.large_record_receipts) {
        expect(body.large_record_receipts).toEqual([{ manifest_id: manifest.manifest_id, sha256: manifest.sha256 }]);
        if (accessDenied && !serverAccepted) return Response.json({ error: "record_access_required" }, { status: 403 });
        if (invalidAck && !serverAccepted) return Response.json({ error: "large_record_changed" }, { status: 409 });
        if (failAck) return Response.json({ error: "unavailable" }, { status: 503 });
      }
    }
    const response = await f.context.fetch(input, init);
    if (url.pathname.endsWith("/ack") && JSON.parse(String(init?.body)).large_record_receipts && response.ok) {
      serverAccepted = true;
      if (dropAcceptedAck) return Response.json({ error: "unavailable" }, { status: 503 });
    }
    if (url.pathname.endsWith("/service")) {
      const value = await response.json(); value.record_sync.extensions.push("chunked_v1");
      return Response.json(value);
    }
    if (url.pathname.endsWith("/record-sync") && response.ok) {
      const value = await response.json();
      return Response.json({ ...value, large_records: value.large_records ?? [] });
    }
    return response;
  }) as typeof fetch;
  return { ...f, bytes, manifest, chunks, fetchImpl,
    failAt(i: number) { failIndex = i; }, pauseAt(i: number) { pauseIndex = i; }, corrupt(value = true) { corrupt = value; },
    invalidAck() { invalidAck = true; }, denyAccess() { accessDenied = true; }, dropAcceptedAck(value: boolean) { dropAcceptedAck = value; }, failAck(value: boolean) { failAck = value; },
    run: (options = {}) => f.run({ fetchImpl, ...options }),
  };
}

test("chunked UTF-8 envelope above 1 MiB verifies, commits and acknowledges exact durable receipts", async () => {
  const f = largeFixture();
  try {
    const result = await f.run();
    expect(result.errors).toEqual([]);
    expect(result.syncComplete).toBe(true);
    expect(result.coverage.downloadedCounts.message).toBe(1);
    expect(f.chunks).toEqual(Array.from({ length: f.manifest.chunk_count }, (_, i) => i));
    const db = new Database(result.cache.path, { readonly: true });
    const row = db.query("SELECT payload FROM rows WHERE family='message'").get() as { payload: string };
    expect(JSON.parse(row.payload).body).toBe("文🙂".repeat(200_000));
    expect((db.query("SELECT count(*) n FROM large_record_chunks").get() as { n: number }).n).toBe(0);
    db.close();
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("hash corruption never materializes or acknowledges a manifest", async () => {
  const f = largeFixture(); f.corrupt();
  try {
    const result = await f.run();
    expect(result.syncComplete).toBe(false);
    expect(result.errors.some(e => e.includes("digest/length"))).toBe(true);
    expect(result.coverage.downloadedCounts.message).toBeUndefined();
    expect(f.calls.some(c => c.url.pathname.endsWith("/ack"))).toBe(false);
    f.corrupt(false); f.rewindPages();
    const repaired = await f.run();
    expect(repaired.syncComplete).toBe(true);
    expect(repaired.cache.clientId).toBe(result.cache.clientId);
    const db = new Database(result.cache.path, { readonly: true });
    expect((db.query("SELECT count(*) n FROM rejected_record_downloads").get() as { n: number }).n).toBeGreaterThan(0);
    db.close();
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("source change during chunks discards staged assembly without advancing committed cursor", async () => {
  const f = largeFixture(); f.failAt(1);
  try {
    const result = await f.run();
    expect(result.errors.some(e => e.includes("large_record_changed"))).toBe(true);
    expect(result.cache.pendingAck).toBe(false);
    expect(result.coverage.downloadedCounts.message).toBeUndefined();
    const db = new Database(result.cache.path, { readonly: true });
    expect((db.query("SELECT count(*) n FROM large_record_stage").get() as { n: number }).n).toBe(0);
    db.close();
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("lost ack response preserves receipts across cache reopen before dependent paging", async () => {
  const f = largeFixture(); f.failAck(true);
  try {
    const first = await f.run();
    expect(first.cache.pendingAck).toBe(true);
    expect(first.syncComplete).toBe(false);
    const chunkCount = f.chunks.length;
    f.failAck(false);
    const second = await f.run();
    expect(second.syncComplete).toBe(true);
    expect(second.cache.clientId).toBe(first.cache.clientId);
    expect(f.chunks.length).toBe(chunkCount);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("source invalidation at first ack atomically restores prior canonical state and cursor", async () => {
  const f = largeFixture(); f.invalidAck();
  try {
    const result = await f.run();
    expect(result.syncComplete).toBe(false);
    expect(result.cache.pendingAck).toBe(false);
    expect(result.coverage.downloadedCounts.message).toBeUndefined();
    const db = new Database(result.cache.path, { readonly: true });
    const saved = JSON.parse((db.query("SELECT state FROM meta").get() as { state: string }).state);
    expect((db.query("SELECT count(*) n FROM rejected_record_downloads").get() as { n: number }).n).toBeGreaterThan(0);
    expect(saved.cursor).toBe("bootstrap"); expect(saved.snapshotDone).toBe(false);
    db.close();
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});


test("rate-limited chunk resumes the same manifest after reopen without refetching durable chunks", async () => {
  const f = largeFixture(); f.pauseAt(1);
  try {
    const before = await f.run();
    expect(before.syncOutcome).toBe("retry");
    expect(before.retryAfterMs).toBe(120_000);
    expect(before.coverage.downloadedChunks).toBe(1);
    expect(before.cache.pendingAck).toBe(false);
    expect(before.coverage.downloadedCounts.message).toBeUndefined();
    const calls = f.calls.filter(c => c.url.pathname.endsWith("/record-sync")).length;
    f.pauseAt(-1);
    const after = await f.run();
    expect(after.syncComplete).toBe(true);
    expect(after.cache.clientId).toBe(before.cache.clientId);
    expect(f.chunks.filter(i => i === 0).length).toBe(1);
    expect(f.calls.filter(c => c.url.pathname.endsWith("/record-sync")).length).toBe(calls + 1);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});


test("explicit host-finite chunk path keeps selected FIPS transport and exact receipt signing", async () => {
  const f = largeFixture(); f.setBound(true); f.setUuidCursors(true);
  try {
    const result = await f.run({ largeRecordTransport: "host-finite" });
    expect(result.errors).toEqual([]);
    expect(result.syncComplete).toBe(true);
    const chunks = f.signs.filter(s => String(s.url).includes("/chunks/"));
    expect(chunks.length).toBe(f.manifest.chunk_count);
    expect(chunks.every(s => String(s.url).startsWith("http://node.fips:43100/"))).toBe(true);
    expect(result.timings.transfers.some(t => t.operation === "large-ack" && t.selectedTransport === "fips")).toBe(true);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});


test("rejected large replacement restores old row and archives the downloaded replacement", async () => {
  const f = largeFixture(true); f.invalidAck();
  try {
    const result = await f.run();
    const db = new Database(result.cache.path, { readonly: true });
    const row = db.query("SELECT payload FROM rows WHERE family='message' AND id='large'").get() as { payload: string };
    expect(JSON.parse(row.payload).body).toBe("prior");
    const archived = db.query("SELECT payload FROM rejected_record_downloads WHERE kind='rows'").get() as { payload: Uint8Array };
    const saved = JSON.parse(new TextDecoder().decode(archived.payload));
    expect(JSON.parse(saved.payload).body).toBe("文🙂".repeat(200_000));
    expect(result.syncComplete).toBe(false); db.close();
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("a valid digest cannot substitute another canonical identity", async () => {
  const f = largeFixture(false, true);
  try {
    const result = await f.run();
    expect(result.errors.some(e => e.includes("envelope identity"))).toBe(true);
    expect(result.cache.pendingAck).toBe(false);
    expect(result.coverage.downloadedCounts.message).toBeUndefined();
    expect(f.calls.some(c => c.url.pathname.endsWith("/ack"))).toBe(false);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});


test("a server-accepted ack with lost responses replays receipts after source/access change without rollback", async () => {
  const f = largeFixture(); f.dropAcceptedAck(true);
  try {
    const first = await f.run();
    expect(first.cache.pendingAck).toBe(true);
    f.dropAcceptedAck(false); f.invalidAck(); f.denyAccess();
    const next = await f.run();
    expect(next.errors).toEqual([]);
    expect(next.syncComplete).toBe(true);
    expect(next.cache.pendingAck).toBe(false);
    expect(next.coverage.downloadedCounts.message).toBe(1);
    const db = new Database(next.cache.path, { readonly: true });
    expect((db.query("SELECT count(*) n FROM rejected_record_downloads").get() as { n: number }).n).toBe(0);
    db.close();
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("revoked access at first ack quarantines the downloaded envelope and restores the prior checkpoint", async () => {
  const f = largeFixture(); f.denyAccess();
  try {
    const result = await f.run();
    expect(result.errors.some(e => e.includes("record_access_required"))).toBe(true);
    expect(result.syncComplete).toBe(false);
    expect(result.cache.pendingAck).toBe(false);
    expect(result.coverage.downloadedCounts.message).toBeUndefined();
    expect(result.workspaces[0]!.review).toEqual([]);
    const db = new Database(result.cache.path, { readonly: true });
    expect((db.query("SELECT count(*) n FROM rejected_record_downloads WHERE kind='rows'").get() as { n: number }).n).toBe(1);
    expect(JSON.parse((db.query("SELECT state FROM meta").get() as {state:string}).state).cursor).toBe("bootstrap");
    db.close();
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});
