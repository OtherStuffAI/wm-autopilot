import {
  createAgentChatProfile,
  deleteAgentChatProfile,
  listAgentChatAgents,
  rotateAgentChatProfileKey,
  setDefaultAgentChatProfile,
  updateAgentChatProfile,
  uploadAgentChatProfileMedia,
} from '../../services/agent-chat.js';
import { createPrimaryAgentNameModal } from './agent-chat-editor-cards.js';
import { createAgentProfileEditor } from './agent-profile-editor.js';
import { createButton, createStatusLine } from './agent-chat-shared-ui.js';
import { fetchConfigApi } from '../../services/config.js';

function createProfileFact(label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value || 'Not set';
  return [term, detail];
}

function createProfileCard(agent, canManage, isDefault, onEdit, onRotate, onSetDefault, onDelete) {
  const card = document.createElement('article');
  card.className = 'wm-card';
  card.dataset.testid = `agent-profile-${agent.agentId}`;
  const heading = document.createElement('h2');
  heading.textContent = agent.publicProfile?.name || agent.label || agent.agentId;
  if (isDefault) {
    const defaultStatus = document.createElement('p');
    defaultStatus.textContent = 'Default agent';
    defaultStatus.dataset.testid = `agent-profile-default-${agent.agentId}`;
    defaultStatus.setAttribute('aria-label', `${agent.label || agent.agentId} is the default Autopilot agent`);
    card.append(heading, defaultStatus);
  } else {
    card.append(heading);
  }
  const facts = document.createElement('dl');
  facts.className = 'wm-settings__detail-list';
  facts.append(
    ...createProfileFact('Active npub', agent.botNpub),
    ...createProfileFact('Working directory', agent.workingDirectory),
    ...createProfileFact('Harness', agent.harness || agent.directChat?.sessionAgent),
    ...createProfileFact('Model', agent.model || agent.directChat?.model),
    ...createProfileFact('Public about', agent.publicProfile?.about),
    ...createProfileFact('Public picture', agent.publicProfile?.picture),
    ...createProfileFact('NIP-05', agent.publicProfile?.nip05),
  );
  const editButton = createButton('Edit Agent Profile', `agent-profile-edit-${agent.agentId}`, `Edit ${agent.label || agent.agentId} agent profile`);
  editButton.addEventListener('click', () => onEdit(agent));
  card.append(facts, editButton);
  if (canManage) {
    if (!isDefault) {
      const defaultButton = createButton('Make default', `agent-profile-make-default-${agent.agentId}`, `Use ${agent.label || agent.agentId} for ordinary Autopilot sessions`);
      defaultButton.addEventListener('click', () => onSetDefault(agent, defaultButton));
      card.append(defaultButton);
    }
    const rotateButton = createButton('Rotate agent key', `agent-profile-rotate-${agent.agentId}`, `Rotate signing key for ${agent.label || agent.agentId}`);
    rotateButton.addEventListener('click', () => onRotate(agent, rotateButton));
    const deleteButton = createButton('Delete profile', `agent-profile-delete-${agent.agentId}`, `Delete ${agent.label || agent.agentId} agent profile and its locally managed signing key`);
    deleteButton.className = 'wm-button danger';
    deleteButton.addEventListener('click', () => onDelete(agent, deleteButton));
    card.append(rotateButton, deleteButton);
  }
  return card;
}

export function createAgentProfilesSection({ openDirectoryBrowser = null } = {}) {
  const section = document.createElement('section');
  section.dataset.testid = 'agent-profiles-settings-section';
  const actions = document.createElement('div');
  actions.className = 'wm-settings-page__actions';
  const addButton = createButton(
    'Add Agent Profile',
    'agent-profiles-add',
    'Open Create Agent Profile form',
  );
  const status = createStatusLine();
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'agent-profiles-status';
  const list = document.createElement('div');
  list.className = 'wm-settings-grid';
  list.dataset.testid = 'agent-profiles-list';

  const modal = createPrimaryAgentNameModal({
    standalone: true,
    onBrowseDirectory: openDirectoryBrowser,
    onCreate: async (defaults) => {
      const created = await createAgentChatProfile({
        profileId: defaults.agentId,
        label: defaults.label,
        name: defaults.label,
        workingDirectory: defaults.workingDirectory,
        harness: defaults.harness,
        model: defaults.model,
        picture: defaults.picture,
        about: defaults.about,
        nip05: defaults.nip05,
        mediaFile: defaults.mediaFile,
      });
      status.textContent = created.media?.savedLocally && created.media?.publishedToRelays
        ? `Created ${created.agent.label}. Image saved locally and profile published to relays. Immutable identity: ${created.agent.botNpub}`
        : `Created ${created.agent.label}. Immutable identity: ${created.agent.botNpub}`;
      await refresh();
    },
  });
  const editor = createAgentProfileEditor({
    onBrowseDirectory: openDirectoryBrowser,
    onSave: async (_agent, input) => {
      const { mediaFile, ...profileInput } = input;
      const result = mediaFile
        ? await uploadAgentChatProfileMedia(_agent.agentId, mediaFile, profileInput)
        : await updateAgentChatProfile(_agent.agentId, profileInput);
      status.textContent = result.media?.savedLocally && result.media?.publishedToRelays
        ? `Saved ${result.agent.label}'s image locally and published its profile without changing ${result.agent.botNpub}.`
        : result.published
        ? `Saved ${result.agent.label} and published its public profile. Its picture URL remains externally hosted.`
        : `Saved local runtime settings for ${result.agent.label}; public profile was unchanged.`;
      await refresh();
      return result;
    },
  });

  async function rotate(agent, button) {
    const confirmed = globalThis.confirm([
      'Rotate agent key?',
      `Agent: ${agent.label || agent.agentId} (${agent.agentId})`,
      `Current npub: ${agent.botNpub}`,
      '',
      'The old signing identity will be retired.',
      'Active sessions using it will stop working and need replacement.',
      'The private key is never displayed or exported.',
      '',
      'This security action cannot be undone.',
    ].join('\n'));
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = 'Rotating…';
    status.textContent = `Rotating ${agent.label || agent.agentId}…`;
    try {
      const result = await rotateAgentChatProfileKey(agent.agentId, agent.botNpub, crypto.randomUUID());
      if (result.state === 'completed') {
        const counts = Object.entries(result.tower?.migrationCounts || {}).map(([name, count]) => `${name}: ${count}`).join(', ');
        const tower = result.tower?.status === 'completed' || result.tower?.status === 'idempotent_replay'
          ? ` Tower ${result.tower.status}${counts ? ` (${counts})` : ''}.`
          : '';
        status.textContent = `Rotated ${agent.label || agent.agentId}. New npub: ${result.newNpub}.${tower} Replace sessions bound to the retired identity.`;
      } else if (result.state === 'tower_commit_uncertain') {
        status.textContent = `Tower response is uncertain. Retry Rotate agent key to reuse the same staged identity and rotation proof. ${(result.warnings || []).join(' ')}`.trim();
      } else {
        const actions = (result.externalActions || []).map((item) => item.action).join(' ');
        const warnings = (result.warnings || []).join(' ');
        status.textContent = `Rotation ${result.state.replaceAll('_', ' ')}. ${actions} ${warnings}`.trim();
      }
      await refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Agent key rotation failed.';
    } finally {
      button.disabled = false;
      button.textContent = 'Rotate agent key';
    }
  }

  async function setDefault(agent, button) {
    button.disabled = true;
    status.textContent = `Setting ${agent.label || agent.agentId} as the default agent…`;
    try {
      await setDefaultAgentChatProfile(agent.agentId);
      status.textContent = `${agent.label || agent.agentId} is now the default for ordinary Autopilot sessions.`;
      await refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Failed to set the default agent profile.';
    } finally {
      button.disabled = false;
    }
  }

  async function deleteProfile(agent, button) {
    const confirmed = globalThis.confirm([
      'Delete agent profile?',
      `Agent: ${agent.label || agent.agentId} (${agent.agentId})`,
      `Current npub: ${agent.botNpub}`,
      '',
      'A locally managed signing key will be permanently removed from the encrypted vault.',
      'If this npub comes from WINGMAN_PRIV in Docker environment configuration, remove it from that environment file separately and recreate the container.',
      'Workspace subscriptions must be deleted or rebound first.',
      'Active sessions using this profile will stop working.',
      '',
      'This security action cannot be undone.',
    ].join('\n'));
    if (!confirmed) return;
    button.disabled = true;
    status.textContent = `Deleting ${agent.label || agent.agentId}…`;
    try {
      const result = await deleteAgentChatProfile(agent.agentId);
      if (result.keyDisposition === 'env_configuration_retained') {
        status.textContent = `Deleted ${agent.label || agent.agentId} locally. Its ${agent.botNpub} key is still supplied by WINGMAN_PRIV; remove that value from the Docker environment and recreate the container before using the instance identity again.`;
      } else if (result.keyDisposition === 'instance_identity_retained') {
        status.textContent = `Deleted ${agent.label || agent.agentId}. The shared instance identity ${agent.botNpub} was retained because other Autopilot services may use it.`;
      } else {
        status.textContent = `Deleted ${agent.label || agent.agentId} and permanently removed its locally managed signing key. Add Agent Profile will generate a fresh key inside this Docker instance.`;
      }
      if (result.mediaReleased === false) {
        status.textContent += ' The profile was deleted, but its local image cleanup failed and needs operator attention.';
      }
      await refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Failed to delete agent profile.';
    } finally {
      button.disabled = false;
    }
  }

  void fetchConfigApi()
    .then((config) => {
      modal.setRuntimeConfig(config, config?.defaultAgent || '');
      editor.setRuntimeConfig(config);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'Harness and model options are unavailable.';
      modal.setRuntimeConfigUnavailable(message);
      editor.setRuntimeConfigUnavailable(message);
    });

  async function refresh() {
    try {
      const payload = await listAgentChatAgents();
      list.replaceChildren();
      if (payload.agents.length === 0) {
        const empty = document.createElement('p');
        empty.dataset.testid = 'agent-profiles-empty';
        empty.textContent = 'No agent profiles yet. Create one now; a workspace connection is not required.';
        list.append(empty);
      } else {
        list.append(...payload.agents.map((agent) => createProfileCard(
          agent,
          payload.permissions?.canManage === true,
          payload.defaults?.defaultAgentProfileId === agent.agentId,
          editor.open,
          rotate,
          setDefault,
          deleteProfile,
        )));
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Failed to load agent profiles.';
    }
  }

  addButton.addEventListener('click', () => modal.open());
  actions.append(addButton);
  section.append(actions, status, list, modal.element, editor.element);
  void refresh();
  return section;
}
