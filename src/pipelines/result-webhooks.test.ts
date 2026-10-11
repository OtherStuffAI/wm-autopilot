import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { spawnSync } from "node:child_process";
import { pinnedWebhookTransport, webhookCurlConfig } from "./pinned-webhook-transport";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { createHash } from "node:crypto";
import { PipelineStore } from "./pipeline-store";
import { ResultWebhookService } from "./result-webhook-service";
import { isPublicAddress, validateWebhookUrl, postResultWebhook } from "./result-webhook-http";
import { PublicCallReplay } from "./public-call-store";
import { publicDelivery } from "./public-call-contract";

let directory: string;
let store: PipelineStore;
let at: number;
const secret = generateSecretKey();
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "pipeline-webhook-")); store = new PipelineStore(join(directory, "runs.sqlite")); at = Date.now(); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function createDelivery(url = "https://receiver.example/result", terminal = true) {
  const run = store.publicCalls.create({ owner: "owner", definitionId: "definition", key: "key", fingerprint: "fingerprint", webhookUrl: url },
    () => store.createRun({ definitionId: "definition", name: "run", ownerNpub: "owner", scope: "shared", input: {} }));
  if (terminal) store.completeRun(run.id, "ok", { summary: "done" });
  return run;
}
const publicDns = (async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof lookup;

describe("public result webhooks", () => {
  test("signed retries keep immutable body and stable IDs; persistence survives worker recreation", async () => {
    const run = createDelivery();
    const sent: Array<{ body: string; headers: Record<string, string> }> = [];
    const transport = async (_url: string, body: string, headers: Record<string, string>) => { sent.push({ body, headers }); return sent.length === 1 ? 503 : 204; };
    const worker = new ResultWebhookService(store, getPublicKey(secret), event => finalizeEvent(event, secret), transport, () => at);
    await worker.tick();
    const first = store.publicCalls.getDelivery(run.id)!;
    expect(first).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: 503 });
    expect(first.nextAttemptAt).toBe(at + 1000);
    expect(publicDelivery(first)).not.toHaveProperty("payload");
    await worker.tick(); expect(sent).toHaveLength(1);
    // Even a resumed/mutated terminal run does not alter an existing delivery snapshot.
    store.completeRun(run.id, "error", { changed: true }, "changed");
    at += 1000;
    const recovered = new PipelineStore(store.path);
    const nextWorker = new ResultWebhookService(recovered, getPublicKey(secret), event => finalizeEvent(event, secret), transport, () => at);
    await nextWorker.tick();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toBe(sent[1]!.body);
    expect(recovered.publicCalls.getDelivery(run.id)).toMatchObject({ id: first.id, status: "delivered", attempts: 2 });
    for (const [index, delivery] of sent.entries()) {
      const event = JSON.parse(Buffer.from(delivery.headers.Authorization!.slice(6), "base64").toString());
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(getPublicKey(secret));
      expect(event.tags).toContainEqual(["payload", createHash("sha256").update(delivery.body).digest("hex")]);
      expect(event.tags).toContainEqual(["u", "https://receiver.example/result"]);
      expect(event.tags).toContainEqual(["method", "POST"]);
      expect(event.tags).toContainEqual(["delivery", first.id]);
      expect(event.tags).toContainEqual(["run", run.id]);
      expect(event.tags).toContainEqual(["attempt", String(index + 1)]);
      const payload = JSON.parse(delivery.body);
      expect(payload).toMatchObject({ deliveryId: first.id, runId: run.id, status: "ok", result: { summary: "done" } });
      expect(delivery.headers["X-Wingman-Delivery-Id"]).toBe(first.id);
      expect(delivery.headers["X-Wingman-Run-Id"]).toBe(run.id);
    }
    await nextWorker.tick(); expect(sent).toHaveLength(2);
  });

  test("no delivery before terminal; five failures stop retries while polling result remains", async () => {
    const run = createDelivery(undefined, false);
    let calls = 0;
    const worker = new ResultWebhookService(store, getPublicKey(secret), event => finalizeEvent(event, secret), async () => { calls++; throw new Error("Network deadline exceeded"); }, () => at);
    await worker.tick(); expect(calls).toBe(0);
    store.completeRun(run.id, "needs_input", { question: "Which topic?" }, "Input required");
    for (let attempt = 1; attempt <= 5; attempt++) {
      await worker.tick();
      expect(calls).toBe(attempt);
      const delivery = store.publicCalls.getDelivery(run.id)!;
      expect(delivery.attempts).toBe(attempt);
      if (attempt < 5) expect(delivery.nextAttemptAt - at).toBe(1000 * 2 ** (attempt - 1));
      at = delivery.nextAttemptAt;
    }
    expect(store.publicCalls.getDelivery(run.id)).toMatchObject({ status: "failed", attempts: 5, lastError: "Network deadline exceeded" });
    expect(store.getRun(run.id)).toMatchObject({ status: "needs_input", result: { question: "Which topic?" } });
    at += 100000; await worker.tick(); expect(calls).toBe(5);
  });

  test("crash leases prevent concurrent claims and recover without new run or delivery", async () => {
    const run = createDelivery();
    const delivery = store.publicCalls.getDelivery(run.id)!;
    const claimed = store.publicCalls.claim(delivery.id, at, '{"deliveryId":"immutable"}')!;
    expect(store.publicCalls.claim(delivery.id, at, "different")).toBeNull();
    expect(store.publicCalls.due(at)).toHaveLength(0);
    at += 30_000;
    const reopened = new PipelineStore(store.path);
    const recovered = reopened.publicCalls.claim(delivery.id, at, "different")!;
    expect(recovered).toMatchObject({ id: delivery.id, runId: run.id, payload: claimed.payload, attempts: 2 });
    // A delayed older worker cannot overwrite a newer claim.
    store.publicCalls.finish(claimed, { status: 200, error: null }, at);
    expect(store.publicCalls.getDelivery(run.id)?.status).toBe("delivering");
    reopened.publicCalls.finish(recovered, { status: 200, error: null }, at);
    expect(reopened.publicCalls.getDelivery(run.id)?.status).toBe("delivered");
  });

  test("failed atomic call persistence rolls back the run and delivery", () => {
    expect(() => store.publicCalls.create({ owner: "owner", definitionId: "definition", key: null, fingerprint: "x", webhookUrl: "https://receiver.example" }, () => {
      store.createRun({ definitionId: "definition", name: "run", scope: "user", input: {} });
      throw new Error("Rollback");
    })).toThrow("Rollback");
    expect(store.listRuns()).toHaveLength(0);
  });

  test("separate database clients cannot create another run for a reserved public key", () => {
    const run = createDelivery();
    const second = new PipelineStore(store.path);
    let called = false;
    expect(() => second.publicCalls.create({ owner: "owner", definitionId: "definition", key: "key", fingerprint: "fingerprint", webhookUrl: "https://receiver.example/result" }, () => {
      called = true;
      return second.createRun({ definitionId: "definition", name: "duplicate", scope: "user", input: {} });
    })).toThrow(PublicCallReplay);
    expect(called).toBe(false);
    expect(second.listRuns()).toHaveLength(1);
    expect(second.publicCalls.getDelivery(run.id)?.id).toBe(store.publicCalls.getDelivery(run.id)?.id);
  });

  test("shared compaction cannot mutate another owner's public run steps", () => {
    const run = createDelivery();
    const step = store.createStep({ runId: run.id, stepIndex: 0, name: "Step", kind: "code", input: { private: true } });
    store.completeStep({ id: step.id, status: "ok", result: { private: true } });
    expect(store.compactCompletedRunPayloads({ ownerNpub: "other", includeShared: true }).matchedRuns).toBe(0);
    expect(store.getStep(step.id)?.input).toEqual({ private: true });
    expect(store.compactCompletedRunPayloads({ ownerNpub: "owner", includeShared: true }).matchedRuns).toBe(1);
    expect(store.getRun(run.id)?.result).toEqual({ summary: "done" });
  });

  test("SSRF checks reject private, reserved, mapped, mixed DNS and unsafe URL forms", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.1.1", "192.168.1.2", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.1", "::1", "fe80::1", "fc00::1", "::ffff:8.8.8.8", "2002:0808:0808::", "2001:db8::1"]) expect(isPublicAddress(address)).toBe(false);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(address)).toBe(true);
    for (const url of ["http://receiver.example", "https://user:pass@receiver.example", "https://receiver.example:8443", "https://receiver.example/#fragment", "https://2130706433", "https://[::ffff:127.0.0.1]"]) {
      await expect(validateWebhookUrl(url, publicDns)).rejects.toThrow();
    }
    const mixed = (async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup;
    await expect(validateWebhookUrl("https://receiver.example", mixed)).rejects.toThrow();
    const none = (async () => []) as unknown as typeof lookup;
    await expect(validateWebhookUrl("https://receiver.example", none)).rejects.toThrow();
  });

  test("HTTPS transport pins validated DNS and revalidates before each attempt", async () => {
    let resolutions = 0;
    const resolver = (async () => { resolutions++; return resolutions === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]; }) as unknown as typeof lookup;
    let calls = 0;
    const transport = async (url: URL, address: string) => {
      calls++;
      expect(url.hostname).toBe("receiver.example");
      expect(address).toBe("8.8.8.8");
      return 302;
    };
    expect(await postResultWebhook("https://receiver.example/result", "{}", {}, { resolve: resolver, transport })).toBe(302);
    expect(calls).toBe(1); expect(resolutions).toBe(1);
    await expect(postResultWebhook("https://receiver.example/result", "{}", {}, { resolve: resolver, transport })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("curl config bounds input, rejects header injection and preserves exact JSON", () => {
    const body = JSON.stringify({ text: 'quote " and slash \\ and newline\n', instruction: 'url = "https://evil.example"' });
    const config = webhookCurlConfig(new URL("https://receiver.example/result"), "2606:4700:4700::1111", body, { Authorization: "Nostr fixture" });
    expect(config).toContain('resolve = "receiver.example:443:[2606:4700:4700::1111]"');
    expect(config).toContain('max-time = 10');
    expect(config).toContain('proto = "=https"');
    expect(config).not.toContain("insecure");
    expect(config).not.toContain("location");
    expect(() => webhookCurlConfig(new URL("https://receiver.example"), "8.8.8.8", "x".repeat(1024 * 1024 + 1), {})).toThrow("payload");
    for (const headers of [{ Authorization: "value\r\nurl=evil" }, { Host: "evil.example" }, { "bad\nname": "value" }]) {
      expect(() => webhookCurlConfig(new URL("https://receiver.example"), "8.8.8.8", "{}", headers)).toThrow("header");
    }
  });

  test("real pinned HTTPS verifies signed body, rejects bad TLS and never follows redirects", async () => {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=receiver.test", "-addext", "subjectAltName=DNS:receiver.test"], { stdio: "ignore" });
    expect(generated.status).toBe(0);
    let calls = 0;
    let receivedBody = "";
    let receivedAuth = "";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) }, async fetch(request) {
      calls++;
      receivedBody = await request.text();
      receivedAuth = request.headers.get("authorization") ?? "";
      if (new URL(request.url).pathname === "/stall") return await new Promise<Response>(() => {});
      if (new URL(request.url).pathname === "/large") return new Response("x".repeat(65537));
      return new Response(null, { status: 302, headers: { location: `https://receiver.test:${server.port}/redirected` } });
    } });
    const url = new URL(`https://receiver.test:${server.port}/result`);
    const previousCa = process.env.CURL_CA_BUNDLE;
    try {
      // The test CA is trusted only by this test's curl child, never by the platform.
      process.env.CURL_CA_BUNDLE = cert;
      const body = JSON.stringify({ text: 'quote " slash \\ newline\n', deliveryId: "fixture" });
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [["u", url.href], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")]], content: "" }, secret);
      expect(await pinnedWebhookTransport(url, "127.0.0.1", body, { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` })).toBe(302);
      expect(calls).toBe(1);
      expect(receivedBody).toBe(body);
      const receiptEvent = JSON.parse(Buffer.from(receivedAuth.slice(6), "base64").toString());
      expect(verifyEvent(receiptEvent)).toBe(true);
      expect(receiptEvent.tags).toContainEqual(["payload", createHash("sha256").update(receivedBody).digest("hex")]);
      await expect(pinnedWebhookTransport(new URL(`https://mismatch.test:${server.port}/result`), "127.0.0.1", body, {})).rejects.toThrow("curl exit 60");
      expect(calls).toBe(1);
      delete process.env.CURL_CA_BUNDLE;
      await expect(pinnedWebhookTransport(url, "127.0.0.1", body, {})).rejects.toThrow("curl exit 60");
      expect(calls).toBe(1);
      process.env.CURL_CA_BUNDLE = cert;
      await expect(pinnedWebhookTransport(new URL(`https://receiver.test:${server.port}/large`), "127.0.0.1", body, {})).rejects.toThrow("curl exit 63");
      const started = Date.now();
      await expect(pinnedWebhookTransport(new URL(`https://receiver.test:${server.port}/stall`), "127.0.0.1", body, {})).rejects.toThrow("curl exit 28");
      expect(Date.now() - started).toBeLessThan(11_500);
    } finally {
      if (previousCa === undefined) delete process.env.CURL_CA_BUNDLE;
      else process.env.CURL_CA_BUNDLE = previousCa;
      server.stop(true);
    }
  }, 15_000);
});
