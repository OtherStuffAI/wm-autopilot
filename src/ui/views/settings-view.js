import { createSettingsTabs } from './settings-tabs.js';
import {
  getSettingsPathForTab,
  resolveSettingsRoute,
} from './settings-routes.js';
import {
  createApiKeysSection,
  createGitHubSection,
  createGiteaSection,
  createHostedAppRoutingSection,
  createSpeechSettingsSection,
} from './settings/workspace-sections.js';
import { createDefaultAgentSection } from './settings/profile-sections.js';
import { createTeamBillingSection } from './settings/admin-billing-section.js';
import { createWorkspaceSettingsSection } from './settings/workspace-settings-section.js';
import { createRemoteInstructSection } from './settings/remote-instruct-section.js';
import { createInstanceSettingsSection } from './settings/instance-settings-section.js';
import { createInstanceBrandingSection } from '../branding/instance-branding.js';
import { createModelsSettingsSection } from './settings/models-settings-section.js';
import { getSettingsNavigationItems } from './settings-navigation.js';
import { createSettingsCard, createSettingsGrid } from './settings-layout.js';
import { createTerminalSecuritySection } from './settings/terminal-security-section.js';
import { createAgentProfilesSection } from './settings/agent-profiles-section.js';
import { createRestartSettingsSection } from './settings/restart-settings-section.js';
import { createSigningPoliciesSection } from './settings/signing-policies-section.js';

const PAGE_COPY = Object.freeze({
  profile: ['Profile', 'Your identity, sign-in state and default launch agent.'],
  credentials: ['Credentials', 'Personal AI, tool and developer account credentials. Secret values are never displayed.'],
  speech: ['Speech', 'Speech provider settings and generated Flight Deck reply audio.'],
  workspaces: ['Workspaces', 'Connect Flight Deck workspaces and manage their local agent, routing and diagnostics.'],
  agentProfiles: ['Agent Profiles', 'Create and manage sovereign local agent identities independently of workspace connections.'],
  remote: ['Remote Instruct', 'Control the context added to remote instructions and review its supported variables.'],
  models: ['Models', 'Choose and order the OpenRouter models offered when launching compatible agents.'],
  hosting: ['App Hosting', 'Instance routing defaults and the web app ports assigned to your account.'],
  restart: ['Restart', 'Restart Autopilot with one consistent session recovery policy.'],
  system: ['System', 'Encrypted instance settings, effective sources and environment migration tools.'],
  access: ['Users & Access', 'Approved users, nicknames, access state and administrator port allocation.'],
  billing: ['Billing', 'Team credit allocation, markup and recent usage.'],
  appearance: ['Appearance', 'Autopilot name, branding and accent colour.'],
  flags: ['Feature Flags', 'Experimental capabilities and rollout state.'],
  starter: ['Starter Projects', 'Templates made available when users create projects.'],
  signingPolicies: ['Signing Policies', 'Review assigned signing authority, immutable revisions and active capability state.'],
});

function createPage(pageId, ...content) {
  const page = document.createElement('div');
  page.className = 'wm-settings-page';
  page.dataset.testid = `settings-page-${pageId}`;
  const header = document.createElement('header');
  header.className = 'wm-settings-page__header';
  const title = document.createElement('h1');
  title.textContent = PAGE_COPY[pageId]?.[0] || 'Settings';
  const purpose = document.createElement('p');
  purpose.textContent = PAGE_COPY[pageId]?.[1] || '';
  header.append(title, purpose);
  page.append(header, ...content.filter(Boolean));
  return page;
}

function createManagedCard(title, message) {
  const card = document.createElement('section');
  card.className = 'wm-card wm-settings-managed-card';
  card.setAttribute('role', 'status');
  const heading = document.createElement('h2');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = message;
  card.append(heading, copy);
  return card;
}

function createDestinationLink(label, href, testId) {
  const link = document.createElement('a');
  link.className = 'wm-button secondary';
  link.href = href;
  link.textContent = label;
  link.setAttribute('aria-label', label);
  link.dataset.testid = testId;
  return link;
}

export function initSettingsView(deps) {
  const {
    state,
    render,
    normalisePortList,
    generateAdminPorts,
    renderIdentityPanel,
    renderFeatureFlagsPanel,
    ensureFeatureFlagsLoaded,
    renderAdminUsersPanel,
    fetchAdminUsers,
    ensureStarterProjectsLoaded,
    renderStarterProjectsPanel,
    openDirectoryBrowser,
    refreshBranding,
    refreshConfig,
    showToast,
    appsStore,
    triggerRestart,
  } = deps;

  function renderAssignedPortsSection({ allocationActions = false } = {}) {
    const card = document.createElement('section');
    card.className = 'wm-card';
    const heading = document.createElement('h2');
    heading.textContent = 'Assigned web app ports';
    const list = document.createElement('ul');
    list.className = 'wm-settings__port-list';
    const ports = Array.isArray(state.identity.ports) ? normalisePortList(state.identity.ports) : [];
    (ports.length ? ports : [null]).forEach((port) => {
      const item = document.createElement('li');
      if (port === null) {
        item.className = 'wm-settings__port-empty';
        item.textContent = state.identity.authenticated
          ? 'No ports are currently assigned.'
          : 'Sign in to view your assigned ports.';
      } else {
        const code = document.createElement('code');
        code.textContent = String(port);
        item.append(code);
      }
      list.append(item);
    });
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = 'These ports are allocations only. Start, stop, restart, deploy and domain controls remain in Apps.';
    card.append(heading, list, note);

    if (state.identity.isAdmin && allocationActions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wm-button secondary';
      button.textContent = 'Generate 3 more ports';
      button.setAttribute('aria-label', 'Generate three more ports for the administrator');
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Generating…';
        const result = await generateAdminPorts(3);
        if (result?.success) render();
        else {
          button.disabled = false;
          button.textContent = 'Generate 3 more ports';
          showToast(result?.error || 'Failed to generate ports', { type: 'error' });
        }
      });
      const actions = document.createElement('div');
      actions.className = 'wm-settings__ports-admin-actions';
      actions.append(button);
      card.append(actions);
    }
    return card;
  }

  function renderProfilePage() {
    return createPage('profile', renderIdentityPanel({
      variant: 'settings',
      summaryAside: createDefaultAgentSection({ state }),
    }));
  }

  function renderCredentialsPage() {
    const content = [];
    if (!state.identity.authenticated) {
      content.push(createManagedCard('Sign in required', 'Sign in to inspect or update personal credentials.'));
      return createPage('credentials', ...content);
    }
    content.push(
      createSettingsCard(createApiKeysSection(), { testId: 'settings-credentials-api-keys' }),
      createSettingsCard(createGitHubSection(), { testId: 'settings-credentials-github' }),
    );
    const giteaLoading = document.createElement('p');
    giteaLoading.className = 'wm-settings__port-note';
    giteaLoading.setAttribute('role', 'status');
    giteaLoading.textContent = 'Loading Gitea connection…';
    const giteaPlaceholder = createSettingsCard(giteaLoading, {
      testId: 'settings-credentials-gitea',
    });
    content.push(giteaPlaceholder);
    fetch('/api/config')
      .then((response) => response.json())
      .then((config) => {
        if (config.giteaUrl) {
          giteaPlaceholder.replaceWith(createSettingsCard(createGiteaSection(config.giteaUrl), {
            testId: 'settings-credentials-gitea',
          }));
        } else {
          giteaPlaceholder.replaceWith(createManagedCard('Gitea', 'No Gitea service is configured for this instance.'));
        }
      })
      .catch(() => giteaPlaceholder.replaceWith(createManagedCard('Gitea', 'Gitea connection state could not be loaded.')));
    return createPage('credentials', createSettingsGrid('credentials', ...content));
  }

  function renderSpeechPage() {
    return createPage('speech', state.identity.authenticated
      ? createSpeechSettingsSection()
      : createManagedCard('Sign in required', 'Sign in to manage personal speech settings.'));
  }

  function renderWorkspacesPage() {
    return createPage('workspaces', state.identity.authenticated
      ? createWorkspaceSettingsSection({ openDirectoryBrowser })
      : createManagedCard('Sign in required', 'Sign in to view workspace connection health and agent routing.'));
  }

  function renderAgentProfilesPage() {
    return createPage('agentProfiles', createAgentProfilesSection({ openDirectoryBrowser }));
  }

  function renderRemotePage() {
    return createPage('remote', state.identity.isAdmin
      ? createRemoteInstructSection()
      : createManagedCard('Managed by administrator', 'Remote Instruct is shared instance behavior. You can use its effective behavior, but only an administrator can change the prompt.'));
  }

  function renderModelsPage() {
    return createPage('models', state.identity.isAdmin
      ? createModelsSettingsSection({ onSaved: refreshConfig, notify: showToast })
      : createManagedCard('Managed by administrator', 'Launch model order is an instance setting. Ask an administrator to change the configured models.'));
  }

  function renderHostingPage() {
    const actions = document.createElement('div');
    actions.className = 'wm-settings-page__actions';
    actions.append(createDestinationLink('Open Apps', '/apps', 'app-hosting-open-apps'));
    if (state.identity.isAdmin) {
      actions.append(createDestinationLink('Allocate ports in Users & Access', '/settings/access', 'app-hosting-open-access'));
    }
    const routingCard = createSettingsCard(createHostedAppRoutingSection({
      config: state.config,
      currentOrigin: window.location.origin,
    }), {
      className: 'wm-settings-boundary-card',
      testId: 'app-hosting-instance-routing',
    });
    const portsCard = renderAssignedPortsSection();
    portsCard.classList.add('wm-settings-boundary-card');
    portsCard.dataset.testid = 'app-hosting-assigned-ports';
    portsCard.append(actions);

    const deployment = document.createElement('details');
    deployment.className = 'wm-settings-disclosure';
    const summary = document.createElement('summary');
    summary.textContent = 'Deployment and restart details';
    const note = document.createElement('p');
    note.textContent = 'Routing changes may require an external Autopilot restart. This page never restarts the managed process automatically.';
    deployment.append(summary, note);
    return createPage(
      'hosting',
      createSettingsGrid('hosting-boundary', routingCard, portsCard),
      deployment,
    );
  }

  function renderSystemPage() {
    const disclosure = document.createElement('details');
    disclosure.className = 'wm-settings-disclosure';
    disclosure.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Advanced instance settings and migration';
    disclosure.append(summary, createInstanceSettingsSection());
    return createPage('system', createTerminalSecuritySection({
      configured: state.config?.terminalConfigured === true,
      onSaved: refreshConfig,
      notify: showToast,
    }), disclosure);
  }

  function renderRestartPage() {
    return createPage('restart', createRestartSettingsSection({
      getRestartState: () => appsStore().system.restart,
      triggerRestart,
    }));
  }

  function renderAccessPage() {
    if (!state.adminUsers.initialized && !state.adminUsers.loading && !state.adminUsers.error) void fetchAdminUsers();
    return createPage('access', createSettingsGrid(
      'access',
      renderAdminUsersPanel(),
      renderAssignedPortsSection({ allocationActions: true }),
    ));
  }

  function renderAppearancePage() {
    return createPage('appearance', createInstanceBrandingSection({ config: state.config, onSaved: refreshBranding }));
  }

  function renderFlagsPage() {
    ensureFeatureFlagsLoaded();
    return createPage('flags', renderFeatureFlagsPanel());
  }

  function renderStarterPage() {
    ensureStarterProjectsLoaded();
    return createPage('starter', renderStarterProjectsPanel());
  }

  function renderSigningPoliciesPage() {
    return createPage('signingPolicies', createSigningPoliciesSection());
  }

  function renderDeniedPage() {
    return createPage('system', createManagedCard('Administrator access required', 'This settings destination is restricted. No administrator controls or secret values have been loaded.'));
  }

  function renderSettings() {
    const wrapper = document.createElement('div');
    wrapper.className = 'wm-settings';
    const resolved = resolveSettingsRoute(
      typeof window === 'undefined' ? '/settings' : window.location.pathname,
      { hash: typeof window === 'undefined' ? '' : window.location.hash, isAdmin: state.identity.isAdmin },
    );

    if (resolved.externalPath && typeof window !== 'undefined') {
      window.history.replaceState({ route: 'projects' }, '', resolved.externalPath);
      queueMicrotask(() => window.dispatchEvent(new Event('popstate')));
      return wrapper;
    }
    if (resolved.canonicalPath && typeof window !== 'undefined'
      && `${window.location.pathname}${window.location.hash}` !== resolved.canonicalPath) {
      window.history.replaceState({ route: 'settings', settingsPage: resolved.pageId }, '', resolved.canonicalPath);
    }

    const renderers = {
      profile: renderProfilePage,
      credentials: renderCredentialsPage,
      speech: renderSpeechPage,
      workspaces: renderWorkspacesPage,
      agentProfiles: renderAgentProfilesPage,
      remote: renderRemotePage,
      models: renderModelsPage,
      hosting: renderHostingPage,
      restart: renderRestartPage,
      system: renderSystemPage,
      access: renderAccessPage,
      billing: () => createPage('billing', createTeamBillingSection()),
      appearance: renderAppearancePage,
      flags: renderFlagsPage,
      starter: renderStarterPage,
      signingPolicies: renderSigningPoliciesPage,
    };
    const pageDefs = getSettingsNavigationItems(state.identity.isAdmin)
      .map((item) => ({ ...item, render: renderers[item.id] }));
    if (resolved.accessDenied) {
      pageDefs.push({ id: 'denied', group: '', label: 'Restricted', hidden: true, render: renderDeniedPage });
    }

    wrapper.append(createSettingsTabs({
      tabDefs: pageDefs,
      activeTabId: resolved.accessDenied ? 'denied' : resolved.pageId,
      onTabChange: (pageId) => {
        if (pageId === 'denied') return;
        const nextPath = getSettingsPathForTab(pageId);
        if (typeof window !== 'undefined' && window.location.pathname !== nextPath) {
          window.history.pushState({ route: 'settings', settingsPage: pageId }, '', nextPath);
        }
      },
    }));
    return wrapper;
  }

  return { renderSettings };
}
