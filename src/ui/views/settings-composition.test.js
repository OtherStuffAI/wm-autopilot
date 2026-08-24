import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const settingsView = readFileSync(new URL('./settings-view.js', import.meta.url), 'utf8');
const identityPanels = readFileSync(new URL('../identity/panels.js', import.meta.url), 'utf8');
const adminUsersPanels = readFileSync(new URL('../api/admin-users-panels.js', import.meta.url), 'utf8');
const profileSections = readFileSync(new URL('./settings/profile-sections.js', import.meta.url), 'utf8');
const restartSection = readFileSync(new URL('./settings/restart-settings-section.js', import.meta.url), 'utf8');

describe('Settings page composition', () => {
  test('composes Profile into upper and lower grids with bounded identity regions', () => {
    expect(settingsView).toContain("summaryAside: createDefaultAgentSection({ state })");
    expect(identityPanels).toContain('settings-grid-profile-upper');
    expect(identityPanels).toContain('settings-profile-identity-summary');
    expect(identityPanels).toContain('settings-profile-workspace-delegations');
    expect(identityPanels).toContain('settings-grid-profile-lower');
    expect(identityPanels).toContain('settings-profile-sign-in-methods');
    expect(identityPanels).toContain('settings-profile-advanced-options');
    expect(profileSections).toContain('settings-profile-default-agent');
    expect(identityPanels).toContain('registerIdentityDom(card)');
    expect(identityPanels).toContain('bindIdentityFlows(card)');
  });

  test('composes Credentials as a three-region responsive card grid', () => {
    expect(settingsView).toContain("createSettingsGrid('credentials', ...content)");
    expect(settingsView).toContain("testId: 'settings-credentials-api-keys'");
    expect(settingsView).toContain("testId: 'settings-credentials-github'");
    expect(settingsView).toContain("testId: 'settings-credentials-gitea'");
    expect(settingsView).toContain('createApiKeysSection()');
    expect(settingsView).toContain('createGitHubSection()');
    expect(settingsView).toContain('createGiteaSection(config.giteaUrl)');
  });

  test('composes App Hosting as an instance-versus-ports boundary', () => {
    expect(settingsView).toContain("createSettingsGrid('hosting-boundary', routingCard, portsCard)");
    expect(settingsView).toContain("testId: 'app-hosting-instance-routing'");
    expect(settingsView).toContain("portsCard.dataset.testid = 'app-hosting-assigned-ports'");
    expect(settingsView).toContain("createDestinationLink('Open Apps', '/apps'");
    expect(settingsView).toContain("summary.textContent = 'Deployment and restart details'");
  });

  test('composes Restart as a first-class runtime settings page', () => {
    expect(settingsView).toContain("restart: ['Restart'");
    expect(settingsView).toContain("return createPage('restart', createRestartSettingsSection({");
    expect(restartSection).toContain("heading.textContent = 'Restart Autopilot'");
  });

  test('composes user management before port-allocation tools in Access', () => {
    expect(settingsView).toContain("createSettingsGrid(\n      'access'");
    expect(settingsView).toContain('renderAdminUsersPanel()');
    expect(settingsView).toContain('renderAssignedPortsSection({ allocationActions: true })');
    expect(adminUsersPanels.indexOf('const userManagementCard = buildAdminUserManagementCard();'))
      .toBeLessThan(adminUsersPanels.indexOf('const portsCard = buildAdminPortsCard();'));
  });
});
