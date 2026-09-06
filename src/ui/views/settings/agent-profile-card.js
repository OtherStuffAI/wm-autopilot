import { createButton } from './agent-chat-shared-ui.js';

function createProfileFact(label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value || 'Not set';
  return [term, detail];
}

export function createProfileCard(agent, canManage, isDefault, onEdit, onRotate, onSetDefault, onDelete) {
  const card = document.createElement('article');
  card.className = 'wm-card wm-agent-profile';
  const header = document.createElement('header');
  header.className = 'wm-agent-profile__header';
  const avatar = document.createElement('span');
  avatar.className = 'wm-agent-profile__avatar';
  avatar.textContent = (agent.publicProfile?.name || agent.label || '?').slice(0, 1).toUpperCase();
  const picture = agent.publicProfile?.picture;
  if (picture && /^(https?:\/\/|\/[^/])/i.test(picture)) {
    const image = document.createElement('img');
    image.src = picture;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => { image.hidden = true; });
    avatar.append(image);
  }
  const title = document.createElement('div');
  header.append(avatar, title);
  card.append(header);
  card.dataset.testid = `agent-profile-${agent.agentId}`;
  const heading = document.createElement('h2');
  heading.textContent = agent.publicProfile?.name || agent.label || agent.agentId;
  if (isDefault) {
    const defaultStatus = document.createElement('p');
    defaultStatus.textContent = 'Default agent';
    defaultStatus.dataset.testid = `agent-profile-default-${agent.agentId}`;
    defaultStatus.setAttribute('aria-label', `${agent.label || agent.agentId} is the default Autopilot agent`);
    defaultStatus.className = "wm-agent-profile__badge";
    title.append(heading, defaultStatus);
  } else {
    title.append(heading);
  }
  if (agent.publicProfile?.about) {
    const about = document.createElement('p');
    about.className = 'wm-agent-profile__about';
    about.textContent = agent.publicProfile.about;
    card.append(about);
  }
  const facts = document.createElement('dl');
  facts.className = 'wm-agent-profile__facts';
  facts.append(
    ...createProfileFact('Working folder', agent.workingDirectory),
    ...createProfileFact('Agent tool', agent.harness || agent.directChat?.sessionAgent || 'Not configured'),
    ...createProfileFact('Model', agent.model || agent.directChat?.model || 'Tool default'),
    ...createProfileFact('Status', agent.enabled === false ? 'Disabled' : 'Enabled'),
  );
  const actions = document.createElement('div');
  actions.className = 'wm-agent-profile__actions';
  const identity = document.createElement('details');
  identity.className = 'wm-agent-profile__identity';
  const summary = document.createElement('summary');
  summary.textContent = 'Identity & advanced';
  summary.setAttribute('aria-label', `Identity and advanced settings for ${agent.label || agent.agentId}`);
  summary.dataset.testid = `agent-profile-details-${agent.agentId}`;
  const identityFacts = document.createElement('dl');
  identityFacts.className = 'wm-agent-profile__facts';
  identityFacts.append(...createProfileFact('Public key', agent.botNpub));
  if (agent.publicProfile?.nip05) identityFacts.append(...createProfileFact('Nostr address', agent.publicProfile.nip05));
  identity.append(summary, identityFacts);
  const editButton = createButton('Edit bot', `agent-profile-edit-${agent.agentId}`, `Edit ${agent.label || agent.agentId} agent profile`);
  editButton.addEventListener('click', () => onEdit(agent));
  actions.append(editButton);
  card.append(facts, actions, identity);
  if (canManage) {
    if (!isDefault) {
      const defaultButton = createButton('Make default', `agent-profile-make-default-${agent.agentId}`, `Use ${agent.label || agent.agentId} for ordinary Autopilot sessions`);
      defaultButton.addEventListener('click', () => onSetDefault(agent, defaultButton));
      actions.append(defaultButton);
    }
    const rotateButton = createButton('Rotate agent key', `agent-profile-rotate-${agent.agentId}`, `Rotate signing key for ${agent.label || agent.agentId}`);
    rotateButton.addEventListener('click', () => onRotate(agent, rotateButton));
    const deleteButton = createButton('Delete profile', `agent-profile-delete-${agent.agentId}`, `Delete ${agent.label || agent.agentId} agent profile and its locally managed signing key`);
    deleteButton.className = 'wm-button danger';
    deleteButton.addEventListener('click', () => onDelete(agent, deleteButton));
    const advancedActions = document.createElement('div');
    advancedActions.className = 'wm-agent-profile__actions';
    advancedActions.append(rotateButton, deleteButton);
    identity.append(advancedActions);
  }
  return card;
}
