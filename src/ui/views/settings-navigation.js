export const SETTINGS_NAVIGATION = Object.freeze([
  { id: 'profile', group: 'Your account', label: 'Profile' },
  { id: 'credentials', group: 'Your account', label: 'API keys & accounts' },
  { id: 'speech', group: 'Your account', label: 'Speech' },
  { id: 'workspaces', group: 'Bots & connections', label: 'Workspaces' },
  { id: 'agentProfiles', group: 'Bots & connections', label: 'Bots', adminOnly: true },
  { id: 'remote', group: 'Advanced', label: 'Remote instruction prompt' },
  { id: 'models', group: 'Server', label: 'Model choices' },
  { id: 'hosting', group: 'Server', label: 'App Hosting' },
  { id: 'restart', group: 'Server', label: 'Restart', adminOnly: true },
  { id: 'system', group: 'Server', label: 'Server configuration', adminOnly: true },
  { id: 'access', group: 'Server', label: 'Users & Access', adminOnly: true },
  { id: 'signingPolicies', group: 'Advanced', label: 'Signing Policies', adminOnly: true },
  { id: 'billing', group: 'Server', label: 'Billing', adminOnly: true },
  { id: 'appearance', group: 'Server', label: 'Appearance', adminOnly: true },
  { id: 'flags', group: 'Advanced', label: 'Experimental features', adminOnly: true },
  { id: 'starter', group: 'Advanced', label: 'Starter Projects', adminOnly: true },
]);

export function getSettingsNavigationItems(isAdmin) {
  const order = ['Your account', 'Bots & connections', 'Server', 'Advanced'];
  return SETTINGS_NAVIGATION.filter((item) => isAdmin || !item.adminOnly)
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}
