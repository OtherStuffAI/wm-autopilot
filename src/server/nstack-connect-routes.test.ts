import { expect, test } from "bun:test";
import { handleNStackConnectRoute } from "./nstack-connect-routes";
const url = new URL("http://localhost/api/agent-chat/nstack-connect");
test("uses existing management scope; rejects discovery as an authority grant", async () => {
  let called = false;
  const manager = { discoverNStackForManager: async () => ({ workspaces: [], errors: [] }), connectNStackForManager: async () => { called = true; return { results: [] }; } };
  const response = await handleNStackConnectRoute(new Request(url, { method: "POST", body: "{}" }), url, manager, { managerNpub: "manager", canManage: false });
  expect(response?.status).toBe(403); expect(called).toBe(false);
  const invalid = await handleNStackConnectRoute(new Request(url, { method: "POST", body: "{}" }), url, manager, { managerNpub: "manager", canManage: true });
  expect(invalid?.status).toBe(400); expect(called).toBe(false);
});
test("direct discovery validates address and preserves management authorization", async () => {
  const endpoint = new URL(`${url}/discover`);
  const calls: unknown[] = [];
  const manager = { connectNStackForManager: async () => ({ results: [] }), discoverNStackForManager: async (...args: unknown[]) => { calls.push(args); return { workspaces: [], errors: [] }; } };
  for (const [canManage, address, status] of [[false, "https://tower.example", 403], [true, "http://tower.example", 400], [true, "https://tower.example/", 200]] as const) {
    const response = await handleNStackConnectRoute(new Request(endpoint, { method: "POST", body: JSON.stringify({ address }) }), endpoint, manager, { managerNpub: "manager", canManage });
    expect(response?.status).toBe(status);
  }
  expect(calls).toEqual([["manager", "https://tower.example"]]);
});
