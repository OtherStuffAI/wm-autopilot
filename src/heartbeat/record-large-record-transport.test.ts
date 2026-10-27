import { expect, test } from "bun:test";
import { finiteLargeRecordResponse } from "./record-large-record-transport.ts";
import { RecordSyncClient } from "./record-sync-client.ts";

const id = "10000000-0000-4000-8000-000000000001";
const base = `https://tower.test/api/v4/flightdeck-pg/workspaces/workspace/record-sync/clients/${id}`;
const chunk = `${base}/pages/${id}/large-records/${id}/chunks/0?protocol_version=2`;

test("finite chunk transport rejects invalid path/method/body before broker access and enforces raw/base64 ceilings", async () => {
  let calls = 0;
  let payload = Buffer.alloc(262_144).toString("base64");
  const client = { broker: async () => { calls++; return { status: 200, headers: [], bodyBase64: payload }; } } as unknown as RecordSyncClient;
  for (const [url, method, body] of [
    [chunk.replace("/chunks/0", "/chunks/-1"), "GET", undefined],
    [chunk, "POST", "{}"],
    [chunk, "GET", "{}"],
    [`${base}/ack?protocol_version=2`, "POST", JSON.stringify({ cursor: id, expected_revision: "1", extra: true })],
  ] as const) await expect(finiteLargeRecordResponse(client, url, method, {}, body)).rejects.toThrow("Invalid explicit");
  expect(calls).toBe(0);
  expect((await finiteLargeRecordResponse(client, chunk, "GET", {}, undefined)).status).toBe(200);
  payload = Buffer.alloc(262_145).toString("base64");
  await expect(finiteLargeRecordResponse(client, chunk, "GET", {}, undefined)).rejects.toThrow("wire bound");
  payload = "A".repeat(1_000_000);
  await expect(finiteLargeRecordResponse(client, chunk, "GET", {}, undefined)).rejects.toThrow("wire bound");
});

test("an explicit finite-host denial never falls back to bounded or direct transport", async () => {
  const actions: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body));
    if (url.pathname.endsWith("/nip98")) return Response.json({ token: "Nostr fixture" });
    actions.push(body.action);
    if (body.action === "transport_prepare") {
      expect(body.recordSync).toBe(false);
      return Response.json({ url: chunk });
    }
    if (body.action === "transport_request") return Response.json({ error: "explicitly denied" }, { status: 403 });
    throw new Error("Unexpected fallback request");
  }) as typeof fetch;
  const client = new RecordSyncClient({ wingmanUrl: "https://broker.test", sessionId: crypto.randomUUID(), capabilityToken: "fixture", fetch: fetchImpl },
    Date.now() + 120_000, true, "app", 30_000, undefined, () => 0, "host-finite");
  await expect(client.chunk(chunk)).rejects.toThrow("explicitly denied");
  expect(actions).toEqual(["transport_prepare", "transport_request"]);
});
