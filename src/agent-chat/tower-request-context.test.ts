import { expect, test } from "bun:test";
import { resolveTowerRequestConnection } from "./tower-request-context";
import type { BackendConnectionRecord, WorkspaceSubscriptionRecord } from "./types";

test("same Tower origin never shares approvals between two owners", () => {
  const records = [
    { backendConnectionId: "one", managedByNpub: "owner-one", backendBaseUrl: "https://tower.example", transport: { mode: "fips" } },
    { backendConnectionId: "two", managedByNpub: "owner-two", backendBaseUrl: "https://tower.example", transport: { mode: "https" } },
  ] as BackendConnectionRecord[];
  const stores = {
    connection: (id: string) => records.find((row) => row.backendConnectionId === id) ?? null,
    subscription: (id: string) => id === "bound" ? { backendConnectionId: "one" } as WorkspaceSubscriptionRecord : null,
  };
  expect(resolveTowerRequestConnection({ backendConnectionId: "two" }, stores)?.transport?.mode).toBe("https");
  expect(resolveTowerRequestConnection({ subscriptionId: "bound" }, stores)?.managedByNpub).toBe("owner-one");
  expect(resolveTowerRequestConnection({}, stores)).toBeNull();
  expect(() => resolveTowerRequestConnection({ backendConnectionId: "two", subscriptionId: "bound" }, stores)).toThrow("differs");
  expect(() => resolveTowerRequestConnection({ subscriptionId: "missing" }, stores)).toThrow("missing");
  expect(() => resolveTowerRequestConnection({ backendConnectionId: "missing" }, stores)).toThrow("missing");
});
