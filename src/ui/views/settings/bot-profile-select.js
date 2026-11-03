// Bot profile chooser for new workspace connections: each new bot connects with its own strict inbox, so a
// connection names the exact profile that serves it. "No new bot" only reconnects an existing shared connection.
export const NO_NEW_BOT_LABEL = 'No new bot (reconnect an existing connection)';

export function enabledBotProfiles(agents) {
  return (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.agentId && agent.enabled !== false && !agent.archived)
    .map((agent) => ({ agentId: agent.agentId, label: agent.label || agent.agentId }));
}

export function createBotProfileSelect({ testId, onChange } = {}) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
  row.textContent = 'Bot profile';
  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', 'Bot profile that serves this workspace');
  if (testId) select.dataset.testid = testId;
  select.addEventListener('change', () => onChange?.(select.value || null));
  row.append(select);
  function setProfiles(profiles, selected = null) {
    const options = [new Option(NO_NEW_BOT_LABEL, ''), ...profiles.map((profile) => new Option(profile.label, profile.agentId))];
    select.replaceChildren(...options);
    select.value = profiles.some((profile) => profile.agentId === selected) ? selected : '';
  }
  return { row, select, setProfiles, value: () => select.value || null };
}
