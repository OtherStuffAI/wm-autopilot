import {
  deleteAgentChatSubscription,
  importAgentConnectPackage,
  listAgentChatAgents,
  listAgentChatBackendConnections,
  listAgentChatSubscriptions,
  runAgentChatSubscriptionAction,
  saveAgentChatProfileWorkspace,
} from '../../services/agent-chat.js';
import { createAgentConnectImportModal } from './agent-chat-connect-import-card.js';
import { createAgentChatSection } from './agent-chat-section.js';
import {
  createFlightDeckDispatchCard,
} from './flight-deck-section.js';
import { getWorkspaceSettingsPath, resolveSettingsRoute } from '../settings-routes.js';
import { createWorkspaceLifecycleSection } from './workspace-lifecycle-section.js';
import {
  getWorkspaceHealthLabel,
  isRevokedWorkspaceSubscription,
} from './workspace-settings-state.js';

const SUBVIEWS = [
  ['overview', 'Overview'],
  ['agent', 'Agent'],
  ['routing', 'Routing'],
  ['advanced', 'Advanced diagnostics'],
];

function workspaceTitle(subscription) {
  return subscription?.profileWorkspace?.workspace?.workspaceTitle
    || subscription?.profileWorkspace?.workspace?.workspaceId
    || subscription?.workspaceId
    || subscription?.workspaceName
    || 'Workspace';
}

function towerHost(subscription, backendConnection) {
  const raw = subscription?.backendBaseUrl || backendConnection?.backendBaseUrl || '';
  try {
    return new URL(raw).host;
  } catch {
    return raw || 'Tower host unavailable';
  }
}

function healthLabel(subscription) {
  return getWorkspaceHealthLabel(subscription);
}

function agentForSubscription(subscription, agents) {
  const workspaceNpub = subscription?.workspaceServiceNpub || subscription?.workspaceOwnerNpub;
  return agents.find((agent) => agent?.workspaceOwnerNpub === workspaceNpub && agent?.botNpub === subscription?.botNpub) || null;
}

function backendForSubscription(subscription, connections) {
  return connections.find((connection) => connection?.backendConnectionId === subscription?.backendConnectionId) || null;
}

function createStatus(message, tone = '') {
  const status = document.createElement('p');
  status.className = `wm-settings-workspaces__status${tone ? ` is-${tone}` : ''}`;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = message;
  return status;
}

function createFact(label, value, detail = '') {
  const item = document.createElement('div');
  item.className = 'wm-settings-workspaces__fact';
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value || 'Unavailable';
  if (detail) description.title = detail;
  item.append(term, description);
  return item;
}

function createOverview(subscription, backendConnection, agent) {
  const wrapper = document.createElement('div');
  const facts = document.createElement('dl');
  facts.className = 'wm-settings-workspaces__facts';
  facts.append(
    createFact('Backend connection', backendConnection ? 'Available to this viewer' : 'Connection details unavailable'),
    createFact('Workspace subscription', isRevokedWorkspaceSubscription(subscription) ? 'Access revoked' : healthLabel(subscription)),
    createFact('Tower host', towerHost(subscription, backendConnection)),
    createFact('Bound local agent', agent?.label || agent?.agentId || 'No local agent bound'),
    createFact('Direct chat', agent?.directChat?.enabled === false ? 'Disabled' : agent ? 'Enabled' : 'Not configured'),
    createFact('Last activity', subscription?.lastEventPollOkAt || subscription?.lastAuthOkAt || 'No activity recorded'),
  );
  const identities = document.createElement('details');
  identities.className = 'wm-settings-disclosure';
  const summary = document.createElement('summary');
  summary.textContent = 'Raw identities';
  const raw = document.createElement('dl');
  raw.className = 'wm-settings-workspaces__facts';
  raw.append(
    createFact('Subscription id', subscription?.subscriptionId),
    createFact('Workspace id', subscription?.workspaceId),
    createFact('Workspace service', subscription?.workspaceServiceNpub),
    createFact('Human workspace owner', subscription?.workspaceOwnerNpub),
    createFact('Source app', subscription?.sourceAppNpub),
    createFact('Agent/bot actor', subscription?.botNpub),
  );
  identities.append(summary, raw);
  wrapper.append(facts, identities);
  return wrapper;
}

function createSubviewNav(subscriptionId, activeSubview, onNavigate) {
  const nav = document.createElement('nav');
  nav.className = 'wm-settings-workspaces__subnav';
  nav.setAttribute('aria-label', 'Workspace settings');
  SUBVIEWS.forEach(([id, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = id === activeSubview ? 'is-active' : '';
    button.setAttribute('aria-current', id === activeSubview ? 'page' : 'false');
    button.setAttribute('aria-label', `Open ${label} for selected workspace`);
    button.dataset.testid = `workspace-subview-${id}`;
    button.addEventListener('click', () => onNavigate(subscriptionId, id));
    nav.append(button);
  });
  return nav;
}

async function fetchPipelineDefinitions() {
  const response = await fetch('/api/pipelines/definitions', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Pipeline routes could not be loaded.');
  return Array.isArray(payload.definitions) ? payload.definitions : [];
}

export function createWorkspaceSettingsSection({ openDirectoryBrowser = null } = {}) {
  const container = document.createElement('div');
  container.className = 'wm-settings-workspaces';
  container.dataset.testid = 'workspace-settings-section';
  let data = null;
  let selectedSubscriptionId = null;
  let selectedSubview = 'overview';
  let actionMessage = '';

  const connectModal = createAgentConnectImportModal({
    onImport: async (input) => {
      const result = await importAgentConnectPackage(input);
      selectedSubscriptionId = result?.subscription?.subscriptionId || selectedSubscriptionId;
      selectedSubview = 'overview';
      await refresh();
      navigate(selectedSubscriptionId, selectedSubview, { replace: true });
      return result;
    },
  });

  function readRoute() {
    if (typeof window === 'undefined') return;
    const route = resolveSettingsRoute(window.location.pathname);
    selectedSubscriptionId = route.subscriptionId;
    selectedSubview = route.subview;
  }

  function navigate(subscriptionId, subview, { replace = false } = {}) {
    selectedSubscriptionId = subscriptionId || null;
    selectedSubview = subview || 'overview';
    if (typeof window !== 'undefined') {
      const path = getWorkspaceSettingsPath(selectedSubscriptionId || '', selectedSubview);
      window.history[replace ? 'replaceState' : 'pushState'](
        { route: 'settings', settingsPage: 'workspaces', subscriptionId, subview },
        '',
        path,
      );
    }
    renderData();
  }

  async function saveRouting(subscription, input) {
    const profileWorkspace = await saveAgentChatProfileWorkspace(subscription.subscriptionId, input);
    data.subscriptions = data.subscriptions.map((candidate) => candidate.subscriptionId === subscription.subscriptionId
      ? { ...candidate, profileWorkspace }
      : candidate);
    actionMessage = 'Routing settings saved.';
    renderData();
  }

  async function runLifecycle(subscription, action) {
    actionMessage = `${action === 'reconnect' ? 'Reconnecting' : action === 'disable' ? 'Disabling' : 'Enabling'} workspace subscription…`;
    renderData();
    try {
      const updated = await runAgentChatSubscriptionAction(subscription.subscriptionId, action);
      if (updated) data.subscriptions = data.subscriptions.map((candidate) => candidate.subscriptionId === updated.subscriptionId ? updated : candidate);
      actionMessage = action === 'disable'
        ? 'Subscription disabled. The backend connection, routes and local agent remain saved.'
        : action === 'enable'
          ? 'Subscription enabled and its event connection was repaired.'
          : 'Subscription event connection reconnected.';
    } catch (error) {
      actionMessage = error?.message || `Failed to ${action} subscription.`;
    }
    renderData();
  }

  async function removeSubscription(subscription) {
    const flightDeckDiscovered = subscription?.onboardingSource === 'nostr_33357';
    const confirmed = window.confirm(flightDeckDiscovered
      ? 'Disconnect this workspace locally? This stops and hides the local subscription and ignores older discovery events. It does not change Tower membership, delete the Tower workspace, or delete the local agent.'
      : 'Remove this local workspace subscription? This removes its local routes and binding reference. It does not delete the Tower workspace, backend connection, or local agent.');
    if (!confirmed) return;
    try {
      await deleteAgentChatSubscription(subscription.subscriptionId);
      actionMessage = flightDeckDiscovered
        ? 'Workspace disconnected locally. Tower membership and the local agent were not deleted.'
        : 'Local workspace subscription and its routes removed. The backend connection and local agent were not deleted.';
      selectedSubscriptionId = null;
      await refresh();
      navigate('', 'overview', { replace: true });
    } catch (error) {
      actionMessage = error?.message || 'Failed to remove the local subscription.';
      renderData();
    }
  }

  function renderSelected(subscription) {
    const detail = document.createElement('section');
    detail.className = 'wm-card wm-settings-workspaces__detail';
    detail.dataset.testid = `workspace-detail-${subscription.subscriptionId}`;
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = workspaceTitle(subscription);
    const status = createStatus(healthLabel(subscription), isRevokedWorkspaceSubscription(subscription) ? 'danger' : '');
    header.append(title, status);
    detail.append(header, createSubviewNav(subscription.subscriptionId, selectedSubview, navigate));
    const body = document.createElement('div');
    body.className = 'wm-settings-workspaces__detail-body';
    const agent = agentForSubscription(subscription, data.agents);
    if (selectedSubview === 'agent') {
      body.append(createAgentChatSection({
        openDirectoryBrowser,
        initialSubscriptionId: subscription.subscriptionId,
        showWorkspaceSelector: false,
      }));
    } else if (selectedSubview === 'routing') {
      if (data.canManage === false) {
        body.append(createManagedNotice());
      }
      body.append(createFlightDeckDispatchCard({
        subscription,
        pipelineDefinitions: data.pipelineDefinitions,
        workspaceTitle: workspaceTitle(subscription),
        canManage: data.canManage,
        onSaveProfileWorkspace: saveRouting,
      }));
    } else if (selectedSubview === 'advanced') {
      body.append(createWorkspaceLifecycleSection({
        subscription,
        canManage: data.canManage,
        actionMessage,
        onAction: (action) => void runLifecycle(subscription, action),
        onRemove: () => void removeSubscription(subscription),
      }));
    } else {
      body.append(createOverview(subscription, backendForSubscription(subscription, data.backendConnections), agent));
    }
    detail.append(body);
    return detail;
  }

  function createManagedNotice() {
    const notice = document.createElement('div');
    notice.className = 'wm-settings-workspaces__notice';
    notice.setAttribute('role', 'note');
    notice.textContent = 'Managed by administrator — you can inspect the effective shared dispatch policy, but only an administrator can change it.';
    return notice;
  }

  function renderData() {
    if (!data) return;
    const content = document.createElement('div');
    const toolbar = document.createElement('div');
    toolbar.className = 'wm-settings-page__actions';
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'wm-button';
    connect.textContent = 'Connect workspace';
    connect.setAttribute('aria-label', 'Connect a Flight Deck workspace with AgentConnect');
    connect.dataset.testid = 'workspace-connect';
    connect.disabled = data.canManage === false;
    connect.addEventListener('click', () => connectModal.open());
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'wm-button secondary';
    reload.textContent = 'Refresh';
    reload.setAttribute('aria-label', 'Refresh workspace connection state');
    reload.addEventListener('click', () => void refresh());
    toolbar.append(connect, reload);
    content.append(toolbar);
    if (data.partialErrors.length) content.append(createStatus(`Some workspace details could not be refreshed: ${data.partialErrors.join(' ')}`, 'danger'));
    if (data.canManage === false) content.append(createManagedNotice());

    if (data.subscriptions.length === 0) {
      const empty = document.createElement('section');
      empty.className = 'wm-card wm-settings-workspaces__empty';
      empty.dataset.testid = 'workspace-empty-state';
      const heading = document.createElement('h2');
      heading.textContent = 'No workspace subscriptions';
      const note = document.createElement('p');
      note.textContent = 'Connect a Flight Deck workspace to receive eligible events. A local agent may serve more than one subscription.';
      empty.append(heading, note);
      content.append(empty);
    } else {
      const layout = document.createElement('div');
      layout.className = 'wm-settings-workspaces__layout';
      const list = document.createElement('nav');
      list.className = 'wm-settings-workspaces__list';
      list.setAttribute('aria-label', 'Connected workspaces');
      data.subscriptions.forEach((subscription) => {
        const agent = agentForSubscription(subscription, data.agents);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = subscription.subscriptionId === selectedSubscriptionId ? 'is-active' : '';
        button.dataset.testid = `workspace-select-${subscription.subscriptionId}`;
        button.setAttribute('aria-current', subscription.subscriptionId === selectedSubscriptionId ? 'page' : 'false');
        const name = document.createElement('strong');
        name.textContent = workspaceTitle(subscription);
        const host = document.createElement('span');
        host.textContent = towerHost(subscription, backendForSubscription(subscription, data.backendConnections));
        const facts = document.createElement('span');
        facts.textContent = `${healthLabel(subscription)} · ${agent?.label || agent?.agentId || 'No agent'} · Direct chat ${agent?.directChat?.enabled === false ? 'off' : agent ? 'on' : 'not configured'} · ${subscription?.lastEventPollOkAt || 'No activity'}`;
        button.append(name, host, facts);
        button.addEventListener('click', () => navigate(subscription.subscriptionId, 'overview'));
        list.append(button);
      });
      layout.append(list);
      const selected = data.subscriptions.find((subscription) => subscription.subscriptionId === selectedSubscriptionId);
      if (selected) layout.append(renderSelected(selected));
      else if (selectedSubscriptionId) layout.append(createStatus('The linked workspace subscription was not found. It may have been removed or is not visible to this account.', 'danger'));
      else layout.append(createStatus('Select a workspace to inspect its connection, agent, routing and diagnostics.'));
      content.append(layout);
    }
    container.replaceChildren(content, connectModal.element);
  }

  async function refresh() {
    container.replaceChildren(createStatus('Loading workspace subscriptions…'));
    container.setAttribute('aria-busy', 'true');
    readRoute();
    try {
      const [subscriptions, agents, connections, pipelines] = await Promise.allSettled([
        listAgentChatSubscriptions(),
        listAgentChatAgents(),
        listAgentChatBackendConnections(),
        fetchPipelineDefinitions(),
      ]);
      if (subscriptions.status === 'rejected') throw subscriptions.reason;
      const values = subscriptions.value;
      data = {
        subscriptions: Array.isArray(values) ? values.filter((item) => item?.subscriptionId) : [],
        canManage: values.permissions?.canManage !== false,
        agents: agents.status === 'fulfilled' ? agents.value.agents : [],
        backendConnections: connections.status === 'fulfilled' ? connections.value : [],
        pipelineDefinitions: pipelines.status === 'fulfilled' ? pipelines.value : [],
        partialErrors: [agents, connections, pipelines]
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason?.message || 'A related request failed.'),
      };
      renderData();
    } catch (error) {
      container.replaceChildren(createStatus(error?.message || 'Failed to load workspace subscriptions.', 'danger'));
    } finally {
      container.setAttribute('aria-busy', 'false');
    }
  }

  void refresh();
  return container;
}
