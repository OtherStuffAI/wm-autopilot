import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { privateReportRequest } from "./flightdeck-private-request";
import { requirePrivateReportContext } from "../../src/flightdeck-pg/private-report";

test("private message transport signs kind33358 then the full NIP98 payload and refuses redirects", async () => {
  const botPubkeyHex = getPublicKey(generateSecretKey()); const botNpub = nip19.npubEncode(botPubkeyHex);
  const workspace = crypto.randomUUID(); const sessionId = crypto.randomUUID();
  const context = requirePrivateReportContext({ workspace: { workspaceId: workspace, backendBaseUrl: "https://tower.test", sourceAppNpub: "app" }, bot: { npub: botNpub, available: true } });
  const savedEnv = { SESSION_ID: Bun.env.SESSION_ID, WINGMAN_BROKER_URL: Bun.env.WINGMAN_BROKER_URL, WINGMAN_CAPABILITY: Bun.env.WINGMAN_CAPABILITY };
  Object.assign(Bun.env, { SESSION_ID: sessionId, WINGMAN_BROKER_URL: "http://broker.test", WINGMAN_CAPABILITY: "test-capability" });
  const fetchBefore = globalThis.fetch; const calls: { url: string; init: RequestInit; body: any }[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, init: init ?? {}, body });
    if (url.endsWith("/nostr-event")) return Response.json({ event: { ...body.event, pubkey: botPubkeyHex } });
    if (url.endsWith("/nip98")) return Response.json({ token: "Nostr test-token", signedBy: botNpub });
    return Response.json({ message: { id: "saved" } });
  }) as typeof fetch;
  try {
    const request = privateReportRequest(context);
    await request("POST", `/api/v4/flightdeck-pg/workspaces/${workspace}/channels/channel/messages`, {
      body: "Private report", create_thread: true, client_request_id: "daily-bot-parent-date",
    });
    expect(calls[0]!.body.event).toMatchObject({ kind: 33358, content: "Private report" });
    expect(calls[0]!.body.event.tags).toContainEqual(["workspace_id", workspace]);
    expect(calls[0]!.body.event.tags).toContainEqual(["channel_id", "channel"]);
    expect(calls[1]!.body).toMatchObject({ method: "POST", url: `https://tower.test/api/v4/flightdeck-pg/workspaces/${workspace}/channels/channel/messages` });
    expect(calls[1]!.body.bodyHash).toBeDefined();
    expect(calls[2]!.body).toMatchObject({ body: "Private report", create_thread: true, client_request_id: "daily-bot-parent-date", message_signature: { kind: 33358, signer_npub: botNpub } });
    expect(calls[1]!.body.bodyHash).toBe(createHash("sha256").update(JSON.stringify(calls[2]!.body)).digest("hex"));
    expect(calls[2]!.init.redirect).toBe("error");
    expect(new Headers(calls[2]!.init.headers).get("x-flightdeck-pg-app-npub")).toBe("app");
    await expect(request("GET", "/api/v4/flightdeck-pg/workspaces/foreign/scopes")).rejects.toThrow("exact bound workspace");
    await expect(request("GET", `https://external.test/api/v4/flightdeck-pg/workspaces/${workspace}/scopes`)).rejects.toThrow("exact bound workspace");
    expect(calls).toHaveLength(3);
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value; }
  }
});
