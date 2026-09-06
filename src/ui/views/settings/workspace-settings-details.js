import { createButton } from './agent-chat-shared-ui.js';

export function element(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function disclosure(title, id) {
  const panel = element('details', '', 'wm-workspace-disclosure');
  const summary = element('summary', title);
  summary.setAttribute('aria-label', title);
  summary.dataset.testid = id;
  panel.append(summary);
  return panel;
}

function timestamp(value) {
  if (!value) return 'No activity recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Activity time unavailable' : date.toLocaleString();
}

export function createWorkspaceDetails(workspace, { canManage, busy, onAction, onRemove }) {
  const card = element('section', '', 'wm-card wm-workspace-detail');
  card.dataset.testid = `workspace-detail-${workspace.subscriptions[0].subscriptionId}`;
  const header = element('header');
  header.append(element('h2', workspace.name));
  const health = [...new Set(workspace.subscriptions.map((item) => item.health))].join(' · ');
  header.append(element('span', health, 'wm-workspace-health'));
  card.append(header, element('p', 'Agent Direct routes messages to eligible bots in the conversation. A bot can participate in several workspaces.', 'wm-workspace-note'));
  const sources = [...new Set(workspace.subscriptions.map((item) => item.source))];
  card.append(element('p', sources.join(' · '), 'wm-workspace-note'));
  const errors = [...new Set(workspace.subscriptions.map((item) => item.error).filter(Boolean))];
  for (const error of errors) card.append(element('p', error, 'wm-workspace-error'));
  card.append(element('h3', 'Bots'));
  if (!workspace.bots.length) {
    card.append(element('p', 'No bot connections recorded yet. Add a local bot to this workspace in Flight Deck, then allow Nostr discovery or paste its AgentConnect package.', 'wm-workspace-note'));
  } else {
    const bots = element('ul', '', 'wm-workspace-bots');
    for (const bot of workspace.bots) {
      const row = element('li');
      const name = element('a', bot.label || bot.agentId);
      name.href = '/settings/automation/agent-profiles';
      name.setAttribute('aria-label', `Manage bot ${bot.label || bot.agentId}`);
      name.dataset.testid = `workspace-bot-${bot.agentId}`;
      row.append(name, element('span', bot.status, 'wm-workspace-note'));
      bots.append(row);
    }
    card.append(bots, element('p', 'Recorded connections are shown here. Tower checks each bot’s access to the conversation when an event arrives.', 'wm-workspace-note'));
  }
  const recent = disclosure('Recent activity', 'workspace-activity');
  if (!workspace.activity.length) recent.append(element('p', 'No dispatch activity recorded yet.', 'wm-workspace-note'));
  for (const entry of workspace.activity) {
    const bot = workspace.bots.find((item) => item.agentId === entry.agentId);
    const row = element('div', '', 'wm-workspace-activity');
    row.append(element('strong', `${bot?.label || entry.agentId || 'Bot'} · ${entry.status || entry.action || 'Event'}`),
      element('p', entry.reason || String(entry.action || '').replaceAll('_', ' ')), element('small', timestamp(entry.at)));
    recent.append(row);
  }
  card.append(recent);
  const diagnostics = disclosure('Connection & diagnostics', 'workspace-diagnostics');
  for (const subscription of workspace.subscriptions) {
    const section = element('section', '', 'wm-workspace-connection');
    section.append(element('h4', subscription.source), element('p', subscription.health),
      element('p', `Last event check: ${timestamp(subscription.lastActivity)}`, 'wm-workspace-note'));
    if (subscription.profileBound) section.append(element('p', 'This older connection is restricted to one bot profile. Other bot connections are listed alongside it.', 'wm-workspace-note'));
    const ids = element('dl');
    ids.append(element('dt', 'Workspace ID'), element('dd', subscription.workspaceId || 'Missing workspace ID'),
      element('dt', 'Connection ID'), element('dd', subscription.subscriptionId));
    section.append(ids);
    const controls = element('div', '', 'wm-settings-page__actions');
    const disabled = subscription.health === 'Disabled';
    const revoked = subscription.health === 'Revoked';
    for (const [label, action] of [['Reconnect', 'reconnect'], [disabled ? 'Enable' : 'Pause', disabled ? 'enable' : 'disable']]) {
      const button = createButton(label, `workspace-${action}-${subscription.subscriptionId}`, `${label} ${workspace.name} connection`);
      button.disabled = !canManage || busy || revoked || (action === 'reconnect' && disabled);
      button.addEventListener('click', () => onAction(subscription, action));
      controls.append(button);
    }
    const remove = createButton('Disconnect', `workspace-remove-${subscription.subscriptionId}`, `Disconnect ${workspace.name} locally`);
    remove.className = 'wm-button danger';
    remove.disabled = !canManage || busy;
    remove.addEventListener('click', () => onRemove(subscription));
    controls.append(remove);
    section.append(controls);
    diagnostics.append(section);
  }
  card.append(diagnostics);
  return card;
}
