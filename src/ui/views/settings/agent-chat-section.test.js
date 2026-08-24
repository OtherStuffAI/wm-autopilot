import { readFileSync } from "node:fs";

import { describe, expect, mock, test } from "bun:test";

import {
  buildAgentBindingInput,
  buildBackendSubscriptionInput,
  filterDispatchRoutesForSubscription,
  getAdditionalAgents,
  getAgentForSubscription,
  hasDuplicateWorkspaceAppOnAnotherTower,
  resolveAgentEditorDirectory,
  resolveSelectedSubscriptionId,
} from "./agent-chat-section-state.js";
import { createAgentDispatchSetupCards } from "./agent-chat-setup-cards.js";
import { createProfileWorkspaceSettingsCard } from "./agent-chat-profile-workspace-card.js";
import { createConfiguredDispatchesPanel } from "./agent-chat-shared-ui.js";

const agentChatSectionSource = readFileSync(new URL("./agent-chat-section.js", import.meta.url), "utf8");

mock.module("../../pipelines/api.js", () => ({
  fetchPipelineRun: async () => null,
}));

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
    this.disabled = false;
    this.type = "";
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

function queryByText(node, text) {
  if (!node || !(node instanceof FakeElement)) {
    return null;
  }
  if (node.textContent === text) {
    return node;
  }
  for (const child of node.children) {
    const match = queryByText(child, text);
    if (match) {
      return match;
    }
  }
  return null;
}

async function clickAsync(node) {
  const listeners = node?.listeners?.get("click") || [];
  for (const listener of listeners) {
    await listener({ currentTarget: node });
  }
}

describe("agent chat settings subscription selection", () => {
  const subscriptions = [
    {
      subscriptionId: "sub-primary",
      workspaceOwnerNpub: "npub1workspace",
      botNpub: "npub1bot",
    },
    {
      subscriptionId: "sub-secondary",
      workspaceOwnerNpub: "npub1workspace2",
      botNpub: "npub1bot2",
    },
  ];

  test("keeps duplicated live subscription cards out of the Agents tab", () => {
    expect(agentChatSectionSource).not.toContain("agent-chat-live-panel");
    expect(agentChatSectionSource).not.toContain("agent-chat-subscription-list");
    expect(agentChatSectionSource).not.toContain("createSubscriptionCard");
    expect(agentChatSectionSource).not.toContain("createProfileWorkspaceSettingsPanel");
    expect(agentChatSectionSource).not.toContain("createConfiguredDispatchesPanel");
    expect(agentChatSectionSource).not.toContain("saveAgentChatDispatchRoute");
  });

  test("keeps an explicit selected subscription instead of falling back to the first row", () => {
    expect(resolveSelectedSubscriptionId(subscriptions, "sub-secondary")).toBe("sub-secondary");
    expect(resolveSelectedSubscriptionId(subscriptions, "missing")).toBe("sub-primary");
    expect(resolveSelectedSubscriptionId([], "sub-secondary")).toBeNull();
  });

  test("scopes local agent selection by the selected workspace and bot", () => {
    const agents = [
      {
        agentId: "agent-primary",
        workspaceOwnerNpub: "npub1workspace",
        botNpub: "npub1bot",
      },
      {
        agentId: "agent-secondary",
        workspaceOwnerNpub: "npub1workspace2",
        botNpub: "npub1bot2",
      },
    ];

    expect(getAgentForSubscription(agents, subscriptions[1])?.agentId).toBe("agent-secondary");
    expect(getAgentForSubscription(agents, null)).toBeNull();
    expect(getAdditionalAgents(agents, agents[1]).map((agent) => agent.agentId)).toEqual(["agent-primary"]);
  });

  test("hydrates the editor from the direct chat directory with a working-directory fallback", () => {
    expect(resolveAgentEditorDirectory({
      workingDirectory: "/root",
      directChat: { directory: "/root/code/kato" },
    })).toBe("/root/code/kato");
    expect(resolveAgentEditorDirectory({ workingDirectory: "/root" })).toBe("/root");
    expect(resolveAgentEditorDirectory({
      workingDirectory: "/root",
      directChat: { directory: "   " },
    })).toBe("/root");
  });

  test("filters dispatch routes to the selected subscription", () => {
    const routes = [
      { routeId: "route-primary", subscriptionId: "sub-primary" },
      { routeId: "route-secondary", subscriptionId: "sub-secondary" },
    ];

    expect(filterDispatchRoutesForSubscription(routes, "sub-secondary")).toEqual([
      { routeId: "route-secondary", subscriptionId: "sub-secondary" },
    ]);
    expect(filterDispatchRoutesForSubscription(routes, null)).toEqual([]);
  });

  test("detects duplicate workspace/app subscriptions on another tower", () => {
    const duplicateSubscriptions = [
      {
        subscriptionId: "sub-primary",
        workspaceOwnerNpub: "npub1workspace",
        sourceAppNpub: "npub1source",
        backendBaseUrl: "https://tower-one.example",
      },
      {
        subscriptionId: "sub-secondary",
        workspaceOwnerNpub: "npub1workspace",
        sourceAppNpub: "npub1source",
        backendBaseUrl: "https://tower-two.example",
      },
    ];

    expect(hasDuplicateWorkspaceAppOnAnotherTower(duplicateSubscriptions, duplicateSubscriptions[0])).toBe(true);
    expect(hasDuplicateWorkspaceAppOnAnotherTower(duplicateSubscriptions, {
      ...duplicateSubscriptions[0],
      subscriptionId: "sub-third",
      sourceAppNpub: "npub1other",
    })).toBe(false);
  });

  test("builds agent binding input from the selected subscription", () => {
    const input = buildAgentBindingInput({
      subscriptionId: "sub-secondary",
      workspaceOwnerNpub: "npub1owner",
      workspaceServiceNpub: "npub1workspace-service",
      botNpub: "npub1bot-secondary",
    }, {
      agentId: "agent-secondary",
      label: "Secondary",
      workingDirectory: "/workspace/secondary",
      capabilities: ["chat_intercept", "task_dispatch"],
    });
    expect(input).toMatchObject({
      agentId: "agent-secondary",
      label: "Secondary",
      botNpub: "npub1bot-secondary",
      workspaceOwnerNpub: "npub1workspace-service",
      workingDirectory: "/workspace/secondary",
      capabilities: ["chat_intercept", "task_dispatch"],
      enabled: true,
      directChat: {
        enabled: true,
        sessionAgent: null,
        directory: "/workspace/secondary",
        model: null,
        idleRetentionMinutes: 60,
      },
    });
    expect(input).not.toHaveProperty("groupNpubs");
    expect(agentChatSectionSource).toContain("agentEditor.harnessSelect.value");
    expect(agentChatSectionSource).toContain("agentEditor.directChatEnabledField.input.checked");
    expect(agentChatSectionSource).not.toContain("agentGroupsField");
  });

  test("builds secondary subscription input from a selected backend connection", () => {
    expect(buildBackendSubscriptionInput({
      backendConnectionId: "backend-secondary",
      backendBaseUrl: "https://secondary.example",
      setupWorkspaceOwnerNpub: "npub1owner-secondary",
      setupWorkspaceServiceNpub: "npub1workspace-secondary",
      setupWorkspaceId: "workspace-secondary",
      setupSourceAppNpub: "npub1source-secondary",
      serviceNpub: "npub1tower-secondary",
      operator: { shared: true },
    })).toEqual({
      backendConnectionId: "backend-secondary",
      backendBaseUrl: "https://secondary.example",
      workspaceOwnerNpub: "npub1owner-secondary",
      workspaceServiceNpub: "npub1workspace-secondary",
      workspaceId: "workspace-secondary",
      sourceAppNpub: "npub1source-secondary",
      towerServiceNpub: "npub1tower-secondary",
      backendConnectionGrantKind: "shared_service",
    });
  });

  test("renders setup-ready backend choices for a secondary subscription", () => {
    withFakeDocument(() => {
      let selectedBackendConnection = null;
      const panel = createAgentDispatchSetupCards({
        subscription: {
          subscriptionId: "sub-primary",
          backendConnectionId: "backend-primary",
          backendBaseUrl: "https://primary.example",
          workspaceOwnerNpub: "npub1workspace",
          sourceAppNpub: "npub1source",
          botNpub: "npub1bot",
        },
        primaryAgent: {
          agentId: "agent-primary",
          capabilities: ["chat_intercept"],
        },
        availableBackendConnections: [
          {
            backendConnectionId: "backend-primary",
            backendBaseUrl: "https://primary.example",
            setupWorkspaceOwnerNpub: "npub1workspace",
            setupSourceAppNpub: "npub1source",
            healthStatus: "healthy",
          },
          {
            backendConnectionId: "backend-secondary",
            backendBaseUrl: "https://secondary.example",
            setupWorkspaceOwnerNpub: "npub1workspace2",
            setupSourceAppNpub: "npub1source2",
            healthStatus: "healthy",
          },
        ],
        onUseBackendConnection: (backendConnection) => {
          selectedBackendConnection = backendConnection;
        },
      });

      expect(queryByTestId(panel, "agent-chat-available-backend-backend-primary")).toBeNull();
      expect(queryByTestId(panel, "agent-chat-available-backend-backend-secondary")).not.toBeNull();

      queryByTestId(panel, "agent-chat-use-backend-backend-secondary").click();
      expect(selectedBackendConnection?.backendConnectionId).toBe("backend-secondary");
    });
  });

  test("renders visible profile workspace scopes and channels as editable targets", () => {
    withFakeDocument(() => {
      const panel = createProfileWorkspaceSettingsCard({
        canManage: true,
        pipelineDefinitions: [{ id: "chat-pipeline", name: "Chat Pipeline" }],
        subscription: {
          profileWorkspace: {
            profile: {
              profileId: "agent-profile-1",
              defaultPipelineDefinitionId: "",
              promptContext: "",
            },
            workspace: {
              profileWorkspaceId: "profile-workspace-1",
              workspaceOwnerNpub: "npub1workspace",
              sourceAppNpub: "npub1source",
              backendBaseUrl: "https://tower.example",
              towerUrl: "https://tower.example",
              connectionHealth: "healthy",
              yokeSyncStatus: "synced",
              relayOnboardingStatus: "ready",
              defaultPipelineDefinitionId: "",
              workspaceContext: "",
            },
            policies: [],
            pipelineOverrides: [],
            appendedContexts: [],
            visibleContext: {
              scopes: [{ id: "scope-autopilot", label: "Autopilot", source: "last_routing" }],
              channels: [{ id: "channel-design", label: "Design", source: "last_routing", scopeId: "scope-autopilot" }],
            },
          },
        },
        onSave: () => {},
      });

      expect(queryByTestId(panel, "agent-chat-profile-target-id-0")?.value).toBe("scope-autopilot");
      expect(queryByTestId(panel, "agent-chat-profile-target-id-1")?.value).toBe("channel-design");
    });
  });

  test("saves routes against a selected non-first subscription", async () => {
    await withFakeDocument(async () => {
      const savedRoutes = [];
      const panel = createConfiguredDispatchesPanel({
        agentId: "agent-secondary",
        label: "Secondary",
        workingDirectory: "/workspace/secondary",
        enabled: true,
        capabilities: ["task_dispatch"],
      }, {}, {
        subscription: {
          subscriptionId: "sub-secondary",
          workspaceOwnerNpub: "npub1workspace2",
          sourceAppNpub: "npub1source2",
          botNpub: "npub1bot2",
        },
        dispatchRoutes: [],
        pipelineDefinitions: [{ id: "task-pipeline", name: "Task Pipeline" }],
        onSaveRoute: async (route) => {
          savedRoutes.push(route);
          return route;
        },
      });

      queryByTestId(panel, "agent-chat-capability-pipeline-task-dispatch").value = "task-pipeline";
      await clickAsync(queryByText(panel, "Save Pipeline"));

      expect(savedRoutes).toHaveLength(1);
      expect(savedRoutes[0]).toMatchObject({
        subscriptionId: "sub-secondary",
        triggerKind: "task",
        capability: "task_dispatch",
        pipelineDefinitionId: "task-pipeline",
      });
    });
  });

  test("allows editing but not removing Flight Deck onboarded subscriptions", async () => {
    const { createSubscriptionCard } = await import("./agent-chat-operator-cards.js");
    withFakeDocument(() => {
      const card = createSubscriptionCard({
        subscriptionId: "sub-flight-deck",
        workspaceOwnerNpub: "npub1workspace",
        workspaceServiceNpub: "npub1workspaceservice",
        workspaceId: "workspace-pg-1",
        botNpub: "npub1bot",
        sourceAppNpub: "npub1source",
        onboardingSource: "nostr_33357",
        sseStatus: "connected",
        healthStatus: "healthy",
        profileWorkspace: {
          workspace: {
            workspaceTitle: "Example Operator Postgres Workspace",
          },
        },
        operator: {
          canManage: true,
          enabled: true,
          candidateAgentCount: 1,
        },
      }, [], {
        allowConnectionManagement: true,
        dispatchRoutes: [],
        getDispatchRoutes: () => [],
        pipelineDefinitions: [],
        runAction: () => {},
        select: () => {},
        selectedSubscriptionId: "sub-flight-deck",
      });

      const text = collectText(card);
      expect(text).toContain("Example Operator Postgres Workspace");
      expect(text).toContain("workspace npub1workspaceservice");
      expect(text).toContain("owner npub1workspace");
      expect(queryByTestId(card, "agent-chat-edit-sub-flight-deck")).not.toBeNull();
      expect(queryByTestId(card, "agent-chat-remove-sub-flight-deck")).toBeNull();
      expect(queryByTestId(card, "agent-chat-reconnect-sub-flight-deck")).not.toBeNull();
    });
  });

  test("warns when a subscription shares workspace and app on another tower", async () => {
    const { createSubscriptionCard } = await import("./agent-chat-operator-cards.js");
    withFakeDocument(() => {
      const card = createSubscriptionCard({
        subscriptionId: "sub-primary",
        workspaceOwnerNpub: "npub1workspace",
        botNpub: "npub1bot",
        sourceAppNpub: "npub1source",
        backendBaseUrl: "https://tower-one.example",
        onboardingSource: "nostr_33357",
        operator: {
          canManage: true,
          enabled: true,
          candidateAgentCount: 1,
        },
      }, [], {
        dispatchRoutes: [],
        getDispatchRoutes: () => [],
        hasDuplicateWorkspaceApp: () => true,
        pipelineDefinitions: [],
        runAction: () => {},
        select: () => {},
        selectedSubscriptionId: "sub-primary",
      });

      expect(collectText(card)).toContain("Same workspace/app on another Tower. Requires subscription-safe routing.");
    });
  });
});
