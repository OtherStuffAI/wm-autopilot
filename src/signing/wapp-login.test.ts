import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import type { SessionSnapshot } from "../agents/process-manager";
import type { WappRecord } from "../wapps/types";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy } from "./capability-broker";
import { fetchWappLoginChallenge, hasWappLoginAuthority, type WappLoginRequest } from "./wapp-login";

const now = Date.now();
const input: WappLoginRequest = {
  sessionId: "session", ownerNpub: "owner", installationId: "installation", url: "https://reader.example/api/auth/login",
};
const session = {
  id: "session", npub: "owner", status: "running", origin: { type: "scheduler", id: "trigger" },
  metadata: { wappActivityInstallationId: "installation" },
} as unknown as SessionSnapshot;
const installation = {
  id: "installation", ownerNpub: "owner", workspaceOwnerNpub: "owner", status: "active", recordState: "active",
  registeredOpenOrigins: ["https://reader.example"],
} as WappRecord;
const template = () => ({
  kind: 27235, content: "book-of-sand-login", tags: [["challenge", crypto.randomUUID()]], created_at: Math.floor(now / 1000),
});
const authority = (request: WappLoginRequest, currentSession = session, currentInstallation = installation, trigger = "installation") =>
  hasWappLoginAuthority(request, (id) => id === "session" ? currentSession : null,
    (id) => id === "trigger" ? trigger : null, (id) => id === "installation" ? currentInstallation : null);
const fetchJson = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

describe("execution-bound WApp native login", () => {
  test("requires exact live scheduler, owner, installation and HTTPS registered-origin login path", () => {
    expect(authority(input)).toBeTrue();
    for (const url of [
      "https://reader.example/api/auth/login?x=1", "https://reader.example/api/auth/login#x",
      "https://reader.example/api/auth/login/", "https://reader.example/api/auth/../auth/login",
      "https://reader.example/api/auth/challenge", "https://evil.example/api/auth/login",
      "https://user@reader.example/api/auth/login", "http://reader.example/api/auth/login",
    ]) expect(authority({ ...input, url })).toBeFalse();
    expect(authority({ ...input, installationId: "other" })).toBeFalse();
    expect(authority({ ...input, sessionId: "other" })).toBeFalse();
    expect(authority({ ...input, ownerNpub: "other" })).toBeFalse();
    expect(authority(input, { ...session, npub: "other" })).toBeFalse();
    expect(authority(input, { ...session, status: "stopped" })).toBeFalse();
    expect(authority(input, { ...session, origin: undefined })).toBeFalse();
    expect(authority(input, { ...session, metadata: {} } as SessionSnapshot)).toBeFalse();
    expect(authority(input, session, installation, "other")).toBeFalse();
    expect(authority(input, session, { ...installation, recordState: "archived" })).toBeFalse();
    expect(authority(input, session, { ...installation, status: "archived" })).toBeFalse();
    expect(authority(input, session, { ...installation, workspaceOwnerNpub: "other" })).toBeFalse();
    expect(authority(input, session, { ...installation, registeredOpenOrigins: [] })).toBeFalse();
  });

  test("fetches only the native challenge, disallows redirects and validates the complete template", async () => {
    const event = template();
    const fetcher = (async (url: URL, init: RequestInit) => {
      expect(url.toString()).toBe("https://reader.example/api/auth/challenge");
      expect(init.redirect).toBe("error");
      expect(init.method).toBe("GET");
      expect(init.signal).toBeDefined();
      return Response.json({ event });
    }) as unknown as typeof fetch;
    expect(await fetchWappLoginChallenge(input.url, now, fetcher)).toEqual(event);
    for (const bad of [
      { ...event, kind: 1 }, { ...event, content: "arbitrary payload" },
      { ...event, created_at: event.created_at - 61 }, { ...event, created_at: event.created_at + 61 },
      { ...event, pubkey: "injected" }, { ...event, tags: [["challenge", "not-a-uuid"]] },
      { ...event, tags: [...event.tags, ["u", input.url]] }, { ...event, tags: [["p", crypto.randomUUID()]] },
    ]) await expect(fetchWappLoginChallenge(input.url, now, fetchJson({ event: bad }))).rejects.toThrow("native login contract");
    await expect(fetchWappLoginChallenge(input.url, now, fetchJson({ huge: "a".repeat(17000) }))).rejects.toThrow("size limit");
    await expect(fetchWappLoginChallenge(input.url, now, (async () => new Response(null, { status: 302 })) as typeof fetch)).rejects.toThrow("HTTP 302");
  });

  test("existing tokens use live binding, sign as stable bot, block replay and keep arbitrary kind signing denied", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const bot = { userNpub: "owner", botPubkeyHex: pubkey, botNpub: nip19.npubEncode(pubkey) } as BotKeyRecord;
    let bound = true;
    let calls = 0;
    const event = template();
    const broker = new CapabilityBroker({
      botKeyStore: { getActiveKeyForUser: () => bot, getActiveKeyForBotNpub: () => bot },
      keyVault: { withKey: async (_record, action) => action(secret) },
      getSession: () => session, now: () => now,
      hasWappLoginAuthority: (request) => bound && authority(request),
      fetchWappLogin: (async () => { calls++; return Response.json({ event }); }) as unknown as typeof fetch,
    });
    const policy = buildDefaultAgentCapabilityPolicy({ towerUrl: "https://tower.example", autopilotUrl: "https://autopilot.example" });
    const token = broker.issueSessionCapability({ sessionId: "session", ownerNpub: "owner", policy }).token;
    async function call(body: Record<string, unknown>, route = "wapp-login") {
      const url = new URL(`http://localhost/api/mcp/capabilities/${route}`);
      return (await broker.handle(new Request(url, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "x-wingman-capability-nonce": crypto.randomUUID(), "content-type": "application/json",
      }, body: JSON.stringify({ sessionId: "session", ...body }) }), url, "POST"))!;
    }
    const request = { wappInstallationId: "installation", url: input.url };
    bound = false;
    expect((await call(request)).status).toBe(403);
    expect(calls).toBe(0);
    bound = true;
    const response = await call(request);
    expect(response.status).toBe(200);
    const signed = await response.json();
    expect(verifyEvent(signed.event)).toBeTrue();
    expect(signed.event.pubkey).toBe(pubkey);
    expect(signed.signedBy).toBe(bot.botNpub);
    expect(signed.event.tags).toEqual(event.tags);
    expect((await call(request)).status).toBe(403);
    expect((await call({ event }, "nostr-event")).status).toBe(403);
    expect((await call({ url: input.url, method: "POST" }, "nip98")).status).toBe(403);
    broker.revokeSession("session");
    expect((await call(request)).status).toBe(403);
  });
});
