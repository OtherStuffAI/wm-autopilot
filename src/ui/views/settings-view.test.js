import { describe, expect, test } from 'bun:test';

import {
  getSettingsPathForTab,
  getWorkspaceSettingsPath,
  resolveSettingsRoute,
} from './settings-routes.js';
import { getSettingsNavigationItems } from './settings-navigation.js';

describe('settings route helpers', () => {
  test('groups personal, automation and runtime pages while hiding administration from non-admins', () => {
    const memberItems = getSettingsNavigationItems(false);
    expect(memberItems.map((item) => item.group)).toContain('Personal');
    expect(memberItems.map((item) => item.group)).toContain('Agents & Automation');
    expect(memberItems.map((item) => item.group)).toContain('Runtime');
    expect(memberItems.map((item) => item.group)).not.toContain('Administration');
    expect(memberItems.map((item) => item.id)).not.toContain('system');
    expect(getSettingsNavigationItems(true).map((item) => item.id)).toContain('access');
    expect(getSettingsNavigationItems(true).map((item) => item.id)).toContain('agentProfiles');
    expect(getSettingsNavigationItems(true).map((item) => item.id)).toContain('signingPolicies');
    expect(getSettingsNavigationItems(false).map((item) => item.id)).not.toContain('agentProfiles');
    expect(getSettingsNavigationItems(false).map((item) => item.id)).not.toContain('signingPolicies');
  });

  test('resolves canonical grouped settings pages', () => {
    expect(resolveSettingsRoute('/settings').pageId).toBe('profile');
    expect(resolveSettingsRoute('/settings/credentials').pageId).toBe('credentials');
    expect(resolveSettingsRoute('/settings/automation/remote-instruct').pageId).toBe('remote');
    expect(resolveSettingsRoute('/settings/automation/agent-profiles', { isAdmin: true }).pageId).toBe('agentProfiles');
    expect(resolveSettingsRoute('/settings/models').pageId).toBe('models');
    expect(resolveSettingsRoute('/settings/app-hosting').pageId).toBe('hosting');
    expect(resolveSettingsRoute('/settings/restart', { isAdmin: true }).pageId).toBe('restart');
    expect(resolveSettingsRoute('/settings/signing-policies', { isAdmin: true }).pageId).toBe('signingPolicies');
  });

  test('redirects legacy routes and useful anchors', () => {
    expect(resolveSettingsRoute('/settings/workspace').canonicalPath).toBe('/settings/credentials');
    expect(resolveSettingsRoute('/settings/workspace', { hash: '#speech' }).canonicalPath).toBe('/settings/speech');
    expect(resolveSettingsRoute('/settings/workspace', { hash: '#hosted-app-routing' }).canonicalPath).toBe('/settings/app-hosting');
    expect(resolveSettingsRoute('/settings/flightdeck').canonicalPath).toBe('/settings/automation/workspaces');
    expect(resolveSettingsRoute('/settings/flight-deck/sub-1').canonicalPath).toBe('/settings/automation/workspaces/sub-1/overview');
    expect(resolveSettingsRoute('/settings/agents').canonicalPath).toBe('/settings/automation/workspaces');
    expect(resolveSettingsRoute('/settings/users', { isAdmin: true }).canonicalPath).toBe('/settings/access');
    expect(resolveSettingsRoute('/settings/admin', { hash: '#billing', isAdmin: true }).canonicalPath).toBe('/settings/billing');
    expect(resolveSettingsRoute('/settings/projects').externalPath).toBe('/projects');
  });

  test('restores the selected workspace and subview from a canonical deep link', () => {
    const resolved = resolveSettingsRoute('/settings/automation/workspaces/sub%20one/routing');
    expect(resolved).toMatchObject({
      pageId: 'workspaces',
      subscriptionId: 'sub one',
      subview: 'routing',
      canonicalPath: '/settings/automation/workspaces/sub%20one/routing',
    });
    expect(getWorkspaceSettingsPath('sub one', 'advanced')).toBe('/settings/automation/workspaces/sub%20one/advanced');
  });

  test('marks direct administration access denied without exposing it in navigation', () => {
    expect(resolveSettingsRoute('/settings/system', { isAdmin: false }).accessDenied).toBe(true);
    expect(resolveSettingsRoute('/settings/restart', { isAdmin: false }).accessDenied).toBe(true);
    expect(resolveSettingsRoute('/settings/system', { isAdmin: true }).accessDenied).toBe(false);
    expect(resolveSettingsRoute('/settings/automation/agent-profiles', { isAdmin: false }).accessDenied).toBe(true);
    expect(resolveSettingsRoute('/settings/signing-policies', { isAdmin: false }).accessDenied).toBe(true);
  });

  test('builds canonical page paths', () => {
    expect(getSettingsPathForTab('profile')).toBe('/settings/profile');
    expect(getSettingsPathForTab('workspaces')).toBe('/settings/automation/workspaces');
    expect(getSettingsPathForTab('agentProfiles')).toBe('/settings/automation/agent-profiles');
    expect(getSettingsPathForTab('access')).toBe('/settings/access');
    expect(getSettingsPathForTab('signingPolicies')).toBe('/settings/signing-policies');
  });
});
