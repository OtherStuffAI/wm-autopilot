import {
  connectPackageExpiry,
  copyAutopilotConnectPackage,
  generateAutopilotConnectPackage,
  isConnectPackageExpired,
} from '../../services/autopilot-connect-package.js';
import { createButton } from './agent-chat-shared-ui.js';
import { element } from './workspace-settings-details.js';

function formatExpiry(expiresAt) {
  return new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function createAutopilotConnectPackageCard({ ownerNpub }) {
  const card = element('section', '', 'wm-card wm-workspace-detail');
  card.dataset.testid = 'autopilot-connect-package-card';
  const heading = element('h2', 'Connect this Autopilot to Flight Deck');
  const description = element('p', 'Generate one signed package for this Autopilot installation. Paste it into Flight Deck, which will verify the installation and discover the agents available to you.');
  const guidance = element('p', 'Packages are short-lived for five minutes and contain no keys, tokens, or reusable credentials.', 'wm-workspace-note');
  const output = document.createElement('textarea');
  output.readOnly = true;
  output.hidden = true;
  output.rows = 5;
  output.className = 'wm-input';
  output.setAttribute('aria-label', 'Generated Autopilot Connect Package');
  output.dataset.testid = 'autopilot-connect-package-output';
  const status = element('p', 'No package generated.', 'wm-workspace-note');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'autopilot-connect-package-status';
  const actions = element('div', '', 'wm-settings-page__actions');
  const generate = createButton('Generate package', 'autopilot-connect-package-generate', 'Generate a short-lived Autopilot Connect Package');
  const copy = createButton('Copy package', 'autopilot-connect-package-copy', 'Copy the Autopilot Connect Package');
  copy.disabled = true;
  let packageValue = null;
  let expiryTimer = null;

  function markExpired() {
    if (!packageValue || !isConnectPackageExpired(packageValue)) return;
    copy.disabled = true;
    status.textContent = 'Package expired. Generate a new package to continue.';
    status.className = 'wm-workspace-error';
  }

  generate.addEventListener('click', async () => {
    generate.disabled = true;
    copy.disabled = true;
    status.className = 'wm-workspace-note';
    status.textContent = 'Generating signed v2 package…';
    try {
      packageValue = await generateAutopilotConnectPackage(ownerNpub);
      output.value = JSON.stringify(packageValue);
      output.hidden = false;
      const expiresAt = connectPackageExpiry(packageValue);
      status.textContent = `Package ready. Expires at ${formatExpiry(expiresAt)}.`;
      copy.disabled = false;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(markExpired, Math.max(0, expiresAt - Date.now()));
    } catch (error) {
      packageValue = null;
      output.value = '';
      output.hidden = true;
      status.textContent = error instanceof Error ? error.message : 'Package generation failed.';
      status.className = 'wm-workspace-error';
    } finally {
      generate.disabled = false;
    }
  });

  copy.addEventListener('click', async () => {
    copy.disabled = true;
    try {
      await copyAutopilotConnectPackage(packageValue);
      status.className = 'wm-workspace-note';
      status.textContent = 'Package copied. Paste it into Flight Deck → Agents → Connect.';
    } catch (error) {
      status.className = 'wm-workspace-error';
      status.textContent = error instanceof Error ? error.message : 'Package copy failed.';
    } finally {
      copy.disabled = !packageValue || isConnectPackageExpired(packageValue);
    }
  });

  actions.append(generate, copy);
  card.append(heading, description, guidance, actions, output, status);
  card.stopConnectPackageExpiry = () => clearTimeout(expiryTimer);
  return card;
}
