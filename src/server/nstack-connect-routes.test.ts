import { expect, test } from "bun:test";
import { handleNStackConnectRoute } from "./nstack-connect-routes";
const url = new URL("http://localhost/api/agent-chat/nstack-connect");
test("uses existing management scope; rejects discovery as an authority grant", async () => {
  let called = false;
  const manager = { connectNStackForManager: async () => { called = true; return { results: [] }; } };
  const response = await handleNStackConnectRoute(new Request(url, { method: "POST", body: "{}" }), url, manager, { managerNpub: "manager", canManage: false });
  expect(response?.status).toBe(403); expect(called).toBe(false);
  const invalid = await handleNStackConnectRoute(new Request(url, { method: "POST", body: "{}" }), url, manager, { managerNpub: "manager", canManage: true });
  expect(invalid?.status).toBe(400); expect(called).toBe(false);
});
