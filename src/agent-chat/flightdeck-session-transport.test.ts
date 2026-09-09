import { expect, test } from "bun:test";
import { selectFlightDeckTransportSubscription } from "./flightdeck-session-transport";
import type { WorkspaceSubscriptionRecord } from "./types";

test("direct sessions retain exact connection and owner across equal Tower tuples", () => {
  const input = { towerServiceNpub: "tower", workspaceId: "workspace", agentNpub: "bot", managerNpub: "second" };
  const records = [
    { managedByNpub: "first", subscriptionId: "first", backendConnectionId: "https" },
    { managedByNpub: "second", subscriptionId: "second", backendConnectionId: "mesh" },
    { managedByNpub: "second", subscriptionId: "third", backendConnectionId: "other" },
  ].map((row) => ({ towerServiceNpub: "tower", workspaceId: "workspace", botNpub: "bot", ...row })) as WorkspaceSubscriptionRecord[];
  expect(selectFlightDeckTransportSubscription(records, { ...input, subscriptionId: "second" })?.backendConnectionId).toBe("mesh");
  expect(selectFlightDeckTransportSubscription(records, { ...input, subscriptionId: "first" })).toBeNull();
  expect(() => selectFlightDeckTransportSubscription(records, input)).toThrow("ambiguous");
  expect(() => selectFlightDeckTransportSubscription(records, { ...input, managerNpub: null })).toThrow("owner");
  expect(selectFlightDeckTransportSubscription(records, { ...input, managerNpub: "first" })?.backendConnectionId).toBe("https");
});
