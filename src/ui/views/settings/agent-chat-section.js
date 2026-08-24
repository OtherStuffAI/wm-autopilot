import {
  importAgentConnectPackage,
  createAgentChatProfile,
  republishAgentChatProfile,
  listAgentChatBackendConnections,
  listAgentChatAgents,
  listAgentChatSubscriptions,
  saveAgentChatAgent,
  saveAgentChatBackendConnectionAvailability,
  saveAgentChatSubscription,
} from '../../services/agent-chat.js';
import { createStatusLine } from './agent-chat-shared-ui.js';
import { fetchConfigApi } from '../../services/config.js';
import { modelValueForPayload } from '../../common/agent-model-lookups.js';
import { createAgentDispatchSetupCards } from './agent-chat-setup-cards.js';
import { createAgentConnectImportModal } from './agent-chat-connect-import-card.js';
import {
  createPrimaryAgentEditorCard,
  createPrimaryAgentNameModal,
  createSubscriptionEditorCard,
} from './agent-chat-editor-cards.js';
import {
  buildBackendSubscriptionInput,
  getAgentForSubscription,
  getSubscriptionById,
  resolveAgentEditorDirectory,
  resolveSelectedSubscriptionId,
} from './agent-chat-section-state.js';

async function loadOperatorState(selectedSubscriptionId = null) {
  const [subscriptions, agentPayload, backendConnections, runtimeConfig] = await Promise.all([
    listAgentChatSubscriptions(),
    listAgentChatAgents(),
    listAgentChatBackendConnections().catch(() => []),
    fetchConfigApi(),
  ]);
  const onboardedSubscriptions = Array.isArray(subscriptions)
    ? subscriptions.filter((subscription) => subscription?.workspaceId && subscription?.workspaceServiceNpub)
    : [];
  const subscriptionPermissions = subscriptions?.permissions;
  const effectiveSelectedSubscriptionId = resolveSelectedSubscriptionId(onboardedSubscriptions, selectedSubscriptionId);
  const selectedSubscription = getSubscriptionById(onboardedSubscriptions, effectiveSelectedSubscriptionId);
  return {
    subscriptions: onboardedSubscriptions,
    agents: Array.isArray(agentPayload?.agents) ? agentPayload.agents : [],
    permissions: subscriptionPermissions || agentPayload?.permissions || { shared: false, canManage: true },
    selectedSubscription,
    selectedSubscriptionId: effectiveSelectedSubscriptionId,
    backendConnections: Array.isArray(backendConnections) ? backendConnections : [],
    defaults: agentPayload?.defaults || {},
    runtimeConfig,
  };
}

function resolveWorkspaceLabel(subscription) {
  return subscription?.profileWorkspace?.workspace?.workspaceTitle
    || subscription?.profileWorkspace?.workspace?.workspaceId
    || subscription?.workspaceId
    || subscription?.workspaceName
    || subscription?.workspaceOwnerNpub
    || 'Workspace';
}

function createWorkspaceSelector(subscriptions, selectedSubscriptionId, onSelect) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-testid', 'agent-chat-workspace-selector');

  if (!Array.isArray(subscriptions) || subscriptions.length <= 1) {
    return wrapper;
  }

  const label = document.createElement('p');
  label.className = 'wm-settings__port-note';
  label.textContent = 'Select a workspace to configure its agent binding and dispatch routes.';

  const tabList = document.createElement('div');
  tabList.className = 'wm-settings-tabs__list';
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Agent Dispatch workspaces');

  subscriptions.forEach((subscription) => {
    const tab = document.createElement('button');
    const isSelected = subscription?.subscriptionId === selectedSubscriptionId;
    tab.type = 'button';
    tab.className = `wm-settings-tabs__tab${isSelected ? ' is-active' : ''}`;
    tab.textContent = resolveWorkspaceLabel(subscription);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    tab.setAttribute('aria-label', `Configure Agent Dispatch for ${resolveWorkspaceLabel(subscription)}`);
    tab.setAttribute('data-testid', `agent-chat-workspace-tab-${subscription?.subscriptionId || 'unknown'}`);
    tab.addEventListener('click', () => onSelect?.(subscription));
    tabList.append(tab);
  });

  wrapper.append(label, tabList);
  return wrapper;
}

export function createAgentChatSection({
  standalone = false,
  openDirectoryBrowser = null,
  initialSubscriptionId = null,
  showWorkspaceSelector = true,
} = {}) {
  const container = document.createElement('div');
  container.className = 'wm-settings__agent-chat';
  let selectedSubscriptionId = initialSubscriptionId;
  if (standalone) {
    const heading = document.createElement('h2');
    heading.textContent = 'Agent Dispatch';
    container.append(heading);
    const description = document.createElement('p');
    description.className = 'wm-settings__port-note';
    description.textContent = 'Connect each workspace separately. The same local agent can serve more than one workspace, while each subscription keeps its own source workspace, thread, task, and routes.';
    container.append(description);
  }
  const statusLine = createStatusLine();
  const setupCardsContainer = document.createElement('div');
  setupCardsContainer.setAttribute('data-testid', 'agent-chat-setup-cards');
  const workspaceSelectorContainer = document.createElement('div');
  const subscriptionEditor = createSubscriptionEditorCard();
  const connectImportModal = createAgentConnectImportModal({
    onImport: async (input) => {
      const result = await importAgentConnectPackage(input);
      selectedSubscriptionId = result?.subscription?.subscriptionId || selectedSubscriptionId;
      await refreshList();
      return result;
    },
  });
  const agentNameModal = createPrimaryAgentNameModal({
    onBrowseDirectory: openDirectoryBrowser,
    onCreate: async (defaults) => {
      if (!selectedSubscriptionId) {
        throw new Error('Select a workspace subscription before creating a binding.');
      }
      const state = await loadOperatorState(selectedSubscriptionId);
      if (!state.selectedSubscription) {
        throw new Error('Selected workspace subscription was not found.');
      }
      const created = await createAgentChatProfile({
        profileId: defaults.agentId,
        label: defaults.label,
        name: defaults.label,
        workingDirectory: defaults.workingDirectory,
        workspaceOwnerNpub: state.selectedSubscription.workspaceServiceNpub || state.selectedSubscription.workspaceOwnerNpub,
        harness: defaults.harness || 'codex',
        model: defaults.model || null,
        picture: defaults.picture || null,
        about: defaults.about || null,
        nip05: defaults.nip05 || null,
      });
      const profileId = created?.agent?.agentId;
      if (!profileId) throw new Error('Created profile did not return a stable profile ID.');
      const subscription = state.selectedSubscription;
      await saveAgentChatSubscription({
        backendConnectionId: subscription.backendConnectionId || null,
        backendBaseUrl: subscription.backendBaseUrl,
        workspaceOwnerNpub: subscription.workspaceOwnerNpub,
        workspaceId: subscription.workspaceId,
        workspaceServiceNpub: subscription.workspaceServiceNpub,
        sourceAppNpub: subscription.sourceAppNpub,
        towerServiceNpub: subscription.towerServiceNpub,
        sourceAppSchemaNamespace: subscription.sourceAppSchemaNamespace,
        agentProfileId: profileId,
      });
      await refreshList();
    },
  });
  const agentEditor = createPrimaryAgentEditorCard({ onBrowseDirectory: openDirectoryBrowser });
  let editingAgent = null;
  agentEditor.saveButton.addEventListener('click', async () => {
    const agentId = agentEditor.agentIdField.input.value.trim();
    const botNpub = agentEditor.agentBotField.input.value.trim();
    const workspaceOwnerNpub = agentEditor.agentWorkspaceField.input.value.trim();
    const workingDirectory = agentEditor.workingDirectoryField.input.value.trim();
    if (!agentId || !botNpub || !workspaceOwnerNpub || !workingDirectory) {
      statusLine.textContent = 'Agent identity, workspace identity, and an absolute working directory are required.';
      return;
    }
    if (!agentEditor.harnessSelect.value || agentEditor.harnessSelect.disabled) {
      statusLine.textContent = 'Select an available harness before saving the agent.';
      agentEditor.harnessSelect.focus();
      return;
    }
    if (agentEditor.modelSelect.disabled) {
      statusLine.textContent = 'The selected harness has no available model configuration.';
      agentEditor.modelSelect.focus();
      return;
    }
    agentEditor.saveButton.disabled = true;
    try {
      await saveAgentChatAgent({
        agentId,
        label: agentEditor.labelField.input.value.trim(),
        botNpub,
        workspaceOwnerNpub,
        workingDirectory,
        harness: agentEditor.harnessSelect.value || null,
        model: modelValueForPayload(agentEditor.modelSelect.value),
        publicProfile: {
          name: agentEditor.publicNameField.input.value.trim() || agentEditor.labelField.input.value.trim(),
          picture: agentEditor.publicPictureField.input.value.trim() || null,
          about: agentEditor.publicAboutField.input.value.trim() || null,
          nip05: agentEditor.publicNip05Field.input.value.trim() || null,
        },
        capabilities: agentEditor.capabilityPicker.getSelectedCapabilities(),
        enabled: agentEditor.enabledField.input.checked,
        archived: agentEditor.archivedField.input.checked,
        directChat: {
          enabled: agentEditor.directChatEnabledField.input.checked,
          sessionAgent: agentEditor.harnessSelect.value || null,
          directory: workingDirectory,
          model: modelValueForPayload(agentEditor.modelSelect.value),
          idleRetentionMinutes: 60,
        },
        chatPromptTemplate: agentEditor.chatPromptTemplateField.input.value,
        taskPromptTemplate: agentEditor.taskPromptTemplateField.input.value,
        flowDispatchPromptTemplate: agentEditor.flowDispatchPromptTemplateField.input.value,
        taskReviewPromptTemplate: agentEditor.taskReviewPromptTemplateField.input.value,
        approvalDispatchPromptTemplate: agentEditor.approvalDispatchPromptTemplateField.input.value,
      });
      agentEditor.close();
      statusLine.textContent = 'Agent configuration saved.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save agent configuration.';
    } finally {
      agentEditor.saveButton.disabled = false;
    }
  });
  const setupPanel = document.createElement('div');
  setupPanel.setAttribute('data-testid', 'agent-chat-setup-panel');
  const setupHeading = document.createElement('h3');
  setupHeading.textContent = 'Workspace Runtime';
  setupPanel.append(setupHeading);
  setupPanel.append(
    statusLine,
    workspaceSelectorContainer,
    setupCardsContainer,
    subscriptionEditor.card,
  );
  async function refreshList() {
    setupCardsContainer.replaceChildren();
    workspaceSelectorContainer.replaceChildren();

    try {
      const {
        subscriptions,
        agents,
        permissions,
        selectedSubscription,
        selectedSubscriptionId: effectiveSelectedSubscriptionId,
        backendConnections,
        defaults,
        runtimeConfig,
      } = await loadOperatorState(selectedSubscriptionId);
      agentNameModal.setRuntimeConfig(runtimeConfig, runtimeConfig?.defaultAgent || '');
      selectedSubscriptionId = effectiveSelectedSubscriptionId;
      const selectedAgent = getAgentForSubscription(agents, selectedSubscription);
      if (showWorkspaceSelector) {
        workspaceSelectorContainer.append(createWorkspaceSelector(
          subscriptions,
          selectedSubscriptionId,
          (subscription) => {
            selectedSubscriptionId = subscription.subscriptionId;
            statusLine.textContent = 'Loading selected workspace dispatch setup...';
            void refreshList();
          },
        ));
      }
      setupCardsContainer.append(createAgentDispatchSetupCards({
        subscription: selectedSubscription,
        primaryAgent: selectedAgent,
        canManage: permissions?.canManage !== false,
        shared: permissions?.shared === true,
        availableBackendConnections: backendConnections,
        onConnectWorkspace: () => connectImportModal.open(),
        onEditSubscription: (subscription) => {
          subscriptionEditor.workspaceOwnerField.input.value = subscription?.workspaceOwnerNpub || '';
          subscriptionEditor.backendUrlField.input.value = subscription?.backendBaseUrl || '';
          subscriptionEditor.sourceAppField.input.value = subscription?.sourceAppNpub || '';
          subscriptionEditor.card.style.display = '';
          subscriptionEditor.workspaceOwnerField.input.focus();
        },
        onUseBackendConnection: async (backendConnection) => {
          statusLine.textContent = 'Creating workspace subscription...';
          const subscription = await saveAgentChatSubscription(buildBackendSubscriptionInput(backendConnection));
          selectedSubscriptionId = subscription?.subscriptionId || selectedSubscriptionId;
          statusLine.textContent = 'Workspace subscription created.';
          await refreshList();
        },
        onSaveBackendAvailability: async (backendConnection, input) => (
          saveAgentChatBackendConnectionAvailability(backendConnection.backendConnectionId, input)
        ),
        onCreateAgent: () => agentNameModal.open(selectedSubscription?.profileWorkspace?.workspace?.workspaceTitle || ''),
        onRepublishAgent: async (agent) => {
          statusLine.textContent = 'Republishing public agent profile...';
          await republishAgentChatProfile(agent.agentId);
          statusLine.textContent = 'Public agent profile republished without changing identity.';
        },
        onEditAgent: (agent) => {
          editingAgent = agent;
          agentEditor.agentIdField.input.value = agent.agentId || '';
          agentEditor.agentIdField.input.readOnly = true;
          agentEditor.agentBotField.input.readOnly = true;
          agentEditor.labelField.input.value = agent.label || '';
          agentEditor.publicNameField.input.value = agent.publicProfile?.name || agent.label || '';
          agentEditor.publicPictureField.input.value = agent.publicProfile?.picture || '';
          agentEditor.publicAboutField.input.value = agent.publicProfile?.about || '';
          agentEditor.publicNip05Field.input.value = agent.publicProfile?.nip05 || '';
          agentEditor.workingDirectoryField.input.value = resolveAgentEditorDirectory(agent);
          agentEditor.chatPromptTemplateField.input.value = agent.chatPromptTemplate || defaults.chatPromptTemplate || '';
          agentEditor.taskPromptTemplateField.input.value = agent.taskPromptTemplate || defaults.taskPromptTemplate || '';
          agentEditor.flowDispatchPromptTemplateField.input.value = agent.flowDispatchPromptTemplate || defaults.flowDispatchPromptTemplate || '';
          agentEditor.taskReviewPromptTemplateField.input.value = agent.taskReviewPromptTemplate || defaults.taskReviewPromptTemplate || '';
          agentEditor.approvalDispatchPromptTemplateField.input.value = agent.approvalDispatchPromptTemplate || defaults.approvalDispatchPromptTemplate || '';
          agentEditor.capabilityPicker.setSelectedCapabilities(agent.capabilities);
          agentEditor.enabledField.input.checked = agent.enabled !== false;
          agentEditor.archivedField.input.checked = agent.archived === true;
          agentEditor.directChatEnabledField.input.checked = agent.directChat?.enabled !== false;
          agentEditor.applyInheritedIdentity(selectedSubscription);
          agentEditor.setRuntimeConfig(
            runtimeConfig,
            agent.harness || agent.directChat?.sessionAgent || '',
            agent.model || agent.directChat?.model || '',
          );
          agentEditor.open();
          agentEditor.labelField.input.focus();
        },
        onRefresh: refreshList,
      }));
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to load Agent Dispatch state.';
    }
  }
  subscriptionEditor.saveButton.addEventListener('click', async () => {
    const workspaceOwnerNpub = subscriptionEditor.workspaceOwnerField.input.value.trim();
    const backendBaseUrl = subscriptionEditor.backendUrlField.input.value.trim();
    const sourceAppNpub = subscriptionEditor.sourceAppField.input.value.trim();
    if (!workspaceOwnerNpub || !backendBaseUrl || !sourceAppNpub) {
      statusLine.textContent = 'Workspace owner, backend URL, and source app are required.';
      return;
    }
    subscriptionEditor.saveButton.disabled = true;
    statusLine.textContent = 'Saving workspace subscription...';
    try {
      const subscription = await saveAgentChatSubscription({
        workspaceOwnerNpub,
        backendBaseUrl,
        sourceAppNpub,
      });
      selectedSubscriptionId = subscription?.subscriptionId || selectedSubscriptionId;
      subscriptionEditor.card.style.display = 'none';
      statusLine.textContent = 'Workspace subscription saved.';
      await refreshList();
    } catch (error) {
      statusLine.textContent = error instanceof Error ? error.message : 'Failed to save workspace subscription.';
    } finally {
      subscriptionEditor.saveButton.disabled = false;
    }
  });
  subscriptionEditor.closeButton.addEventListener('click', () => {
    subscriptionEditor.card.style.display = 'none';
  });
  container.append(setupPanel);
  container.append(connectImportModal.element, agentNameModal.element, agentEditor.card);
  void refreshList();
  return container;
}
