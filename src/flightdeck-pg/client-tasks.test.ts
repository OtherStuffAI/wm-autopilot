import { expect, test } from "bun:test";
import { generateSecretKey } from "nostr-tools";
import { createBotIdentityFromSecret, FlightDeckPgClient } from "./client.ts";

test("task cursor is passed verbatim to channel route and included in exact URL signature", async () => {
  const requests: Request[] = [];
  const client = new FlightDeckPgClient({ towerUrl: "https://tower.test", wingmanUrl: "", appNpub: "app",
    botIdentity: createBotIdentityFromSecret(generateSecretKey()), fetchImpl: (async (input, init) => {
      requests.push(new Request(input, init)); return Response.json({ tasks: [], next_cursor: null, has_more: false });
    }) as typeof fetch });
  const cursor = "opaque+/= microsecond-tie";
  await client.listTasks("w", { channelId: "c", limit: 2, cursor });
  const url = new URL(requests[0]!.url);
  expect(url.searchParams.get("cursor")).toBe(cursor);
  expect(url.searchParams.get("limit")).toBe("2");
  const event = JSON.parse(Buffer.from(requests[0]!.headers.get("authorization")!.slice(6), "base64").toString());
  expect(event.tags).toContainEqual(["u", url.toString()]);
  await expect(client.listTasks("w", { scopeId: "s", cursor })).rejects.toThrow("does not support cursor");
  expect(requests.length).toBe(1);
});
