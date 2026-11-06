import { describe, expect, test } from "bun:test";
import { buildScheduledSessionContextMetadata, createScheduledSessionContextResolver } from "./session-context";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";

export const route = {
  ownerNpub: "owner", subscriptionId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  scopeId: "10000000-0000-4000-8000-000000000003",
  channelId: "10000000-0000-4000-8000-000000000004",
  threadId: "10000000-0000-4000-8000-000000000005",
  taskId: "10000000-0000-4000-8000-000000000006",
};
export function subscription(): WorkspaceSubscriptionRecord {
  return { subscriptionId: route.subscriptionId, managedByNpub: "owner", botNpub: "bot",
    lifecycleStatus: "active", sseStatus: "connected", workspaceId: route.workspaceId,
    towerServiceNpub: "tower", backendConnectionId: "connection", backendBaseUrl: "https://tower.test",
    sourceAppNpub: "app" } as WorkspaceSubscriptionRecord;
}
const job = { userNpub: "owner", botNpub: "bot", flightdeckContext: route };

describe("scheduled launch context", () => {
  test("preserves exact delegated owner and bot and location", () => {
    const resolve = createScheduledSessionContextResolver({ getSubscription: subscription, getActiveBotOwnerNpub: () => "owner" });
    expect(resolve(job)).toMatchObject({ flightdeckAgentNpub: "bot", flightdeckWorkspaceId: route.workspaceId,
      flightdeckSubscriptionId: route.subscriptionId, bindingType: "task", bindingId: route.taskId });
    expect(() => resolve({ ...job, userNpub: "another-owner" })).toThrow("exact active bot");
  });
  test("unavailable exact live transport fails instead of falling back to another subscription", () => {
    const resolve = createScheduledSessionContextResolver({ getSubscription: subscription, getActiveBotOwnerNpub: () => "owner", resolveTransport: () => null });
    expect(() => resolve(job)).toThrow("no exact live bot transport");
  });
  test.each(["managedByNpub", "botNpub", "workspaceId", "subscriptionId", "lifecycleStatus", "sseStatus"])(
    "rejects mismatched or unavailable %s", field => {
      const sub = subscription(); (sub as any)[field] = field === "sseStatus" ? "disabled" : "wrong";
      expect(() => buildScheduledSessionContextMetadata(job, route, sub)).toThrow("exact active owner");
    });
  test.each(["towerServiceNpub", "backendConnectionId", "backendBaseUrl", "sourceAppNpub"])(
    "fails explicitly for missing %s", field => {
      const sub = subscription(); (sub as any)[field] = "";
      expect(() => buildScheduledSessionContextMetadata(job, route, sub)).toThrow("Tower service identity");
    });
  test("does not infer or default a missing binding; workspace-only binds no public channel", () => {
    const resolve = createScheduledSessionContextResolver({ getSubscription: subscription, getActiveBotOwnerNpub: () => "owner" });
    expect(resolve({ ...job, flightdeckContext: null })).toEqual({});
    expect(() => buildScheduledSessionContextMetadata(job, {}, subscription())).toThrow();
    expect(() => buildScheduledSessionContextMetadata(job, route, null)).toThrow();
    const { scopeId, channelId, threadId, taskId, ...privateRoute } = route;
    expect(buildScheduledSessionContextMetadata(job, privateRoute, subscription())).toMatchObject({
      flightdeckWorkspaceId: route.workspaceId, flightdeckChannelId: undefined,
    });
    expect(buildScheduledSessionContextMetadata(job, privateRoute, subscription()).bindingType).toBeUndefined();
  });
});
