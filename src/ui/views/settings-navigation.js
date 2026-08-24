export const SETTINGS_NAVIGATION = Object.freeze([
  { id: 'profile', group: 'Personal', label: 'Profile' },
  { id: 'credentials', group: 'Personal', label: 'Credentials' },
  { id: 'speech', group: 'Personal', label: 'Speech' },
  { id: 'workspaces', group: 'Agents & Automation', label: 'Workspaces' },
  { id: 'agentProfiles', group: 'Agents & Automation', label: 'Agent Profiles', adminOnly: true },
  { id: 'remote', group: 'Agents & Automation', label: 'Remote Instruct' },
  { id: 'models', group: 'Runtime', label: 'Models' },
  { id: 'hosting', group: 'Runtime', label: 'App Hosting' },
  { id: 'restart', group: 'Runtime', label: 'Restart', adminOnly: true },
  { id: 'system', group: 'Runtime', label: 'System', adminOnly: true },
  { id: 'access', group: 'Administration', label: 'Users & Access', adminOnly: true },
  { id: 'billing', group: 'Administration', label: 'Billing', adminOnly: true },
  { id: 'appearance', group: 'Administration', label: 'Appearance', adminOnly: true },
  { id: 'flags', group: 'Administration', label: 'Feature Flags', adminOnly: true },
  { id: 'starter', group: 'Administration', label: 'Starter Projects', adminOnly: true },
]);

export function getSettingsNavigationItems(isAdmin) {
  return SETTINGS_NAVIGATION.filter((item) => isAdmin || !item.adminOnly);
}
