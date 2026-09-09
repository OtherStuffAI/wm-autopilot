import { element } from './workspace-settings-details.js';
import { createButton } from './agent-chat-shared-ui.js';

// The record is materialized from the workspace settings Dexie liveQuery.
export function createTowerTransportCard(connection, { canManage, onAction }) {
  const card = element('section', '', 'wm-card wm-workspace-detail');
  card.setAttribute('aria-label', 'Tower transport');
  card.dataset.testid = 'tower-transport-settings';
  card.append(element('h3', 'Tower transport'));
  const config = connection.transport || { mode: 'https', httpsEndpoint: connection.backendBaseUrl };
  const diagnostics = connection.transportDiagnostics || {};
  const fields = {};
  for (const [key, title, value] of [
    ['mode', 'Selected transport', config.mode],
    ['httpsEndpoint', 'HTTPS endpoint (optional for FIPS)', config.httpsEndpoint],
    ['fipsEndpoint', 'Approved FIPS endpoint', config.fipsEndpoint],
    ['expectedServiceNpub', 'Expected Tower service npub', config.expectedServiceNpub || connection.serviceNpub],
  ]) {
    const label = element('label', title);
    const input = element(key === 'mode' ? 'select' : 'input');
    if (key === 'mode') for (const [value, title] of [['https', 'HTTPS'], ['fips', 'FIPS']]) {
      const option = element('option', title); option.value = value; input.append(option);
    }
    input.value = value || '';
    input.setAttribute('aria-label', title);
    input.dataset.testid = `tower-transport-${key}`;
    input.disabled = !canManage;
    label.append(input); card.append(label); fields[key] = input;
  }
  const status = element('p', `Selected: ${config.mode}. Effective: ${diagnostics.effectiveTransport || 'unavailable'}. ${diagnostics.reconnectState || 'idle'}.`);
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'tower-transport-status';
  card.append(status,
    element('p', `Verified service: ${diagnostics.verifiedServiceNpub || 'not verified'}`),
    element('p', `Last request: ${diagnostics.lastSuccessfulRequestAt || 'none'}. Last event: ${diagnostics.lastSuccessfulEventAt || 'none'}.`));
  for (const mode of ['https', 'fips']) {
    const counter = diagnostics.counters?.[mode];
    card.append(element('p', `${mode.toUpperCase()}: ${counter?.requests || 0} requests, ${counter?.errors || 0} errors`));
  }
  if (diagnostics.lastError) card.append(element('p', diagnostics.lastError, 'wm-workspace-error'));
  const apply = createButton('Apply transport', 'tower-transport-apply', 'Apply Tower transport');
  const test = createButton('Test connection', 'tower-transport-test', 'Test saved Tower connection');
  apply.disabled = test.disabled = !canManage;
  apply.addEventListener('click', () => void onAction(connection.backendConnectionId, 'save',
    Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value || null]))));
  test.addEventListener('click', () => void onAction(connection.backendConnectionId, 'test'));
  card.append(apply, test, element('p', 'FIPS uses the approved mesh endpoint. Mesh failure leaves the connection disconnected. Apply before testing.'));
  return card;
}
