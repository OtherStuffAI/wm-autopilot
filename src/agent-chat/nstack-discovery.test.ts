import { expect, test } from "bun:test";
import { discoverNStackWorkspaces, validateNStackAddress } from "./nstack-discovery";
const row = (id = "one", origin = "http://tower.example") => ({ label: id, tower_base_url: origin,
  identity: { workspace_id: id, workspace_owner_npub: "owner", workspace_service_npub: "ws", tower_service_npub: "tower", app_npub: "app" } });
function fixture(fetchPage: any) {
  const secrets: Uint8Array[] = [];
  return { secrets, input: { address: "https://tower.example/", agentNpubs: ["a", "b"], fetchPage,
    resolveIdentity: async (botNpub: string) => {
      const botSecret = new Uint8Array([1]); secrets.push(botSecret);
      return { botNpub, botPubkeyHex: "pub", botSecret };
    } } };
}
test("accepts only root HTTPS addresses", () => {
  expect(validateNStackAddress(" https://TOWER.example/ ")).toBe("https://tower.example");
  for (const value of [null, "bad", "http://tower.example", "https://u:p@tower.example", "https://tower.example/path", "https://tower.example/?x=1", "https://tower.example/#x"]) {
    expect(() => validateNStackAddress(value)).toThrow();
  }
});
test("discovers paginated workspaces across agents, deduplicates, pins HTTPS and erases secrets", async () => {
  const urls: string[] = [];
  const f = fixture(async (url: string) => { urls.push(url); return url.includes("cursor=") ? { workspaces: [row("two")], next_cursor: null } : { workspaces: [row()], next_cursor: "next" }; });
  const result = await discoverNStackWorkspaces(f.input);
  expect(result.workspaces.map((item) => item.workspaceId)).toEqual(["one", "two"]);
  expect(result.workspaces[0]?.directHttpsUrl).toBe("https://tower.example");
  expect(urls).toHaveLength(4); expect(f.secrets.every((secret) => secret[0] === 0)).toBe(true);
});
test("reports one inaccessible agent while preserving accessible workspaces", async () => {
  const f = fixture(async (_url: string, identity: any) => {
    if (identity.botNpub === "a") throw new Error("HTTP 403");
    return { workspaces: [row()] };
  });
  const result = await discoverNStackWorkspaces(f.input);
  expect(result.workspaces).toHaveLength(1); expect(result.errors[0]).toContain("HTTP 403");
});
test("rejects cross-origin, malformed and looping discovery responses without importing partial pages", async () => {
  for (const response of [{ workspaces: [row("one", "https://evil.example")] }, { workspaces: [{}] }, { workspaces: [row(), row()] }, { workspaces: [row()], next_cursor: "same" }]) {
    const f = fixture(async () => response);
    await expect(discoverNStackWorkspaces(f.input)).rejects.toThrow();
    expect(f.secrets.every((secret) => secret[0] === 0)).toBe(true);
  }
});
test("empty membership and missing local agents are explicit", async () => {
  const f = fixture(async () => ({ workspaces: [] }));
  expect((await discoverNStackWorkspaces(f.input)).workspaces).toEqual([]);
  await expect(discoverNStackWorkspaces({ ...f.input, agentNpubs: [] })).rejects.toThrow("enabled local agent");
});
test("network discovery signs the exact URL, forbids redirects and surfaces bounded response errors", async () => {
  const originalFetch = globalThis.fetch;
  const signed: any[] = [];
  const identity = { botNpub: "agent", botPubkeyHex: "pub", signNip98: async (request: unknown) => { signed.push(request); return "Nostr fixture"; } };
  let response = Response.json({ workspaces: [row()] });
  const requests: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => { requests.push({ url, init }); return response; }) as typeof fetch;
  const input = { address: "https://tower.example", agentNpubs: ["agent"], resolveIdentity: async () => identity };
  try {
    expect((await discoverNStackWorkspaces(input)).workspaces).toHaveLength(1);
    expect(signed[0].url).toBe("https://tower.example/api/v4/flightdeck-pg/workspaces?limit=200");
    expect(requests[0].init.redirect).toBe("error");
    expect(requests[0].init.headers.Authorization).toBe("Nostr fixture");
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
    response = new Response("denied", { status: 403 });
    await expect(discoverNStackWorkspaces(input)).rejects.toThrow("HTTP 403");
    response = new Response("x".repeat(256 * 1024 + 1));
    await expect(discoverNStackWorkspaces(input)).rejects.toThrow("too large");
    response = new Response("not json");
    await expect(discoverNStackWorkspaces(input)).rejects.toThrow();
  } finally { globalThis.fetch = originalFetch; }
});
