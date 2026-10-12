import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { permitsRecordSyncTransport } from "./record-sync-transport-policy.ts";
import { handleFlightDeckTransport } from "./flightdeck-transport-helper.ts";
import { MAX_BYTES } from "../heartbeat/record-sync-protocol.ts";

const base = "/api/v4/flightdeck-pg/workspaces/workspace/record-sync";
const client = "10000000-0000-4000-8000-000000000001";
test("bounded broker allows only exact discovery and v2 register/page/checkpoint/ack routes", () => {
  for (const [path, method] of [
    ["/api/v4/flightdeck-pg/service", "GET"],
    [`${base}?protocol_version=2`, "GET"],
    [`${base}/clients/${client}?protocol_version=2`, "GET"],
    [`${base}/clients/${client}?protocol_version=2`, "POST"],
    [`${base}/clients/${client}/ack?protocol_version=2`, "POST"],
  ])
    expect(
      permitsRecordSyncTransport(
        new URL(path!, "https://tower"),
        method!,
        "workspace",
      ),
    ).toBe(true);
  for (const [path, method] of [
    ["/api/v4/flightdeck-pg/service/extra", "GET"],
    ["/api/v4/flightdeck-pg/service", "POST"],
    [`${base}?protocol_version=1`, "GET"],
    [`${base}/clients/${client}/ack?protocol_version=2`, "GET"],
    [`${base}/clients/${client}?protocol_version=2`, "DELETE"],
    [`${base}/anything?protocol_version=2`, "POST"],
    [
      "/api/v4/flightdeck-pg/workspaces/other/record-sync?protocol_version=2",
      "GET",
    ],
  ])
    expect(
      permitsRecordSyncTransport(
        new URL(path!, "https://tower"),
        method!,
        "workspace",
      ),
    ).toBe(false);
});
test("raw bounded broker enforces signer, exact selected FIPS target and empty-body hash; no public fallback", async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const logical = `https://tower.test${base}/clients/${client}?protocol_version=2`;
  const selected = logical.replace(
    "https://tower.test",
    "http://node.fips:43100",
  );
  let fetched = 0;
  const deps = {
    prepare: async () => selected,
    fetch: async (input: string | URL, init: RequestInit) => {
      fetched++;
      expect(input.toString()).toBe(logical);
      expect(init.body).toEqual(Buffer.alloc(0));
      return Response.json({ protocol_version: 2 });
    },
  };
  const event = (hash: boolean, target = selected) =>
    finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", target],
          ["method", "POST"],
          ...(hash
            ? [["payload", createHash("sha256").update("").digest("hex")]]
            : []),
        ],
      },
      key,
    );
  const input = (hash: boolean, target?: string) => ({
    action: "record_sync_request",
    subscriptionId: "subscription",
    workspaceId: "workspace",
    botPubkeyHex: pubkey,
    appNpub: "app",
    body: {
      url: logical,
      method: "POST",
      bodyBase64: "",
      headers: [
        [
          "authorization",
          `Nostr ${Buffer.from(JSON.stringify(event(hash, target))).toString("base64")}`,
        ],
        ["x-flightdeck-pg-app-npub", "app"],
      ],
    },
  });
  expect((await handleFlightDeckTransport(input(false), deps)).status).toBe(
    403,
  );
  expect(fetched).toBe(0);
  expect(
    (await handleFlightDeckTransport(input(true, logical), deps)).status,
  ).toBe(403);
  expect(fetched).toBe(0);
  const response = await handleFlightDeckTransport(input(true), deps);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ protocol_version: 2 });
  expect(fetched).toBe(1);
});
test("raw host reader rejects decoded oversized bodies and cancels source", async () => {
  const key = generateSecretKey();
  const url = `https://tower.test${base}?protocol_version=2`;
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    },
    key,
  );
  let cancelled = false;
  const response = await handleFlightDeckTransport(
    {
      action: "record_sync_request",
      subscriptionId: "subscription",
      workspaceId: "workspace",
      botPubkeyHex: getPublicKey(key),
      appNpub: "app",
      body: {
        url,
        method: "GET",
        headers: [
          [
            "authorization",
            `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
          ],
          ["x-flightdeck-pg-app-npub", "app"],
        ],
      },
    },
    {
      prepare: async () => url,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(MAX_BYTES + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    },
  );
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(await response.json()).toEqual({ error: "record_response_too_large" });
});
