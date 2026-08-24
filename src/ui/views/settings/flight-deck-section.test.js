import { describe, expect, test } from "bun:test";

import { createFlightDeckConnectionsPanel } from "./flight-deck-section.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toLowerCase();
    this.className = "";
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
  }

  append(...children) {
    this.children.push(...children.filter(Boolean));
  }

  addEventListener(type, callback) {
    const existing = this.listeners.get(type) || [];
    existing.push(callback);
    this.listeners.set(type, existing);
  }

  setAttribute(name, value) {
    const normalized = String(name || "");
    const stringValue = String(value ?? "");
    this.attributes[normalized] = stringValue;
    if (normalized === "data-testid") {
      this.dataset.testid = stringValue;
    }
  }

  click() {
    const listeners = this.listeners.get("click") || [];
    listeners.forEach((listener) => listener({ currentTarget: this }));
  }
}

function withFakeDocument(run) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };

  try {
    return run();
  } finally {
    globalThis.document = originalDocument;
  }
}

function queryByTestId(node, testId) {
  if (!node) {
    return null;
  }
  if (node instanceof FakeElement && node.dataset?.testid === testId) {
    return node;
  }
  if (!Array.isArray(node.children)) {
    return null;
  }
  for (const child of node.children) {
    if (child instanceof FakeElement) {
      const match = queryByTestId(child, testId);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

function collectText(node) {
  if (!node || !(node instanceof FakeElement)) {
    return "";
  }
  return [
    node.textContent,
    ...node.children.map((child) => collectText(child)),
  ].filter(Boolean).join(" ");
}

describe("flight deck settings panel", () => {
  test("renders workspace connection status and management action", () => {
    withFakeDocument(() => {
      let managedSubscriptionId = null;
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-flightdeck",
            backendConnectionId: "backend-flightdeck",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            workspaceServiceNpub: "npub1workspaceservice",
            workspaceId: "workspace-swipeback",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            groupKeyStatus: "synced",
            recentSseEvents: [
              {
                at: "2026-06-10T06:00:00.000Z",
                eventType: "flightdeck_pg.message.created",
                eventId: "event-message-1234567890",
                payload: {
                  entity_type: "message",
                  channel_id: "channel-bugs",
                },
              },
            ],
            recentDispatches: [
              {
                at: "2026-06-10T06:00:01.000Z",
                kind: "chat",
                action: "chat_pipeline_dispatch",
                sessionId: "session-dispatch-123456",
                details: {
                  channel_id: "channel-bugs",
                  pipeline_run_id: "run-1",
                },
              },
            ],
            lastRoutingResult: {
              ok: true,
              code: "chat_pipeline_dispatched",
              message: "Chat event dispatched.",
              at: "2026-06-10T06:00:02.000Z",
              details: {
                message_id: "message-1",
              },
            },
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Swipeback",
                relayOnboardingStatus: "ready",
                yokeSyncStatus: "synced",
              },
              visibleContext: {
                scopes: [{ id: "scope-design", label: "Design" }],
                channels: [{ id: "channel-bugs", label: "Bugs" }],
              },
              profile: {
                defaultPipelineDefinitionId: "",
                promptContext: "",
              },
              policies: [
                {
                  eventType: "direct_message",
                  enabled: true,
                  defaultAction: "respond",
                  pipelineDefinitionId: "fd-agent-dispatch-chat",
                  quietMode: false,
                },
                {
                  eventType: "chat_mention",
                  enabled: true,
                  defaultAction: "respond",
                  pipelineDefinitionId: "fd-agent-dispatch-chat",
                  quietMode: false,
                },
                {
                  eventType: "chat_observe",
                  enabled: false,
                  defaultAction: "observe",
                  pipelineDefinitionId: "fd-agent-dispatch-chat",
                  quietMode: true,
                },
                {
                  eventType: "document_comment_tagged",
                  enabled: true,
                  defaultAction: "respond",
                  pipelineDefinitionId: "fd-agent-dispatch-comment-response",
                  quietMode: false,
                },
                {
                  eventType: "task_assigned",
                  enabled: true,
                  defaultAction: "work",
                  pipelineDefinitionId: "fd-agent-dispatch-task-response",
                  quietMode: false,
                },
              ],
              appendedContexts: [{ contextKind: "workspace", contextText: "Repo path" }],
            },
          },
        ],
        backendConnections: [{ backendConnectionId: "backend-flightdeck" }],
        agents: [
          {
            agentId: "exampleAgent",
            workspaceOwnerNpub: "npub1workspaceservice",
            botNpub: "npub1agentbot",
          },
        ],
        pipelineDefinitions: [
          { id: "fd-agent-dispatch-chat", name: "FD Chat Dispatch" },
          { id: "fd-agent-dispatch-comment-response", name: "FD Comment Dispatch" },
          { id: "fd-agent-dispatch-task-response", name: "FD Task Dispatch" },
        ],
        chatSessions: [{ id: "session-1" }],
        onManageDispatch: (subscription) => {
          managedSubscriptionId = subscription?.subscriptionId ?? "summary";
        },
      });

      const text = collectText(panel);
      expect(text).toContain("Flight Deck");
      expect(text).toContain("Swipeback");
      expect(text).toContain("Events Connected");
      expect(text).not.toContain("SSE Connected");
      expect(text).toContain("Onboarding Ready");
      expect(text).toContain("Yoke Synced");
      expect(text).toContain("Default Dispatch Ready");
      expect(text).toContain("5/8 enabled");
      expect(text).toContain("Workspace id");
      expect(text).toContain("workspace-swipeback");
      expect(text).toContain("Workspace service");
      expect(text).toContain("Workspace member owner");
      expect(text).toContain("Tower service");
      expect(text).toContain("Connection source");
      expect(text).toContain("kind 33357");
      expect(text).toContain("Visible scopes");
      expect(text).toContain("Visible channels");
      expect(text).toContain("Appended context");
      expect(text).toContain("Default Dispatch");
      expect(text).toContain("Selected workspace: Swipeback");
      expect(text).toContain("Dispatch Settings");
      expect(text).toContain("Chat");
      expect(text).toContain("Docs");
      expect(text).toContain("Tasks");
      expect(text).not.toContain("Direct Message");
      expect(text).not.toContain("Chat Tagged");
      expect(text).toContain("Chat Observed");
      expect(text).toContain("Doc Tagged");
      expect(text).toContain("Task Assigned");
      expect(text).toContain("FD Chat Dispatch");
      expect(text).toContain("FD Comment Dispatch");
      expect(text).toContain("FD Task Dispatch");
      expect(text).not.toContain("legacy-flow-pipeline");
      expect(queryByTestId(panel, "flight-deck-dispatch-row-direct_message")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-chat_mention")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-chat_observe")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-task_assigned")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-default-dispatch-card")).not.toBeNull();
      expect(text).not.toContain("SSE Events");
      expect(text).not.toContain("flightdeck_pg.message.created");
      expect(text).not.toContain("Dispatches");
      expect(text).not.toContain("chat_pipeline_dispatch");
      expect(text).not.toContain("Last Routing Result");
      expect(text).not.toContain("chat_pipeline_dispatched");
      expect(queryByTestId(panel, "flight-deck-sse-events-sub-flightdeck-row-0")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-events-sub-flightdeck-row-0")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-routing-result-sub-flightdeck-row-0")).toBeNull();

      queryByTestId(panel, "flight-deck-manage-sub-flightdeck").click();
      expect(managedSubscriptionId).toBe("sub-flightdeck");
    });
  });

  test("keeps the selected workspace dispatch table visible without configured policies", () => {
    withFakeDocument(() => {
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-empty-routes",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            workspaceServiceNpub: "npub1workspaceservice",
            workspaceId: "workspace-empty",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Empty Routes",
                relayOnboardingStatus: "ready",
              },
            },
          },
        ],
      });

      const text = collectText(panel);
      expect(queryByTestId(panel, "flight-deck-default-dispatch-card")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-direct_message")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-document_comment_tagged")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-task_assigned")).not.toBeNull();
      expect(text).toContain("Selected workspace: Empty Routes");
      expect(text).toContain("Built-in default");
      expect(text).toContain("5/8 enabled");
    });
  });

  test("saves selected workspace dispatch policy changes", async () => {
    await withFakeDocument(async () => {
      let saved = null;
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-save-policies",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            workspaceServiceNpub: "npub1workspaceservice",
            workspaceId: "workspace-save",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              profile: {
                defaultPipelineDefinitionId: "",
                promptContext: "",
              },
              workspace: {
                workspaceTitle: "Save Policies",
                relayOnboardingStatus: "ready",
                defaultPipelineDefinitionId: "",
                workspaceContext: "",
                duplicateCallbackMarker: "duplicate callback:",
                duplicateCallbackWindowSeconds: 180,
              },
              policies: [
                {
                  eventType: "chat_mention",
                  enabled: true,
                  defaultAction: "respond",
                  pipelineDefinitionId: "old-chat-pipeline",
                  quietMode: false,
                },
                {
                  eventType: "approval_assigned",
                  enabled: true,
                  defaultAction: "notify",
                  pipelineDefinitionId: "approval-pipeline",
                  quietMode: false,
                },
              ],
              pipelineOverrides: [],
              appendedContexts: [],
            },
          },
        ],
        pipelineDefinitions: [{ id: "new-chat-pipeline", name: "New Chat Pipeline" }],
        onSaveProfileWorkspace: async (subscription, input) => {
          saved = { subscriptionId: subscription.subscriptionId, input };
        },
      });

      expect(queryByTestId(panel, "flight-deck-dispatch-enabled-chat_mention")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-pipeline-chat_mention")).toBeNull();
      const marker = queryByTestId(panel, "flight-deck-duplicate-callback-marker");
      const windowSeconds = queryByTestId(panel, "flight-deck-duplicate-callback-window-seconds");
      expect(marker.value).toBe("duplicate callback:");
      expect(windowSeconds.value).toBe("180");
      marker.value = "repeat response:";
      windowSeconds.value = "45";

      queryByTestId(panel, "flight-deck-dispatch-save-sub-save-policies").click();
      await Promise.resolve();
      await Promise.resolve();

      expect(saved.subscriptionId).toBe("sub-save-policies");
      expect(saved.input.duplicateCallbackMarker).toBe("repeat response:");
      expect(saved.input.duplicateCallbackWindowSeconds).toBe("45");
      expect(saved.input.policies).toContainEqual({
        eventType: "chat_mention",
        enabled: true,
        defaultAction: "respond",
        pipelineDefinitionId: "old-chat-pipeline",
        pipelineVersionPolicy: "latest",
        promptContext: "",
        quietMode: false,
      });
      expect(saved.input.policies).toContainEqual({
        eventType: "approval_assigned",
        enabled: false,
        defaultAction: "ignore",
        pipelineDefinitionId: "approval-pipeline",
        pipelineVersionPolicy: "latest",
        promptContext: "",
        quietMode: true,
      });
    });
  });

  test("hides manual and Agent Connect-only Tower subscriptions", () => {
    withFakeDocument(() => {
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-manual",
            backendBaseUrl: "https://manual.example",
            workspaceOwnerNpub: "npub1manualworkspace",
            sourceAppNpub: "npub1app",
            botNpub: "npub1bot",
            onboardingSource: "manual",
            healthStatus: "healthy",
            sseStatus: "connected",
          },
          {
            subscriptionId: "sub-agent-connect",
            backendBaseUrl: "https://agent-connect.example",
            workspaceOwnerNpub: "npub1agentconnectworkspace",
            sourceAppNpub: "npub1app",
            botNpub: "npub1bot",
            onboardingSource: "agent_connect_import",
            healthStatus: "healthy",
            sseStatus: "connected",
          },
        ],
      });

      const text = collectText(panel);
      expect(text).toContain("No Onboarded Workspaces");
      expect(text).toContain("No kind 33357 workspace onboarding events");
      expect(text).not.toContain("manual.example");
      expect(text).not.toContain("agent-connect.example");
    });
  });

  test("tabs multiple onboarded workspaces and renders only the selected one", () => {
    withFakeDocument(() => {
      let selectedSubscriptionId = null;
      const panel = createFlightDeckConnectionsPanel({
        selectedSubscriptionId: "sub-wingmen",
        subscriptions: [
          {
            subscriptionId: "sub-thisworks",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1thisworks",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "This Works",
                relayOnboardingStatus: "ready",
              },
              policies: [
                {
                  eventType: "chat_mention",
                  enabled: true,
                  defaultAction: "respond",
                  pipelineDefinitionId: "thisworks-chat-pipeline",
                  quietMode: false,
                },
              ],
            },
          },
          {
            subscriptionId: "sub-wingmen",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1wingmen",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Wingmen",
                relayOnboardingStatus: "ready",
              },
              policies: [
                {
                  eventType: "chat_mention",
                  enabled: true,
                  defaultAction: "respond",
                  pipelineDefinitionId: "wingmen-chat-pipeline",
                  quietMode: false,
                },
              ],
            },
          },
        ],
        pipelineDefinitions: [
          { id: "thisworks-chat-pipeline", name: "Thisworks Chat Pipeline" },
          { id: "wingmen-chat-pipeline", name: "Wingmen Chat Pipeline" },
        ],
        onSelectWorkspace: (subscription) => {
          selectedSubscriptionId = subscription?.subscriptionId ?? null;
        },
      });

      const text = collectText(panel);
      expect(queryByTestId(panel, "flight-deck-workspace-tab-sub-thisworks")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-workspace-tab-sub-wingmen")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-connection-sub-thisworks")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-connection-sub-wingmen")).not.toBeNull();
      expect(text).toContain("This Works");
      expect(text).toContain("Wingmen");
      expect(queryByTestId(panel, "flight-deck-dispatch-pipeline-chat_mention")).toBeNull();

      queryByTestId(panel, "flight-deck-workspace-tab-sub-thisworks").click();
      expect(selectedSubscriptionId).toBe("sub-thisworks");
    });
  });

  test("keeps revoked onboarding out of the active list and shows diagnostics", () => {
    withFakeDocument(() => {
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-revoked",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "unhealthy",
            sseStatus: "disabled",
            wsKeyStatus: "revoked",
            groupKeyStatus: "revoked",
            lastErrorCode: "workspace_access_revoked",
            lastAuthResult: {
              message: "Tower confirmed revoked workspace access.",
              details: {
                source_33357_event_id: "event-revoked-1234567890",
                tower_result: "workspace_deleted",
              },
            },
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Old Workspace",
                relayOnboardingStatus: "deleted",
              },
            },
          },
        ],
      });

      const text = collectText(panel);
      expect(text).toContain("No Onboarded Workspaces");
      expect(text).toContain("Diagnostics");
      expect(text).toContain("Old Workspace");
      expect(text).toContain("Onboarding Deleted");
      expect(text).toContain("Tower confirmed revoked workspace access.");
      expect(queryByTestId(panel, "flight-deck-connection-sub-revoked")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-diagnostic-sub-revoked")).not.toBeNull();
    });
  });
});
