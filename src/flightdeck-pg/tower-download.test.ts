import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FlightDeckPgClient } from "./client";

test("brokered document attachments prepare the content route and never fetch a presigned public URL", async () => {
  const objectId = "22222222-2222-4222-8222-222222222222";
  const docId = "11111111-1111-4111-8111-111111111111";
  const prepared: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "fips-download-"));
  const client = new FlightDeckPgClient({ towerUrl: "https://tower.example", wingmanUrl: "", appNpub: "app",
    fetchImpl: (() => { throw new Error("Public fetch forbidden"); }) as unknown as typeof fetch,
    botIdentity: { botNpub: "bot", botPubkeyHex: "pubkey", signNip98: async () => "Nostr test",
      signNostrEvent: async () => { throw new Error("Unexpected event signing"); },
      towerTransport: {
        prepare: async (input) => {
          const url = new URL(input); prepared.push(url.pathname);
          if (!url.pathname.startsWith("/api/v4/")) throw new Error("Root origin is not a permitted request route");
          url.protocol = "http:"; url.host = "node.fips:43100"; return url.href;
        },
        fetch: async (input) => {
          const path = new URL(input).pathname;
          if (path.endsWith(`/docs/${docId}`)) return Response.json({ doc: { id: docId, title: "Document", row_version: 1 } });
          if (path.endsWith(`/docs/${docId}/body`)) return Response.json({ body: { encoding: "base64", base64_data: Buffer.from(`storage://${objectId}`).toString("base64") } });
          if (path === `/api/v4/storage/${objectId}`) return Response.json({ download_url: "https://storage.invalid/private", content_type: "text/plain" });
          if (path === `/api/v4/storage/${objectId}/content`) return new Response("attachment");
          throw new Error(`Unexpected route ${path}`);
        },
      },
    },
  });
  try {
    const result = await client.downloadDoc("workspace", docId, join(directory, "doc.md"), { includeComments: false });
    expect(result.storageDownloads).toHaveLength(1);
    expect(prepared).toContain(`/api/v4/storage/${objectId}/content`);
    expect(prepared).not.toContain("/");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
