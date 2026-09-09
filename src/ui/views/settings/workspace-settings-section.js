import { randomId } from "../../core/random-id.js";
import { createTowerTransportCard } from './tower-transport-card.js';
import Alpine from '/vendor/alpinejs/module.esm.js';
import {
  deleteAgentChatSubscription, importAgentConnectPackage, listAgentChatAgents,
  listAgentChatBackendConnections, listAgentChatSubscriptions, runAgentChatSubscriptionAction,
} from '../../services/agent-chat.js';
import { createAgentConnectImportModal } from './agent-chat-connect-import-card.js';
import { getWorkspaceSettingsPath, resolveSettingsRoute } from '../settings-routes.js';
import { createButton } from './agent-chat-shared-ui.js';
import { buildWorkspaceSettingsModel } from './workspace-settings-model.js';
import { createWorkspaceDetails, disclosure, element } from './workspace-settings-details.js';
import { workspaceSettingsDb, Dexie } from './workspace-settings-db.js';

Alpine.data('workspaceSettingsView', () => ({
  snapshot: null,
  init() {
    const host = this.$el;
    this.$watch('snapshot', (value) => { if (value) host.renderWorkspaceSnapshot(value); });
    this.query = Dexie.liveQuery(() => workspaceSettingsDb.views.get(host.dataset.viewId)).subscribe({
      next: (value) => { this.snapshot = value || null; },
      error: (error) => host.workspaceError(error),
    });
    host.refreshWorkspace();
  },
  destroy() {
    this.query?.unsubscribe();
    this.$el.stopWorkspaceRefresh();
    void workspaceSettingsDb.views.delete(this.$el.dataset.viewId);
  },
}));

export function createWorkspaceSettingsSection() {
  const container = element('div', '', 'wm-workspaces-page');
  const viewId = randomId();
  container.dataset.testid = 'workspace-settings-section';
  container.dataset.viewId = viewId;
  container.setAttribute('x-data', 'workspaceSettingsView');
  const status = element('p', 'Loading workspaces…', 'wm-workspace-note');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'workspace-status';
  const body = element('div');
  const route = resolveSettingsRoute(globalThis.location?.pathname || '');
  let selectedId = route.subscriptionId;
  let busy = false;
  let refreshing = false;
  let stopped = false;
  let timer = null;
  const modal = createAgentConnectImportModal({ onImport: async (input) => {
    const result = await importAgentConnectPackage(input);
    selectedId = result.subscription?.subscriptionId || null;
    await refresh();
    return result;
  } });
  container.append(status, body, modal.element);

  function showError(error) {
    status.textContent = error?.message || 'Workspace settings could not be loaded.';
    status.className = 'wm-workspace-error';
  }

  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    container.setAttribute('aria-busy', 'true');
    try {
      const results = await Promise.allSettled([listAgentChatSubscriptions(), listAgentChatAgents(), listAgentChatBackendConnections()]);
      const [subscriptions, agents, connections] = results;
      // Keep the previous snapshot intact if any source fails; never replace memberships with an empty list.
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const servers = buildWorkspaceSettingsModel(subscriptions.value, agents.value, connections.value);
      const transportDrafts = await workspaceSettingsDb.transportDrafts.toArray();
      if (!stopped) await workspaceSettingsDb.views.put({ id: viewId, syncedAt: Date.now(), servers, transportDrafts,
        canManage: subscriptions.value.permissions?.canManage === true });
      status.textContent = 'Updated just now. Nostr-discovered connections appear automatically.';
      status.className = 'wm-workspace-note';
      return true;
    } catch (error) { showError(error); return false; }
    finally {
      refreshing = false;
      container.setAttribute('aria-busy', 'false');
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => { if (container.isConnected) void refresh(); }, 30000);
    }
  }

  async function runAction(subscription, action) {
    if (busy) return;
    busy = true;
    await renderCached();
    status.textContent = 'Updating connection…';
    try {
      if (action === 'remove') await deleteAgentChatSubscription(subscription.subscriptionId);
      else await runAgentChatSubscriptionAction(subscription.subscriptionId, action);
      const refreshed = await refresh();
      if (refreshed) status.textContent = action === 'remove' ? 'Disconnected locally. Workspace membership and bot profiles are unchanged.' : 'Connection updated.';
    } catch (error) { showError(error); }
    finally { busy = false; await renderCached(); }
  }

  async function transportAction(id, action, transport) {
    if (busy) return;
    busy = true;
    status.textContent = action === 'test' ? 'Testing Tower connection…' : 'Applying Tower transport…';
    try {
      const response = await fetch(`/api/agent-chat/backend-connections/${encodeURIComponent(id)}/transport${action === 'test' ? '/test' : ''}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transport }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Tower transport operation failed');
      if (action === 'save') await workspaceSettingsDb.transportDrafts.delete(id);
      await refresh();
      status.textContent = action === 'test' ? 'Tower identity and workspace access verified.' : 'Tower transport applied.';
    } catch (error) { showError(error); }
    finally { busy = false; await renderCached(); }
  }

  function remove(subscription) {
    if (globalThis.confirm('Disconnect this local connection? Events for this connection will stop. Tower workspace membership and bot profiles will remain.')) {
      void runAction(subscription, 'remove');
    }
  }

  async function renderCached() {
    const snapshot = await workspaceSettingsDb.views.get(viewId);
    if (snapshot) snapshot.transportDrafts = await workspaceSettingsDb.transportDrafts.toArray();
    if (snapshot) render(snapshot);
  }

  function select(workspace) {
    selectedId = workspace.subscriptions[0].subscriptionId;
    globalThis.history?.replaceState({}, '', getWorkspaceSettingsPath(selectedId));
    void renderCached();
  }

  function render(snapshot) {
    const toolbar = element('div', '', 'wm-settings-page__actions');
    const connect = createButton('Paste AgentConnect', 'workspace-connect', 'Paste AgentConnect from Flight Deck');
    connect.disabled = !snapshot.canManage || busy;
    connect.addEventListener('click', () => modal.open());
    const reload = createButton('Refresh', 'workspace-refresh', 'Refresh servers and workspaces');
    reload.disabled = busy;
    reload.addEventListener('click', () => void refresh());
    toolbar.append(connect, reload);
    const intro = element('p', 'Add bots to workspaces in Flight Deck. Autopilot picks up trusted Nostr announcements, or you can paste AgentConnect here.', 'wm-workspace-note');
    const layout = element('div', '', 'wm-workspaces-layout');
    const nav = element('nav', '', 'wm-workspace-tree');
    nav.setAttribute('aria-label', 'Servers and workspaces');
    const workspaces = snapshot.servers.flatMap((server) => server.workspaces);
    const selected = workspaces.find((workspace) => workspace.subscriptions.some((item) => item.subscriptionId === selectedId))
      || (!selectedId ? workspaces[0] : null);
    for (const server of snapshot.servers) {
      const group = element('section', '', 'wm-workspace-server');
      group.append(element('h2', server.label), element('small', `${server.workspaces.length} workspace${server.workspaces.length === 1 ? '' : 's'}`));
      for (const workspace of server.workspaces) {
        const button = createButton('', `workspace-select-${workspace.subscriptions[0].subscriptionId}`, `Open ${workspace.name} on ${server.label}`);
        button.className = `wm-workspace-select${workspace === selected ? ' is-active' : ''}`;
        button.setAttribute('aria-current', workspace === selected ? 'page' : 'false');
        button.append(element('strong', workspace.name), element('span', `${workspace.bots.length} bot${workspace.bots.length === 1 ? '' : 's'} · ${[...new Set(workspace.subscriptions.map((item) => item.health))].join(' / ')}`));
        button.addEventListener('click', () => select(workspace));
        group.append(button);
      }
      nav.append(group);
    }
    if (selected) layout.append(nav, createWorkspaceDetails(selected, { canManage: snapshot.canManage, busy, onAction: runAction, onRemove: remove }));
    else if (workspaces.length) layout.append(nav, element('p', 'The linked workspace is no longer available. Select a workspace.', 'wm-workspace-error'));
    else {
      const empty = element('section', '', 'wm-card wm-workspace-detail');
      empty.dataset.testid = 'workspace-empty-state';
      empty.append(element('h2', 'No connected workspaces'), element('p', 'Add a bot to a workspace in Flight Deck, or paste AgentConnect to get started.'));
      layout.append(empty);
    }
    const access = disclosure('Access & dispatch rules', 'workspace-access-rules');
    access.append(element('p', 'Nostr onboarding accepts grants from trusted Autopilot users: admins and users marked approved or onboard. Admin-only dispatch mode restricts the issuer check to admins.'),
      element('p', 'Tower controls workspace and conversation visibility. A local bot must be enabled, support Agent Direct, and be addressed (or be the recipient of a two-party DM).'),
      element('p', 'Current limitation: Agent Direct does not apply the local sender whitelist check used by pipeline dispatch. Workspace access and bot eligibility checks still apply.', 'wm-workspace-error'));
    const sameWorkspace = body.dataset.workspace === selected?.key;
    const openPanels = sameWorkspace ? [...body.querySelectorAll('details[open] > summary')].map((summary) => summary.dataset.testid) : [];
    const focusedId = body.contains(document.activeElement) ? document.activeElement.dataset.testid : null;
    body.replaceChildren(toolbar, intro, layout, access);
    if (selected?.towerConnection) body.append(createTowerTransportCard(selected.towerConnection, {
      canManage: snapshot.canManage && selected.towerConnection.canManageTransport && !busy, onAction: transportAction,
      draft: snapshot.transportDrafts?.find((row) => row.id === selected.towerConnection.backendConnectionId)?.transport,
      onDraft: (transport) => workspaceSettingsDb.transportDrafts.put({ id: selected.towerConnection.backendConnectionId, transport }),
    }));
    body.dataset.workspace = selected?.key || '';
    for (const summary of body.querySelectorAll('details > summary')) {
      if (openPanels.includes(summary.dataset.testid)) summary.parentElement.open = true;
    }
    if (focusedId) {
      [...body.querySelectorAll('[data-testid]')].find((node) => node.dataset.testid === focusedId)?.focus();
    }
    if (!snapshot.canManage) body.prepend(element('p', 'Read-only access. Connection changes require an authorized Autopilot user.', 'wm-workspace-note'));
  }
  container.renderWorkspaceSnapshot = render;
  container.workspaceError = showError;
  container.refreshWorkspace = refresh;
  container.stopWorkspaceRefresh = () => { stopped = true; clearTimeout(timer); };
  return container;
}
