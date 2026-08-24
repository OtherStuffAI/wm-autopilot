function createDetailList(rows) {
  const details = document.createElement('dl');
  details.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;font-size:0.9em;';
  rows.forEach(([termText, valueText]) => {
    const term = document.createElement('dt');
    term.textContent = termText;
    const value = document.createElement('dd');
    value.textContent = valueText;
    value.style.margin = '0';
    details.append(term, value);
  });
  return details;
}

function createActionButton(label, ariaLabel, testId, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.setAttribute('data-testid', testId);
  button.addEventListener('click', onClick);
  return button;
}

function formatCapability(capability) {
  if (capability === 'chat_intercept') {
    return 'Chat Dispatch';
  }
  if (capability === 'task_dispatch') {
    return 'Task Dispatch';
  }
  if (capability === 'comment_dispatch') {
    return 'Comment Dispatch';
  }
  if (capability === 'flow_dispatch') {
    return 'Flow Dispatch';
  }
  if (capability === 'task_review') {
    return 'Task Review';
  }
  if (capability === 'approval_dispatch') {
    return 'Approval Dispatch';
  }
  return capability;
}

function createCapabilityList(capabilities) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';

  const list = Array.isArray(capabilities) && capabilities.length > 0
    ? capabilities
    : ['chat_intercept'];

  list.forEach((capability) => {
    const badge = document.createElement('span');
    badge.textContent = formatCapability(capability);
    badge.style.cssText = 'display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:rgba(71,176,140,0.15);border:1px solid rgba(71,176,140,0.35);font-size:0.85em;';
    wrapper.append(badge);
  });

  return wrapper;
}

export function createAgentRegistryPanel(agents, handlers, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-testid', 'agent-chat-agent-list');

  const heading = document.createElement('h4');
  heading.textContent = options.heading || 'Registered Local Agents';
  wrapper.append(heading);

  if (!Array.isArray(agents) || agents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = options.emptyMessage || 'No local Agent Chat agents are registered yet.';
    wrapper.append(empty);
    return wrapper;
  }

  agents.forEach((agent) => {
    const card = document.createElement('article');
    card.className = 'wm-card';
    card.style.cssText = 'margin-top:12px;padding:14px;';
    card.setAttribute('data-testid', `agent-chat-agent-${agent.agentId}`);

    const title = document.createElement('h5');
    title.textContent = `${agent.label || agent.agentId} (${agent.agentId})`;
    card.append(title);

    const status = document.createElement('p');
    status.className = 'wm-settings__port-note';
    status.textContent = `enabled=${agent.enabled ? 'yes' : 'no'}, capabilities=${(agent.capabilities || []).length}`;
    card.append(status);

    card.append(createDetailList([
      ['Workspace Owner', agent.workspaceOwnerNpub || 'None'],
      ['Bot npub', agent.botNpub || 'None'],
      ['Working Directory', agent.workingDirectory || 'None'],
      ['Harness', agent.harness || agent.directChat?.sessionAgent || 'Default'],
      ['Model', agent.model || 'Harness default'],
      ['Archived', agent.archived ? 'Yes' : 'No'],
      ['Updated', agent.updatedAt || 'None'],
    ]));
    card.append(createCapabilityList(agent.capabilities));

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
    actions.append(createActionButton(
      'Copy npub',
      `Copy immutable agent npub for ${agent.agentId}`,
      `agent-chat-copy-npub-${agent.agentId}`,
      () => navigator.clipboard?.writeText(agent.botNpub || ''),
    ));
    if (typeof handlers.edit === 'function') {
      actions.append(createActionButton(
        'Edit',
        `Edit Agent Chat agent ${agent.agentId}`,
        `agent-chat-edit-agent-${agent.agentId}`,
        () => handlers.edit(agent),
      ));
    }
    if (typeof handlers.remove === 'function') {
      actions.append(createActionButton(
        'Remove',
        `Remove Agent Chat agent ${agent.agentId}`,
        `agent-chat-remove-agent-${agent.agentId}`,
        () => handlers.remove(agent),
      ));
    }
    if (actions.childElementCount > 0) {
      card.append(actions);
    }
    wrapper.append(card);
  });

  return wrapper;
}
