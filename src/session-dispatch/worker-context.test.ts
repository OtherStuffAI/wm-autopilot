import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../agents/process-manager";
import { normaliseSessionMetadata } from "../sessions/session-metadata";
import { selectFlightDeckTransportSubscription } from "../agent-chat/flightdeck-session-transport";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";
import { createWorkerContextValidator, inheritWorkerContext } from "./worker-context";

const metadata = {
  AGENT: true, billingMode: "subscription" as const, sessionClass: "flightdeck_chat" as const,
  agentChatAgentId: "profile", agentChatBotNpub: "bot", flightdeckAgentNpub: "bot",
  flightdeckTowerServiceNpub: "tower", flightdeckWorkspaceId: "workspace",
  flightdeckSubscriptionId: "subscription", flightdeckBackendConnectionId: "connection",
  flightdeckChannelId: "channel", flightdeckThreadId: "thread", flightdeckScopeId: "scope",
  flightdeckRoutingKey: "publish-route", ownerNpub: "owner", goal: "parent goal",
  flowRunId: "parent-run", delegateRelationshipId: "delegation", privateKey: "never-copy",
};
const parent = { id: "parent", npub: "owner", metadata } as unknown as SessionSnapshot;
const records = [{ lifecycleStatus: "active", managedByNpub: "owner", botNpub: "bot",
  towerServiceNpub: "tower", workspaceId: "workspace", subscriptionId: "subscription",
  backendConnectionId: "connection" }] as WorkspaceSubscriptionRecord[];
const validate = createWorkerContextValidator({
  resolveFlightDeckTurnDelivery: (binding) => selectFlightDeckTransportSubscription(records, binding)
    ? { botIdentity: { botNpub: "bot" } } : null,
});

test("inherits only validated identity and routing, surviving metadata normalization", () => {
  const inherited = inheritWorkerContext(parent, { taskId: "task" }, validate);
  expect(inherited).toEqual({ agentChatAgentId: "profile", agentChatBotNpub: "bot", flightdeckAgentNpub: "bot",
    flightdeckTowerServiceNpub: "tower", flightdeckWorkspaceId: "workspace",
    flightdeckSubscriptionId: "subscription", flightdeckBackendConnectionId: "connection",
    flightdeckChannelId: "channel", flightdeckThreadId: "thread", flightdeckScopeId: "scope",
    bindingType: "task", bindingId: "task", taskIds: ["task"] });
  expect(normaliseSessionMetadata(inherited)).toMatchObject({ ...inherited, AGENT: false });
});

test("ordinary dispatch has no mandatory Flight Deck resolver or forged authority", () => {
  expect(inheritWorkerContext(null, metadata)).toEqual({});
  expect(inheritWorkerContext({ ...parent, metadata: { AGENT: false, billingMode: "subscription" } },
    { ...metadata, workspaceId: "forged" })).toEqual({});
});

test("reporting fields cannot override identity, transport, ownership or publishing", () => {
  const inherited = inheritWorkerContext(parent, { ...metadata, agentChatBotNpub: "evil",
    ownerNpub: "evil", flightdeckWorkspaceId: "evil", taskId: "task" }, validate);
  expect(inherited.agentChatBotNpub).toBe("bot");
  expect(inherited.flightdeckWorkspaceId).toBe("workspace");
  expect(inherited.ownerNpub).toBeUndefined();
  expect(inherited.sessionClass).toBeUndefined();
  for (const hint of ["workspaceId", "channelId", "threadId"]) {
    expect(() => inheritWorkerContext(parent, { [hint]: "evil" }, validate)).toThrow("trusted parent");
  }
});

test("rejects missing, cross-owner, mismatched or inactive parent transport", () => {
  expect(() => inheritWorkerContext(parent, {})).toThrow("active owner subscription");
  for (const patch of [{ ownerNpub: "other" }, { flightdeckBackendConnectionId: "other" },
    { flightdeckSubscriptionId: "other" }, { flightdeckWorkspaceId: "other" }]) {
    expect(() => inheritWorkerContext({ ...parent, metadata: { ...metadata, ...patch } }, {}, validate))
      .toThrow("active owner subscription");
  }
  expect(() => inheritWorkerContext({ ...parent, metadata: { ...metadata, flightdeckAgentNpub: "evil" } }, {}, validate))
    .toThrow("inconsistent");
  const inactiveValidator = createWorkerContextValidator({ resolveFlightDeckTurnDelivery: (binding) =>
    selectFlightDeckTransportSubscription(records.map((record) => ({ ...record, lifecycleStatus: "inactive" })) as WorkspaceSubscriptionRecord[], binding)
      ? { botIdentity: { botNpub: "bot" } } : null });
  expect(() => inheritWorkerContext(parent, {}, inactiveValidator)).toThrow("active owner subscription");
});

test("inherits a parent task when reporting does not supply one", () => {
  expect(inheritWorkerContext({ ...parent, metadata: { ...metadata, bindingType: "task", bindingId: "parent-task" } }, {}, validate))
    .toMatchObject({ bindingType: "task", bindingId: "parent-task", taskIds: ["parent-task"] });
  expect(() => inheritWorkerContext(parent, { taskId: {} }, validate)).toThrow("nonempty string");
});
