export const SETTING_GROUPS = {
  runtime: ['Server & app hosting', 'Addresses, relay connections, and how hosted apps are reached.'],
  agents: ['Agent execution', 'Server defaults, permitted folders, and installed agent tools. Individual bots have their own profiles.'],
  integrations: ['Optional services', 'Used when the corresponding model provider, Git service, or deployment service is enabled.'],
  pipelines: ['Pipeline automation', 'Used by declarative pipelines and HTTP triggers. These are not required for ordinary Agent Direct chat.'],
  identity: ['Identity & access', 'Instance identity and registration controls.'],
  internal: ['Advanced service configuration', 'Signing, Key Teleport, and WApp services. Configure only the services you use.'],
  bootstrap: ['Startup configuration · environment only', 'Read at startup from the deployment environment. These values cannot be edited here.'],
  branding: ['Appearance', 'Instance name and colours.'],
};

export function settingGroup(setting) {
  return setting.bootstrapOnly ? 'bootstrap' : setting.category || 'runtime';
}

export function settingValueState(setting) {
  if (setting.bootstrapOnly) return 'Set in deployment';
  if (setting.configured) return 'Saved in Autopilot';
  if (setting.maskedValue !== null && setting.maskedValue !== undefined && setting.maskedValue !== '') return 'From environment';
  if (setting.defaultValue !== null && setting.defaultValue !== undefined) return 'Using default';
  return 'No override';
}

export function createSettingsPurposeGuide() {
  const card = document.createElement('section');
  card.className = 'wm-card wm-settings-purpose';
  const title = document.createElement('h2');
  title.textContent = 'Which settings do I need?';
  const note = document.createElement('p');
  note.textContent = 'For normal bot conversations, start with Bots and Workspaces. Server configuration below controls this Autopilot installation; optional services only apply when you use them.';
  const links = document.createElement('div');
  links.className = 'wm-settings-purpose__links';
  for (const [label, detail, href] of [
    ['Bots', 'Name, picture, working folder, agent tool and model', '/settings/automation/agent-profiles'],
    ['Workspaces', 'Servers, workspace connections and participating bots', '/settings/automation/workspaces'],
    ['API keys & accounts', 'Your provider and developer credentials', '/settings/credentials'],
    ['Users & access', 'Approved people and access permissions', '/settings/access'],
  ]) {
    const link = document.createElement('a');
    link.href = href;
    link.setAttribute('aria-label', `Open ${label}`);
    const heading = document.createElement('strong');
    heading.textContent = label;
    const copy = document.createElement('span');
    copy.textContent = detail;
    link.append(heading, copy);
    links.append(link);
  }
  card.append(title, note, links);
  return card;
}
