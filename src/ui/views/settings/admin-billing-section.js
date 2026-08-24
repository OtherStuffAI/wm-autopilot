import {
  fetchTeamBillingApi,
  updateTeamBillingApi,
  fetchBillingUsageApi,
} from '../../services/billing.js';

const formatUsd = (value) => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `$${numeric.toFixed(2)}`;
};

const formatUsageUsd = (value) => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (numeric <= 0) return '$0.00';
  if (numeric < 0.01) return `$${numeric.toFixed(6)}`;
  if (numeric < 1) return `$${numeric.toFixed(4)}`;
  return `$${numeric.toFixed(2)}`;
};

const formatIso = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export function createTeamBillingSection({ onUpdated } = {}) {
  const card = document.createElement('section');
  card.className = 'wm-card';

  const heading = document.createElement('h2');
  heading.textContent = 'Team Credits Billing';

  const description = document.createElement('p');
  description.textContent = 'Enable team-level OpenRouter billing with pooled limits and a Wingman markup.';
  const envHint = document.createElement('p');
  envHint.className = 'wm-settings__port-note';
  envHint.textContent = 'Requires an OpenRouter management key in OPENROUTER_PROVISIONING_KEY or OPENROUTER_MANAGEMENT_KEY.';

  const status = document.createElement('p');
  status.className = 'wm-settings__port-note';
  status.textContent = 'Loading billing settings…';

  const toggleRow = document.createElement('label');
  toggleRow.className = 'wm-settings__key-row';
  const toggleText = document.createElement('span');
  toggleText.textContent = 'Use Credits billing';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleRow.append(toggleText, toggleInput);

  const baseRow = document.createElement('label');
  baseRow.className = 'wm-settings__key-row';
  const baseLabel = document.createElement('span');
  baseLabel.textContent = 'Base team allocation (USD)';
  const baseInput = document.createElement('input');
  baseInput.type = 'number';
  baseInput.min = '0';
  baseInput.step = '1';
  baseRow.append(baseLabel, baseInput);

  const memberRow = document.createElement('label');
  memberRow.className = 'wm-settings__key-row';
  const memberLabel = document.createElement('span');
  memberLabel.textContent = 'Per-member allocation (USD)';
  const memberInput = document.createElement('input');
  memberInput.type = 'number';
  memberInput.min = '0';
  memberInput.step = '1';
  memberRow.append(memberLabel, memberInput);

  const markupRow = document.createElement('label');
  markupRow.className = 'wm-settings__key-row';
  const markupLabel = document.createElement('span');
  markupLabel.textContent = 'Markup (%)';
  const markupInput = document.createElement('input');
  markupInput.type = 'number';
  markupInput.min = '0';
  markupInput.step = '0.01';
  markupRow.append(markupLabel, markupInput);

  const controls = document.createElement('div');
  controls.className = 'wm-settings__ports-admin-actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'wm-button';
  saveButton.textContent = 'Save Billing Settings';
  controls.append(saveButton);

  const summary = document.createElement('div');
  summary.className = 'wm-settings__port-note';
  const usage = document.createElement('div');
  usage.className = 'wm-settings__port-note';

  let current = null;

  const setBusy = (busy) => {
    toggleInput.disabled = busy;
    baseInput.disabled = busy;
    memberInput.disabled = busy;
    markupInput.disabled = busy;
    saveButton.disabled = busy;
    saveButton.textContent = busy ? 'Saving…' : 'Save Billing Settings';
  };

  const syncFields = (payload) => {
    const config = payload?.config ?? {};
    const summaryData = payload?.summary ?? {};
    current = payload;
    toggleInput.checked = Boolean(config.useCredits);
    baseInput.value = String(Math.max(0, Math.round((config.baseAllocationUsdCents ?? 0) / 100)));
    memberInput.value = String(Math.max(0, Math.round((config.perMemberUsdCents ?? 0) / 100)));
    markupInput.value = String(Number(summaryData.markupPercent ?? 21).toFixed(2));
    status.textContent = `Team ${config.teamUuid ?? '-'} • ${summaryData.memberCount ?? 0} members • budget ${formatUsd(summaryData.budgetUsd ?? 0)}`;
    summary.innerHTML = `
      <strong>Provider key:</strong> ${payload?.hasProviderKey ? 'present' : 'missing'}<br>
      <strong>Provider key hash:</strong> ${payload?.providerKeyHash ?? '-'}<br>
      <strong>Provider key updated:</strong> ${formatIso(payload?.providerKeyUpdatedAt)}
    `;
  };

  const loadUsage = async () => {
    try {
      const payload = await fetchBillingUsageApi(8);
      const items = Array.isArray(payload?.usage) ? payload.usage : [];
      if (items.length === 0) {
        usage.innerHTML = '<strong>Recent usage:</strong> no records yet.';
        return;
      }
      const rows = items.slice(0, 8).map((item) => {
        const endpoint = typeof item.endpoint === 'string' ? item.endpoint : '-';
        const wingmanCostUsd = typeof item.wingmanCostUsd === 'number' ? item.wingmanCostUsd : 0;
        const createdAt = formatIso(item.createdAt);
        return `${createdAt} • ${endpoint} • ${formatUsageUsd(wingmanCostUsd)}`;
      });
      usage.innerHTML = `<strong>Recent usage:</strong><br>${rows.map((line) => line.replace(/</g, '&lt;')).join('<br>')}`;
    } catch (error) {
      usage.textContent = `Recent usage unavailable: ${(error && error.message) || 'Unknown error'}`;
    }
  };

  const load = async () => {
    try {
      const payload = await fetchTeamBillingApi();
      syncFields(payload);
      await loadUsage();
    } catch (error) {
      status.textContent = `Failed to load billing settings: ${(error && error.message) || 'Unknown error'}`;
    }
  };

  saveButton.addEventListener('click', async () => {
    if (!current) return;
    const nextBaseUsd = Math.max(0, Number.parseFloat(baseInput.value || '0'));
    const nextPerMemberUsd = Math.max(0, Number.parseFloat(memberInput.value || '0'));
    const nextMarkupPercent = Math.max(0, Number.parseFloat(markupInput.value || '0'));
    const nextPayload = {
      useCredits: toggleInput.checked,
      baseAllocationUsdCents: Math.round(nextBaseUsd * 100),
      perMemberUsdCents: Math.round(nextPerMemberUsd * 100),
      markupBps: Math.round(nextMarkupPercent * 100),
    };
    setBusy(true);
    try {
      const updated = await updateTeamBillingApi(nextPayload);
      syncFields(updated);
      await loadUsage();
      status.textContent = `Billing settings saved • budget ${formatUsd(updated?.summary?.budgetUsd ?? 0)}`;
      if (typeof onUpdated === 'function') {
        onUpdated(updated);
      }
    } catch (error) {
      status.textContent = `Failed to save billing settings: ${(error && error.message) || 'Unknown error'}`;
    } finally {
      setBusy(false);
    }
  });

  card.append(
    heading,
    description,
    envHint,
    status,
    toggleRow,
    baseRow,
    memberRow,
    markupRow,
    controls,
    summary,
    usage,
  );

  void load();
  return card;
}
